import type { PluginButton, PluginButtonMenuEntry, PluginButtonRegistration, PluginClientContext, PluginText } from "@getpaseo/plugin/client";
import { useToast, type ToastApi } from "@getpaseo/plugin/client/ui";
import { useEffect } from "react";
import { accountIdFromMetadata, isAntigravityProvider, listAccountsRpc, switchAgentAccountRpc, watchAccountsSubscription, type AccountsState, type AccountSummary } from "../shared/contracts";
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
type Schedule = typeof setTimeout;
type Timer = ReturnType<Schedule>;

export function observeAgents(client: PluginClientContext) {
  const lifetime = new AbortController();
  const agents = new Map<string, Member>();
  const pills = new Map<string, PluginButtonRegistration<PluginText>>();
  const listeners = new Set<() => void>();
  const presenters = new Map<symbol, ToastApi>();
  let pendingNotice: string | undefined;
  let counts: Counts | null = null;
  let accounts: AccountsState | undefined;

  // Commands have no toast API. Mounted host surfaces lend their installation's presenter.
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
      if (pendingNotice) { notify(pendingNotice); pendingNotice = undefined; }
      return () => { presenters.delete(key); };
    }, [toast]);
  }
  async function switchTo(agentId: string, account: AccountSummary, when: "now" | "after-turn") {
    const result = await client.rpc(switchAgentAccountRpc, { agentId, accountId: account.id, when });
    notify(client.i18n.t(messages, result.result, { label: result.accountLabel }));
  }
  function renderPill(agent: Member) {
    if (!agent.workspace) return;
    const choices: PluginButtonMenuEntry<PluginText>[] = (accounts?.accounts ?? []).map(account => {
      const selected = account.id === agent.account;
      const action = (when: "now" | "after-turn") => ({
        kind: "action" as const, onPress: () => switchTo(agent.id, account, when),
      });
      return {
        kind: "item", id: account.id, title: account.label, icon: selected ? "Check" : "UserRound",
        disabled: selected || !account.usable || account.status === "signed-out",
        behavior: agent.running ? { kind: "menu", items: [
          { kind: "item", id: "now", title: messages.message("now"), behavior: action("now") },
          { kind: "item", id: "after", title: messages.message("after"), behavior: action("after-turn") },
        ] } : action("now"),
      };
    });
    if (choices.length) choices.push({ kind: "separator", id: "separator" });
    choices.push({ kind: "item", id: "manage", title: messages.message("manage"), icon: "UsersRound",
      behavior: { kind: "action", onPress: () => client.openScreen({ screenId: "accounts" }) } });
    const button: PluginButton<PluginText> = {
      icon: "UserRound", title: messages.message("pill"),
      label: accounts?.accounts.find(a => a.id === agent.account)?.label ?? agent.account,
      behavior: { kind: "menu", items: choices },
    };
    const pill = pills.get(agent.id);
    if (pill) pill.update(button);
    else pills.set(agent.id, client.addComposerPill({ id: "account", agentId: agent.id, workspaceId: agent.workspace, button }));
  }
  function applyAccounts(next: AccountsState) {
    if (lifetime.signal.aborted || (accounts && accounts.revision >= next.revision)) return;
    accounts = next;
    agents.forEach(renderPill);
  }
  let retry: Timer | undefined;
  async function readAccounts() {
    try { applyAccounts(await client.rpc(listAccountsRpc, {})); }
    catch (error) {
      if (lifetime.signal.aborted) return;
      console.warn("Account list unavailable", error);
      clearTimeout(retry);
      retry = setTimeout(readAccounts, 5000);
    }
  }
  const watch = client.subscribe(watchAccountsSubscription, {}, ({ revision }) => {
    if (revision > (accounts?.revision ?? -1)) void readAccounts();
  }, { signal: lifetime.signal });
  void watch.ready.catch(error => { if (!lifetime.signal.aborted) console.warn("Account watch unavailable", error); });
  void readAccounts();

  function publishCounts() {
    const next = new Map<string, number>();
    for (const { account } of agents.values()) next.set(account, (next.get(account) ?? 0) + 1);
    if (counts && counts.size === next.size && [...next].every(([id,n]) => counts?.get(id) === n)) return;
    counts = next;
    listeners.forEach(listener => listener());
  }
  function remove(id: string) {
    pills.get(id)?.remove();
    pills.delete(id);
    agents.delete(id);
  }
  function upsert(row: AgentRow) {
    if (row.archivedAt || !isAntigravityProvider(row.provider)) return remove(row.id);
    const member = { id: row.id, workspace: row.workspaceId ?? null,
      account: accountIdFromMetadata(row.metadata), running: row.status === "running" };
    const old = agents.get(row.id);
    if (old && old.workspace === member.workspace && old.account === member.account && old.running === member.running) return;
    if (old && old.workspace !== member.workspace) remove(row.id);
    agents.set(row.id, member);
    renderPill(member);
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
      console.warn("Agent observation unavailable", error);
      reconnect = setTimeout(observe, 5000);
    }
  }
  void observe();
  const slash = client.addSlashCommand({
    name: "account", context: "agent", description: messages.message("slash"), argumentHint: messages.message("hint"),
    async onSubmit({ agent, args }) {
      if (!isAntigravityProvider(agent.provider)) return notify(client.i18n.t(messages, "only"));
      const state = await client.rpc(listAccountsRpc, {});
      applyAccounts(state);
      const list = state.accounts;
      const current = accountIdFromMetadata(agent.metadata);
      const input = args.trim().toLowerCase();
      if (!input) return notify(client.i18n.t(messages, "choices", {
        label: list.find(a => a.id === current)?.label ?? current,
        list: list.map((a, i) => `${i + 1}. ${a.label}`).join("\n"),
      }));
      let matches = list.filter(a => a.label.toLowerCase() === input);
      if (/^\d+$/.test(input)) matches = list.slice(Number(input) - 1, Number(input));
      else if (!matches.length) matches = list.filter(a => a.label.toLowerCase().startsWith(input));
      if (matches.length !== 1) return notify(client.i18n.t(messages, matches.length ? "ambiguous" : "noMatch"));
      if (!matches[0].usable || matches[0].status === "signed-out") {
        return notify(matches[0].statusDetail || client.i18n.t(messages, "unusable"));
      }
      await switchTo(agent.id, matches[0], agent.status === "running" ? "after-turn" : "now");
    },
  });
  return {
    useNotifications,
    counts: () => counts,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    stop() {
      lifetime.abort();
      clearTimeout(retry);
      clearTimeout(reconnect);
      slash();
      pills.forEach(pill => pill.remove());
      pills.clear();
      agents.clear();
      listeners.clear();
      presenters.clear();
      pendingNotice = undefined;
    },
  };
}

type ObserveAgents = typeof observeAgents;
export type AgentObservation = ReturnType<ObserveAgents>;
