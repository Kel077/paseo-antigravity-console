import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  ACCOUNT_METADATA_KEY,
  SYSTEM_ACCOUNT_ID,
  accountIdFromMetadata,
  isAntigravityProvider,
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
  await handle.reload();
  return { result: "switched", accountLabel };
}

export function registerHooks(
  server: PluginServerContext,
  service: AccountService,
  pending: PendingSwitches,
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
      return {
        ...request,
        metadata: { ...metadata, [ACCOUNT_METADATA_KEY]: state.defaultAccountId },
      };
    }),
  );

  // Every launch of an Antigravity session gets the environment of its account.
  removers.push(
    server.addHook("agent.open.before", async ({ request }) => {
      if (!isAntigravityProvider(request.provider)) return undefined;
      await service.init();
      let accountId = accountIdFromMetadata(request.metadata);
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
