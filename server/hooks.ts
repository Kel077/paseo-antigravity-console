import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  ACCOUNT_METADATA_KEY,
  SYSTEM_ACCOUNT_ID,
  accountIdFromMetadata,
  isAntigravityProvider,
  type FallbackEvent,
} from "../shared/contracts";
import type { AccountService } from "./accounts";
import { sessionEnv } from "./agy";
import { ensureProfile } from "./profile";

/** Agents that switch account once their running turn ends: agent id → target account id. */
export class PendingSwitches {
  private readonly pending = new Map<string, string>();

  set(agentId: string, accountId: string): void {
    this.pending.set(agentId, accountId);
  }

  take(agentId: string): string | undefined {
    const value = this.pending.get(agentId);
    this.pending.delete(agentId);
    return value;
  }

  delete(agentId: string): void {
    this.pending.delete(agentId);
  }
}

export interface SwitchInput {
  agentId: string;
  accountId: string;
  when: "now" | "after-turn";
}

export interface SwitchOutcome {
  result: "switched" | "scheduled" | "unchanged";
  accountLabel: string;
}

/** Moves an agent to another account. The conversation stays because the store is shared. */
export async function switchAgentAccount(
  paseo: PaseoApi,
  service: AccountService,
  pending: PendingSwitches,
  input: SwitchInput,
): Promise<SwitchOutcome> {
  const target = service.requireAccount(input.accountId);
  if (target?.unsafeDetail) throw new Error(target.unsafeDetail);
  const accountLabel = service.labelOf(input.accountId);
  if (target) {
    // Moving an agent onto an account that cannot run would strand it there.
    const status = await service.quotaFor(input.accountId, 5 * 60_000);
    if (status.status === "signed-out") {
      throw new Error(`Sign in to "${accountLabel}" in Antigravity accounts before moving an agent to it.`);
    }
  }
  const handle = paseo.agents.ref(input.agentId);
  const refreshed = await handle.refresh();
  if (!refreshed) throw new Error("That agent no longer exists.");
  const agent = refreshed.agent;
  if (!isAntigravityProvider(agent.provider)) {
    throw new Error("Only Antigravity agents can switch Google accounts.");
  }
  if (agent.archivedAt) throw new Error("That agent is archived.");
  const current = accountIdFromMetadata(agent.metadata);
  if (current === input.accountId) {
    pending.delete(input.agentId);
    return { result: "unchanged", accountLabel };
  }
  // An explicit "default" keeps the system choice even when another account is the default.
  await handle.setMetadata({ [ACCOUNT_METADATA_KEY]: input.accountId });
  const running = agent.status === "running" || agent.status === "initializing";
  if (input.when === "after-turn" && running) {
    pending.set(input.agentId, input.accountId);
    return { result: "scheduled", accountLabel };
  }
  pending.delete(input.agentId);
  try {
    await handle.reload();
  } catch (error) {
    // Put the agent back where it worked, then report why the new account failed.
    const reason = error instanceof Error ? error.message : String(error);
    await handle.setMetadata({ [ACCOUNT_METADATA_KEY]: current }).catch(() => undefined);
    const restored = await handle.reload().then(
      () => true,
      () => false,
    );
    throw new Error(
      `"${accountLabel}" could not open this agent: ${reason}` +
        (restored ? ` The agent stays on "${service.labelOf(current)}".` : ""),
    );
  }
  return { result: "switched", accountLabel };
}

/** The fallback controller's part of the session-open path; kept as an interface to avoid an import cycle. */
export interface OpenFallback {
  healthOf(accountId: string): Promise<FallbackEvent["reason"] | null>;
  redirectForOpen(paseo: PaseoApi, agentId: string, accountId: string, reason: FallbackEvent["reason"], record: boolean): Promise<string | null>;
}

