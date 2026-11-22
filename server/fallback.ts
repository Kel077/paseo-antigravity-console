import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  ACCOUNT_METADATA_KEY,
  FALLBACK_TIMELINE_KIND,
  SYSTEM_ACCOUNT_ID,
  accountIdFromMetadata,
  isAntigravityProvider,
  type FallbackEvent,
  type QuotaGroup,
} from "../shared/contracts";
import type { AccountService } from "./accounts";
import { switchAgentAccount, type PendingSwitches } from "./hooks";

export type FailureKind = FallbackEvent["reason"];

/** The prompt that resumes an agent after a retry or an account switch; the conversation carries the task. */
const RESUME_PROMPT = "Continue.";

const QUOTA = /resource.?exhausted|\b429\b|quota|usage limit|rate.?limit|limit (reached|exceeded)|exhausted|too many requests/i;
const AUTH = /authenticat|sign.?in|log.?in|unauthori[sz]ed|\b401\b|\b403\b|permission.?denied|invalid.?grant|credentials/i;
const TRANSIENT =
  /\b5\d\d\b|unavailable|deadline|timed? ?out|timeout|econn|etimedout|socket|network|overloaded|capacity|internal|temporar|did not initialize|exited/i;

export function classify(message: string, code?: string): FailureKind {
  const text = `${code ?? ""} ${message}`;
  if (QUOTA.test(text)) return "quota";
  if (AUTH.test(text)) return "auth";
  if (TRANSIENT.test(text)) return "transient";
  return "error";
}

interface Chain {
  /** Retries spent on the current account. */
  attempts: number;
  /** Accounts this failure chain already ran on. */
  tried: Set<string>;
}

/** Earliest reset among the buckets that ran out, else null. */
function resetOfExhausted(groups: readonly QuotaGroup[] | null): number | null {
  let earliest: number | null = null;
  for (const group of groups ?? []) {
    for (const bucket of group.buckets) {
      if (bucket.disabled || bucket.remainingFraction === null || bucket.remainingFraction > 0.001) continue;
      const at = bucket.resetTime ? Date.parse(bucket.resetTime) : NaN;
      if (Number.isFinite(at) && (earliest === null || at < earliest)) earliest = at;
    }
  }
  return earliest;
}

/** True when a known quota says the account cannot serve the next request. */
function exhausted(groups: readonly QuotaGroup[] | null): boolean {
  const primary = (groups ?? []).find((group) => /gemini/i.test(group.name) && !/argon/i.test(group.name)) ?? groups?.[0];
  return (primary?.buckets ?? []).some(
    (bucket) => !bucket.disabled && bucket.remainingFraction !== null && bucket.remainingFraction <= 0.001,
  );
}

export class FallbackController {
  private readonly chains = new Map<string, Chain>();
  /** Account id → until when it is skipped, and why. */
  private readonly cooldown = new Map<string, { until: number; reason: FailureKind }>();
  private readonly timers = new Set<NodeJS.Timeout>();

  constructor(
    private readonly service: AccountService,
    private readonly pending: PendingSwitches,
  ) {}

  register(server: PluginServerContext): () => void {
    return server.addHook("agent.turn.after", async ({ agent, outcome }, { paseo }) => {
      if (!isAntigravityProvider(agent.provider)) return;
      if (outcome.kind !== "failed") {
        // A finished or canceled turn ends the chain; the user decides what happens next.
        this.chains.delete(agent.id);
        return;
      }
      await this.service.init();
      const settings = this.service.fallbackSettings();
      if (!settings.enabled) return;
      try {
        await this.handleFailure(paseo, agent.id, accountIdFromMetadata(agent.metadata), outcome.error, settings.retries);
      } catch (error) {
        console.error(`antigravity-accounts: fallback for ${agent.id} failed`, error);
      }
    });
  }

  private async handleFailure(
    paseo: PaseoApi,
    agentId: string,
    current: string,
    error: { message: string; code?: string },
    retries: number,
  ): Promise<void> {
    const reason = classify(error.message, error.code);
    const chain = this.chains.get(agentId) ?? { attempts: 0, tried: new Set<string>() };
    this.chains.set(agentId, chain);
    chain.tried.add(current);
    const fromLabel = this.service.labelOf(current);
    const message = error.message.slice(0, 400);
    // The failure may have changed the quota; the sidebar and the next choice should see it.
    await this.service.refreshOne(current).catch(() => undefined);

    if ((reason === "transient" || reason === "error") && chain.attempts < retries) {
      chain.attempts += 1;
      const attempt = chain.attempts;
      await this.note(paseo, agentId, { event: "retry", reason, from: fromLabel, to: null, attempt, retries, message });
      this.later(attempt * 5000, () => this.resume(paseo, agentId));
      return;
    }

    const until =
      reason === "quota"
        ? (resetOfExhausted(this.service.knownQuota(current)) ?? Date.now() + 30 * 60_000)
        : reason === "auth"
          ? Date.now() + 6 * 3_600_000
          : Date.now() + 10 * 60_000;
    this.cooldown.set(current, { until, reason });

    const next = await this.pickNext(current, chain.tried);
    if (!next) {
      this.chains.delete(agentId);
      await this.note(paseo, agentId, { event: "exhausted", reason, from: fromLabel, to: null, attempt: chain.attempts, retries, message });
      return;
    }
    chain.attempts = 0;
    chain.tried.add(next);
    await switchAgentAccount(paseo, this.service, this.pending, { agentId, accountId: next, when: "now" });
    await this.note(paseo, agentId, {
      event: "switch",
      reason,
      from: fromLabel,
      to: this.service.labelOf(next),
      attempt: 0,
      retries,
      message,
    });
    await this.resume(paseo, agentId);
  }

