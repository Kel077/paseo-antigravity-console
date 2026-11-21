import type {
  PluginButton,
  PluginButtonMenuEntry,
  PluginButtonRegistration,
  PluginClientContext,
  PluginText,
} from "@getpaseo/plugin/client";
import { useToast, type ToastApi } from "@getpaseo/plugin/client/ui";
import { useEffect } from "react";
import {
  accountIdFromMetadata,
  contextUsageRpc,
  isAntigravityProvider,
  listAccountsRpc,
  switchAgentAccountRpc,
  watchAccountsSubscription,
  type AccountsState,
  type AccountSummary,
  type ContextUsage,
} from "../shared/contracts";
import { ContextPopover, contextStore } from "./context";
import { percent, tokens } from "./format";
import { displayLabel } from "./labels";
import { messages } from "./messages";

type AgentRow = {
  id: string;
  workspaceId?: string | null;
  archivedAt?: unknown;
  metadata?: Readonly<Record<string, unknown>> | null;
  provider: string;
  status: string;
};
type Member = { id: string; workspace: string | null; account: string; running: boolean };
type Counts = ReadonlyMap<string, number>;
type Timer = ReturnType<typeof setTimeout>;

const CONTEXT_POLL_MS = 5000;

export function observeAgents(client: PluginClientContext) {
  const lifetime = new AbortController();
  const agents = new Map<string, Member>();
  const accountPills = new Map<string, PluginButtonRegistration<PluginText>>();
  const contextPills = new Map<string, PluginButtonRegistration<PluginText>>();
  const nativeContext = new Set<string>();
  const listeners = new Set<() => void>();
  const presenters = new Map<symbol, ToastApi>();
  let pendingNotice: string | undefined;
  let counts: Counts | null = null;
  let accounts: AccountsState | undefined;

  // Commands have no toast API of their own; mounted plugin surfaces lend theirs.
  function notify(message: string) {
    if (lifetime.signal.aborted) return;
    const presenter = presenters.values().next().value;
    if (presenter) presenter.show(message, { durationMs: 5000 });
    else pendingNotice = message;
  }
  function useNotifications() {
    const toast = useToast();
    useEffect(() => {
      const key = Symbol();
      presenters.set(key, toast);
      if (pendingNotice) {
        notify(pendingNotice);
        pendingNotice = undefined;
      }
      return () => {
        presenters.delete(key);
      };
    }, [toast]);
  }

  const nameOf = (label: string) => displayLabel(label, (key) => client.i18n.t(messages, key));

  async function switchTo(agentId: string, account: AccountSummary, when: "now" | "after-turn") {
    const result = await client.rpc(switchAgentAccountRpc, { agentId, accountId: account.id, when });
    notify(client.i18n.t(messages, result.result, { label: nameOf(result.accountLabel) }));
  }

  // ---- Account pill -------------------------------------------------------------------------

  function renderAccountPill(agent: Member) {
    if (!agent.workspace) return;
    const current = accounts?.accounts.find((account) => account.id === agent.account);
    const healthy = !current || (current.usable && current.status !== "signed-out");
    const choices: PluginButtonMenuEntry<PluginText>[] = (accounts?.accounts ?? []).map((account) => {
      const selected = account.id === agent.account;
      const unavailable = !account.usable || account.status === "signed-out";
      const action = (when: "now" | "after-turn") => ({
        kind: "action" as const,
        onPress: () => switchTo(agent.id, account, when),
      });
      return {
        kind: "item",
        id: account.id,
        title: account.email && !(account.kind === "profile" && account.status === "signed-out")
          ? `${nameOf(account.label)} · ${account.email}`
          : nameOf(account.label),
        icon: selected ? "Check" : unavailable ? "UserX" : "UserRound",
        disabled: selected || unavailable,
        behavior: agent.running
          ? {
              kind: "menu",
              items: [
                { kind: "item", id: "now", title: messages.message("now"), icon: "Zap", behavior: action("now") },
                { kind: "item", id: "after", title: messages.message("after"), icon: "Clock", behavior: action("after-turn") },
              ],
            }
          : action("now"),
      };
    });
    if (choices.length) choices.push({ kind: "separator", id: "separator" });
    choices.push({
      kind: "item",
      id: "manage",
      title: messages.message("manage"),
      icon: "Settings2",
      behavior: { kind: "action", onPress: () => client.openScreen({ screenId: "accounts" }) },
    });
    const button: PluginButton<PluginText> = {
      icon: healthy ? "UserRound" : "UserX",
      title: healthy ? messages.message("pill") : messages.message("pillSignedOut"),
      label: current ? nameOf(current.label) : agent.account,
      behavior: { kind: "menu", items: choices },
    };
    const pill = accountPills.get(agent.id);
    if (pill) pill.update(button);
    else {
      accountPills.set(
        agent.id,
        client.addComposerPill({ id: "account", agentId: agent.id, workspaceId: agent.workspace, button }),
      );
    }
  }

  // ---- Context pill -------------------------------------------------------------------------

  function contextLabel(usage: ContextUsage | null | undefined): PluginText {
    if (!usage) return messages.message("context.labelEmpty");
    if (!usage.size) return messages.message("context.labelNoSize", { used: tokens(usage.used) });
    return messages.message("context.label", {
      used: tokens(usage.used),
      size: tokens(usage.size),
      pct: percent(usage.used / usage.size, client.i18n.locale),
    });
  }

  function renderContextPill(agent: Member) {
    if (!agent.workspace || nativeContext.has(agent.id)) {
      contextPills.get(agent.id)?.remove();
      contextPills.delete(agent.id);
      return;
    }
    const button: PluginButton<PluginText> = {
      icon: "Gauge",
      title: messages.message("context.title"),
      label: contextLabel(contextStore.get(agent.id)),
      behavior: { kind: "popover", Content: ContextPopover },
    };
    const pill = contextPills.get(agent.id);
    if (pill) pill.update({ label: button.label });
    else {
      contextPills.set(
        agent.id,
        client.addComposerPill({ id: "context", agentId: agent.id, workspaceId: agent.workspace, button }),
      );
    }
  }

  let polling = false;
  async function pollContext() {
    const ids = [...agents.values()].filter((agent) => agent.workspace).map((agent) => agent.id);
    if (polling || lifetime.signal.aborted || ids.length === 0) return;
    polling = true;
    try {
      const { usage, native } = await client.rpc(contextUsageRpc, { agentIds: ids });
      nativeContext.clear();
      for (const id of native) nativeContext.add(id);
      for (const id of ids) contextStore.set(id, usage[id] ?? null);
      for (const id of ids) {
        const agent = agents.get(id);
        if (agent) renderContextPill(agent);
      }
    } catch (error) {
      if (!lifetime.signal.aborted) console.warn("[antigravity-accounts] context refresh failed", error);
    } finally {
      polling = false;
    }
  }
  let soon: Timer | undefined;
  function pollSoon() {
    clearTimeout(soon);
    soon = setTimeout(() => void pollContext(), 800);
  }
  const contextTimer = setInterval(() => void pollContext(), CONTEXT_POLL_MS);

  // ---- Accounts -----------------------------------------------------------------------------

  function applyAccounts(next: AccountsState) {
    if (lifetime.signal.aborted || (accounts && accounts.revision > next.revision)) return;
    accounts = next;
    agents.forEach(renderAccountPill);
  }
  let retry: Timer | undefined;
  async function readAccounts() {
    try {
      applyAccounts(await client.rpc(listAccountsRpc, {}));
    } catch (error) {
      if (lifetime.signal.aborted) return;
      console.warn("[antigravity-accounts] account list unavailable", error);
      clearTimeout(retry);
      retry = setTimeout(readAccounts, 5000);
    }
  }
  const watch = client.subscribe(
    watchAccountsSubscription,
    {},
    ({ revision }) => {
      if (revision > (accounts?.revision ?? -1)) void readAccounts();
    },
    { signal: lifetime.signal },
  );
  void watch.ready.catch((error: unknown) => {
    if (!lifetime.signal.aborted) console.warn("[antigravity-accounts] account watch unavailable", error);
  });
  void readAccounts();

  // ---- Agents -------------------------------------------------------------------------------

  function publishCounts() {
    const next = new Map<string, number>();
    for (const { account } of agents.values()) next.set(account, (next.get(account) ?? 0) + 1);
    if (counts && counts.size === next.size && [...next].every(([id, n]) => counts?.get(id) === n)) return;
    counts = next;
    listeners.forEach((listener) => listener());
  }
  function remove(id: string) {
    accountPills.get(id)?.remove();
    accountPills.delete(id);
    contextPills.get(id)?.remove();
    contextPills.delete(id);
    contextStore.delete(id);
    agents.delete(id);
  }
  function upsert(row: AgentRow) {
    if (row.archivedAt || !isAntigravityProvider(row.provider)) return remove(row.id);
    const member: Member = {
      id: row.id,
      workspace: row.workspaceId ?? null,
      account: accountIdFromMetadata(row.metadata),
      running: row.status === "running" || row.status === "initializing",
    };
    const old = agents.get(row.id);
    // A status change usually means a turn started or ended: context changes then.
    if (!old || old.running !== member.running) pollSoon();
    if (old && old.workspace === member.workspace && old.account === member.account && old.running === member.running) return;
    if (old && old.workspace !== member.workspace) remove(row.id);
    agents.set(row.id, member);
    renderAccountPill(member);
    renderContextPill(member);
  }
  let reconnect: Timer | undefined;
  async function observe() {
    try {
      const { subscription } = await client.paseo.agents.list({ subscribe: {}, signal: lifetime.signal });
      if (lifetime.signal.aborted) return;
      subscription.subscribe({
        snapshot({ entries }) {
          if (lifetime.signal.aborted) return;
          const ids = new Set(entries.map(({ agent }) => agent.id));
          for (const id of agents.keys()) if (!ids.has(id)) remove(id);
          entries.forEach(({ agent }) => upsert(agent));
          publishCounts();
        },
        update(message) {
          if (lifetime.signal.aborted || message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "remove") remove(update.agentId);
          else upsert(update.agent);
          publishCounts();
        },
      });
    } catch (error) {
      if (lifetime.signal.aborted) return;
      console.warn("[antigravity-accounts] agent observation unavailable", error);
      reconnect = setTimeout(observe, 5000);
    }
  }
  void observe();

  // ---- /account -----------------------------------------------------------------------------

  const slash = client.addSlashCommand({
    name: "account",
    context: "agent",
    description: messages.message("slash"),
    argumentHint: messages.message("hint"),
    async onSubmit({ agent, args }) {
      if (!isAntigravityProvider(agent.provider)) return notify(client.i18n.t(messages, "only"));
      const state = await client.rpc(listAccountsRpc, {});
      applyAccounts(state);
      const list = state.accounts;
      const current = accountIdFromMetadata(agent.metadata);
      const input = args.trim().toLowerCase();
      if (!input) {
        return notify(
          client.i18n.t(messages, "choices", {
            label: nameOf(list.find((account) => account.id === current)?.label ?? current),
            list: list.map((account, index) => `${index + 1}. ${nameOf(account.label)}`).join("\n"),
          }),
        );
      }
      const named = (account: AccountSummary) => nameOf(account.label).toLowerCase();
      let matches = list.filter((account) => named(account) === input || account.label.toLowerCase() === input);
      if (/^\d+$/.test(input)) matches = list.slice(Number(input) - 1, Number(input));
      else if (!matches.length) matches = list.filter((account) => named(account).startsWith(input));
      if (matches.length !== 1) return notify(client.i18n.t(messages, matches.length ? "ambiguous" : "noMatch"));
      const target = matches[0]!;
      if (!target.usable || target.status === "signed-out") {
        return notify(target.statusDetail || client.i18n.t(messages, "unusable"));
      }
      await switchTo(agent.id, target, agent.status === "running" ? "after-turn" : "now");
    },
  });

  return {
    useNotifications,
    counts: () => counts,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refreshContext: () => pollContext(),
    stop() {
      lifetime.abort();
      clearTimeout(retry);
      clearTimeout(reconnect);
      clearTimeout(soon);
      clearInterval(contextTimer);
      slash();
      accountPills.forEach((pill) => pill.remove());
      contextPills.forEach((pill) => pill.remove());
      accountPills.clear();
      contextPills.clear();
      agents.clear();
      listeners.clear();
      presenters.clear();
      contextStore.clear();
      pendingNotice = undefined;
    },
  };
}

export type AgentObservation = ReturnType<typeof observeAgents>;