export function registerHooks(
  server: PluginServerContext,
  service: AccountService,
  pending: PendingSwitches,
  fallback?: OpenFallback,
): Array<() => void> {
  const removers: Array<() => void> = [];

  // New Antigravity agents get the default account unless the composer chose one.
  removers.push(
    server.addHook("agent.create.before", async ({ request }) => {
      if (!isAntigravityProvider(request.config.provider)) return undefined;
      const metadata = request.metadata ?? {};
      if (typeof metadata[ACCOUNT_METADATA_KEY] === "string") return undefined;
      const state = await service.state();
      if (state.defaultAccountId === SYSTEM_ACCOUNT_ID) return undefined;
      const account = service.store.get(state.defaultAccountId);
      if (!account || account.unsafeDetail || service.knownStatus(account.id) === "signed-out") {
        // A default that cannot run would make every new agent fail; leave it on the system sign-in.
        console.warn(
          `antigravity-accounts: default account ${state.defaultAccountId} cannot run; new agent stays on the system sign-in`,
        );
        return undefined;
      }
      return {
        ...request,
        metadata: { ...metadata, [ACCOUNT_METADATA_KEY]: state.defaultAccountId },
      };
    }),
  );

  // Every launch of an Antigravity session gets the environment of its account.
  removers.push(
    server.addHook("agent.open.before", async ({ request }, { paseo }) => {
      if (!isAntigravityProvider(request.provider)) return undefined;
      await service.init();
      let accountId = accountIdFromMetadata(request.metadata);
      // Fallback: an account known to be unable to serve gives way to the next one that can.
      if (service.fallbackSettings().enabled && fallback) {
        const reason = await fallback.healthOf(accountId);
        if (reason) {
          const next = await fallback.redirectForOpen(paseo, request.agentId, accountId, reason, request.purpose === "interactive");
          if (next) accountId = next;
        }
      }
      const account = accountId === SYSTEM_ACCOUNT_ID ? null : service.store.get(accountId);
      if (accountId !== SYSTEM_ACCOUNT_ID) {
        const problem = !account
          ? "The Antigravity account this agent was using has been removed."
          : account.unsafeDetail;
        if (problem) {
          // Reading history is harmless on the system sign-in; running a turn is not.
          if (request.purpose === "history") accountId = SYSTEM_ACCOUNT_ID;
          else {
            throw new Error(
              `${problem} Switch the agent to another account with the account pill above the composer.`,
            );
          }
        }
      }
      if (accountId !== SYSTEM_ACCOUNT_ID) await ensureProfile(accountId);
      return {
        ...request,
        env: { ...request.env, ...sessionEnv(accountId, request.env) },
      };
    }),
  );

  // A finished turn used quota: re-read that account's quota shortly after, once per burst.
  const quotaRefresh = new Map<string, NodeJS.Timeout>();
  removers.push(
    server.addHook("agent.turn.after", async ({ agent }) => {
      if (!isAntigravityProvider(agent.provider)) return;
      const accountId = accountIdFromMetadata(agent.metadata);
      clearTimeout(quotaRefresh.get(accountId));
      quotaRefresh.set(
        accountId,
        setTimeout(() => {
          quotaRefresh.delete(accountId);
          void service.refreshOne(accountId).catch(() => undefined);
        }, 15_000),
      );
    }),
  );
  removers.push(() => {
    for (const timer of quotaRefresh.values()) clearTimeout(timer);
    quotaRefresh.clear();
  });

  // Deferred switches run as soon as the agent's turn ends.
  removers.push(
    server.addHook("agent.turn.after", async ({ agent }, { paseo }) => {
      const target = pending.take(agent.id);
      if (!target) return;
      if (accountIdFromMetadata(agent.metadata) !== target) return;
      await new Promise((resolve) => setTimeout(resolve, 500));
      try {
        await paseo.agents.ref(agent.id).reload();
      } catch (error) {
        console.error(`antigravity-accounts: deferred switch of ${agent.id} failed`, error);
      }
    }),
  );

  removers.push(
    server.addHook("agent.archive.after", async ({ agent }) => {
      pending.delete(agent.id);
    }),
  );

  return removers;
}