  /** The next account in list order after `current` that can take the work. */
  async pickNext(current: string, tried: ReadonlySet<string>): Promise<string | null> {
    const state = await this.service.state();
    const ids = state.accounts.map((account) => account.id);
    const start = Math.max(0, ids.indexOf(current));
    const now = Date.now();
    for (let step = 1; step < ids.length; step += 1) {
      const id = ids[(start + step) % ids.length]!;
      if (tried.has(id)) continue;
      if ((this.cooldown.get(id)?.until ?? 0) > now) continue;
      const account = state.accounts.find((entry) => entry.id === id);
      if (!account?.usable || account.status === "signed-out") continue;
      if (id !== SYSTEM_ACCOUNT_ID && account.status === "unknown") {
        // Never checked: look once before sending work there.
        await this.service.refreshOne(id).catch(() => undefined);
      }
      const known = this.service.knownQuota(id);
      if (exhausted(known)) continue;
      const fresh = (await this.service.state()).accounts.find((entry) => entry.id === id);
      if (!fresh || fresh.status === "signed-out" || !fresh.usable) continue;
      return id;
    }
    return null;
  }

  /**
   * Why an account cannot take a session right now, or null. Uses only what is already known:
   * a missing sign-in file, a signed-out or unsafe account, an exhausted quota, or a cooldown.
   */
  async healthOf(accountId: string): Promise<FailureKind | null> {
    const cooling = this.cooldown.get(accountId);
    if (cooling && cooling.until > Date.now()) return cooling.reason;
    const state = await this.service.state();
    const account = state.accounts.find((entry) => entry.id === accountId);
    if (!account || !account.usable || account.status === "signed-out") return "auth";
    if (account.kind === "profile" && !(await this.service.hasSignInFile(accountId))) return "auth";
    if (exhausted(this.service.knownQuota(accountId))) return "quota";
    return null;
  }

  /**
   * Called while an agent's session opens on an account that cannot take it. Returns the account to
   * open on instead and, once the open is over, records the change on the agent and in its timeline.
   */
  async redirectForOpen(paseo: PaseoApi, agentId: string, accountId: string, reason: FailureKind, record: boolean): Promise<string | null> {
    const next = await this.pickNext(accountId, new Set([accountId]));
    if (!next || !record) return next;
    const from = this.service.labelOf(accountId);
    const to = this.service.labelOf(next);
    // The open waits for this hook; touching the agent before it returns could deadlock.
    this.later(1500, async () => {
      await paseo.agents.ref(agentId).setMetadata({ [ACCOUNT_METADATA_KEY]: next });
      await this.note(paseo, agentId, { event: "switch", reason, from, to, attempt: 0, retries: this.service.fallbackSettings().retries, message: "" });
    });
    return next;
  }

  /** Sends the resume prompt unless the agent is already busy (for example the user typed meanwhile). */
  private async resume(paseo: PaseoApi, agentId: string): Promise<void> {
    const handle = paseo.agents.ref(agentId);
    const snapshot = await handle.refresh().catch(() => null);
    if (!snapshot || snapshot.agent.archivedAt) {
      this.chains.delete(agentId);
      return;
    }
    if (snapshot.agent.status === "running" || snapshot.agent.status === "initializing") return;
    await handle.send(RESUME_PROMPT);
  }

  private async note(paseo: PaseoApi, agentId: string, event: FallbackEvent): Promise<void> {
    await paseo.agents
      .ref(agentId)
      .timeline.append({
        type: "plugin",
        id: `fallback-${Date.now()}`,
        kind: FALLBACK_TIMELINE_KIND,
        version: 1,
        data: event,
      })
      .catch((error: unknown) => console.error("antigravity-accounts: could not add the fallback note", error));
  }

  private later(ms: number, task: () => Promise<void>): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      void task().catch((error: unknown) => console.error("antigravity-accounts: retry failed", error));
    }, ms);
    this.timers.add(timer);
  }

  dispose(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.chains.clear();
  }
}
