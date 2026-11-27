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
  SYSTEM_ACCOUNT_ID,
  accountIdFromMetadata,
  agentTasksRpc,
  contextUsageRpc,
  getOrchestratorRpc,
  isAntigravityProvider,
  isOrchestratorModel,
  isUnsupportedBackgroundFilterError,
  listAccountsRpc,
  setOrchestratorRpc,
  subagentCountsRpc,
  switchAgentAccountRpc,
  watchAccountsSubscription,
  type AccountsState,
  type AccountSummary,
  type ContextUsage,
  type ModelFamily,
  type OrchestratorState,
} from "../shared/contracts";
import { ContextPopover, contextStore } from "./context";
import { percent, tokens, usd } from "./format";
import { displayLabel } from "./labels";
import { errorMessage, messages } from "./messages";
import { resolvePresets, shortModelLabel } from "./orchestrator";
import { accountSupportsModel, activeCooldownForModel, compactQuotaSummary } from "./quota";
import { TasksPopover, countSteps, tasksStore } from "./tools";

type AgentRow = {
  id: string;
  workspaceId?: string | null;
  archivedAt?: unknown;
  persistence?: unknown;
  metadata?: Readonly<Record<string, unknown>> | null;
  provider: string;
  model?: string | null;
  title?: string | null;
  status: string;
};

export interface ObservedAgent {
  id: string;
  sessionKey: string | null;
  workspace: string | null;
  account: string;
  running: boolean;
  model: string | null;
  title: string | null;
}

// Keep UUID precedence aligned with conversationIdFrom in server/context.ts.
function persistenceSessionKey(persistence: unknown): string | null {
  const record = persistence as Record<string, unknown> | null;
  if (!record || typeof record !== "object") return typeof persistence === "string" ? persistence.trim() || null : null;
  const meta = record.metadata as Record<string, unknown> | undefined;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const candidates: unknown[] = [];
  function addProvider(handle: unknown) {
    const data = (handle as { data?: Record<string, unknown> } | null)?.data;
    candidates.push(data?.sessionId, data?.conversationId);
  }
  addProvider(meta?.pluginProviderPersistence);
  for (const handle of [record.sessionId, record.nativeHandle]) {
    if (typeof handle === "string" && handle.startsWith("plugin:")) {
      try { addProvider(JSON.parse(handle.slice(7))); } catch { /* Try the legacy fields. */ }
    }
  }
  candidates.push(record.conversationId, record.nativeHandle, record.sessionId,
    meta?.conversationId, meta?.nativeHandle, meta?.sessionId);
  const strings = candidates.filter((value): value is string => typeof value === "string");
  return strings.find(value => uuid.test(value)) ?? strings.map(value => value.trim()).find(Boolean) ?? null;
}

type OpenSubagents = (agentId: string, workspaceId: string | null | undefined, subagentId?: string) => void;

/** An empty icon that keeps menu labels aligned with the checked one. */
const BLANK_ICON = {
  svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"><path d="M0 0h24v24H0z" fill="none"/></svg>',
};

type Counts = ReadonlyMap<string, number>;
type WorkspaceSubagents = ReadonlyMap<string, number>;
type Timer = ReturnType<typeof setTimeout>;

const CONTEXT_POLL_MS = 5000;
const IDLE_POLL_MS = 30_000;
const POLL_BATCH_SIZE = 100;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

export function observeAgents(client: PluginClientContext, openSubagents: OpenSubagents) {
  const lifetime = new AbortController();
  const agents = new Map<string, ObservedAgent>();
  const accountPills = new Map<string, PluginButtonRegistration<PluginText>>();
  const contextPills = new Map<string, PluginButtonRegistration<PluginText>>();
  const subagentPills = new Map<string, PluginButtonRegistration<PluginText>>();
  const tasksPills = new Map<string, PluginButtonRegistration<PluginText>>();
  const orchestratorPills = new Map<string, PluginButtonRegistration<PluginText>>();
  const subagentCounts = new Map<string, { total: number; running: number }>();
  const lastPolledAt = new Map<string, number>();
  const sessionGen = new Map<string, number>();
  let orchestrator: OrchestratorState | undefined;
  const nativeContext = new Set<string>();
  const listeners = new Set<() => void>();
  const presenters = new Map<symbol, ToastApi>();
  let pendingNotice: string | undefined;
  let counts: Counts | null = null;
  let memberSnapshot: readonly ObservedAgent[] = [];
  let workspaceSubagents: WorkspaceSubagents = new Map();
  let accounts: AccountsState | undefined;
  let accountSignature = "";

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

  const nameOf = (label: string, kind?: AccountSummary["kind"]) =>
    displayLabel(label, (key) => client.i18n.t(messages, key), kind);

  function emit() {
    listeners.forEach((listener) => listener());
  }

  function publishWorkspaceSubagents() {
    const next = new Map<string, number>();
    for (const agent of agents.values()) {
      if (!agent.workspace) continue;
      const running = subagentCounts.get(agent.id)?.running ?? 0;
      if (running > 0) next.set(agent.workspace, (next.get(agent.workspace) ?? 0) + running);
    }
    if (
      workspaceSubagents.size === next.size &&
      [...next].every(([ws, n]) => workspaceSubagents.get(ws) === n)
    ) {
      return;
    }
    workspaceSubagents = next;
    emit();
  }

  async function switchTo(agentId: string, account: AccountSummary, when: "now" | "after-turn") {
    const result = await client.rpc(switchAgentAccountRpc, { agentId, accountId: account.id, when });
    notify(client.i18n.t(messages, result.result, { label: nameOf(result.accountLabel, account.kind) }));
  }

  // ---- Account pill -------------------------------------------------------------------------

  function renderAccountPill(agent: ObservedAgent) {
    if (!agent.workspace) return;
    const list = accounts?.accounts ?? [];
    const current = list.find((account) => account.id === agent.account);
    const healthy = !current || (current.usable && current.status !== "signed-out");
    const labelCounts = new Map<string, number>();
    for (const account of list) {
      const display = nameOf(account.label, account.kind).toLowerCase();
      labelCounts.set(display, (labelCounts.get(display) ?? 0) + 1);
    }
    const choices: PluginButtonMenuEntry<PluginText>[] = list.map((account) => {
      const selected = account.id === agent.account;
      const unavailable = !account.usable || account.status === "signed-out";
      const display = nameOf(account.label, account.kind);
      const duplicateName = (labelCounts.get(display.toLowerCase()) ?? 0) > 1;
      const disambiguator = duplicateName ? (account.email ?? account.id) : null;
      const quota = compactQuotaSummary(account, agent.model, client.i18n.locale);
      const cooling = activeCooldownForModel(account, agent.model);
      const supported = accountSupportsModel(account, agent.model);
      const action = (when: "now" | "after-turn") => ({
        kind: "action" as const,
        onPress: () => switchTo(agent.id, account, when),
      });
      return {
        kind: "item",
        id: account.id,
        title: [
          display,
          disambiguator,
          account.note,
          quota,
          supported === false ? client.i18n.t(messages, "modelUnsupported") : null,
          cooling ? client.i18n.t(messages, "coolingShort") : null,
          account.plan,
        ]
          .filter(Boolean)
          .join(" · "),
        icon: selected
          ? "Check"
          : unavailable
            ? "UserX"
            : supported === false || cooling
              ? "TriangleAlert"
              : "UserRound",
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
      label: current ? nameOf(current.label, current.kind) : agent.account,
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

  // ---- Context & Session totals pill --------------------------------------------------------

  function contextLabel(usage: ContextUsage | null | undefined, isNative: boolean): PluginText | null {
    if (isNative) {
      const session = usage?.session;
      if (!session || session.requests <= 0) return null;
      const totalTokens = session.input + session.cached + session.output;
      if (session.pricedRequests > 0) {
        return `${usd(session.cost, client.i18n.locale)} · ${tokens(totalTokens)}`;
      }
      return tokens(totalTokens);
    }
    if (!usage) return messages.message("context.labelEmpty");
    if (!usage.size) return messages.message("context.labelNoSize", { used: tokens(usage.used) });
    return messages.message("context.label", {
      used: tokens(usage.used),
      size: tokens(usage.size),
      pct: percent(usage.used / usage.size, client.i18n.locale),
    });
  }

  function renderContextPill(agent: ObservedAgent) {
    const isNative = nativeContext.has(agent.id);
    const label = agent.workspace ? contextLabel(contextStore.get(agent.id), isNative) : null;
    if (!agent.workspace || label === null) {
      contextPills.get(agent.id)?.remove();
      contextPills.delete(agent.id);
      return;
    }
    const button: PluginButton<PluginText> = {
      icon: isNative ? "Activity" : "Gauge",
      title: isNative ? messages.message("context.sessionTitle") : messages.message("context.title"),
      label,
      behavior: { kind: "popover", Content: ContextPopover },
    };
    const pill = contextPills.get(agent.id);
    if (pill) pill.update({ icon: button.icon, title: button.title, label: button.label });
    else {
      contextPills.set(
        agent.id,
        client.addComposerPill({ id: "context", agentId: agent.id, workspaceId: agent.workspace, button }),
      );
    }
  }

  // ---- Subagent pill ------------------------------------------------------------------------

  function renderSubagentPill(agent: ObservedAgent) {
    const count = subagentCounts.get(agent.id);
    if (!agent.workspace || !count?.total) {
      subagentPills.get(agent.id)?.remove();
      subagentPills.delete(agent.id);
      return;
    }
    const label = count.running
      ? messages.message("subagents.pillLabel", { running: count.running, total: count.total })
      : messages.message("subagents.pillLabelIdle", { total: count.total });
    const pill = subagentPills.get(agent.id);
    if (pill) {
      pill.update({ label });
      return;
    }
    const workspace = agent.workspace;
    subagentPills.set(
      agent.id,
      client.addComposerPill({
        id: "subagents",
        agentId: agent.id,
        workspaceId: workspace,
        button: {
          icon: "Bot",
          title: messages.message("subagents.pill"),
          label,
          behavior: { kind: "action", onPress: () => openSubagents(agent.id, workspace) },
        },
      }),
    );
  }

  // ---- Tasks pill ---------------------------------------------------------------------------

  function renderTasksPill(agent: ObservedAgent) {
    const snapshot = tasksStore.get(agent.id);
    const steps = snapshot?.steps;
    if (!agent.workspace || !steps?.length) {
      tasksPills.get(agent.id)?.remove();
      tasksPills.delete(agent.id);
      return;
    }
    const { done, total } = countSteps(steps);
    const label = `${done}/${total}`;
    const pill = tasksPills.get(agent.id);
    if (pill) {
      pill.update({ label });
      return;
    }
    tasksPills.set(
      agent.id,
      client.addComposerPill({
        id: "tasks",
        agentId: agent.id,
        workspaceId: agent.workspace,
        button: {
          icon: "ListChecks",
          title: messages.message("tasks.title"),
          label,
          behavior: { kind: "popover", Content: TasksPopover },
        },
      }),
    );
  }

  // ---- Orchestrator pill --------------------------------------------------------------------

  function effectiveOrchestrator(agent: ObservedAgent, state: OrchestratorState) {
    const override = agent.account !== SYSTEM_ACCOUNT_ID ? state.overrides[agent.account] : undefined;
    const savedPlanner = override ? override.planner : state.planner;
    const savedExecutor = override ? override.executor : state.executor;
    const plannerFamily = state.planners.find((family) => family.variants.some((variant) => variant.label === savedPlanner));
    const executorFamily = state.executors.find((family) => family.variants.some((variant) => variant.label === savedExecutor));
    return {
      isOverride: Boolean(override),
      savedPlanner,
      savedExecutor,
      effectivePlanner: plannerFamily && plannerFamily.accounts.includes(agent.account) ? savedPlanner : null,
      effectiveExecutor: executorFamily && executorFamily.accounts.includes(agent.account) ? savedExecutor : null,
    };
  }

  async function chooseOrchestrator(
    agent: ObservedAgent,
    patch: { planner?: string | null; executor?: string | null; accountId?: string; inheritGlobal?: boolean },
  ) {
    try {
      const { state, applied } = await client.rpc(setOrchestratorRpc, { ...patch, applyTo: agent.id });
      orchestrator = state;
      agents.forEach(renderOrchestratorPill);
      notify(client.i18n.t(messages, `orchestrator.applied.${applied}`));
    } catch (error) {
      notify(errorMessage(error));
    }
  }

  function roleMenu(
    agent: ObservedAgent,
    role: "planner" | "executor",
    families: readonly ModelFamily[],
    saved: string | null,
    overrideAccountId?: string,
  ): PluginButtonMenuEntry<PluginText>[] {
    const scope = overrideAccountId ? { accountId: overrideAccountId } : {};
    const entries: PluginButtonMenuEntry<PluginText>[] = families.map((family) => {
      const choose = (label: string) => ({
        kind: "action" as const,
        onPress: () => chooseOrchestrator(agent, { ...scope, [role]: label }),
      });
      const chosen = family.variants.some((variant) => variant.label === saved);
      const missing = !family.accounts.includes(agent.account);
      if (family.variants.length === 1) {
        const only = family.variants[0]!;
        return {
          kind: "item",
          id: family.id,
          title: only.label,
          icon: chosen ? "Check" : BLANK_ICON,
          disabled: missing,
          behavior: choose(only.label),
        };
      }
      return {
        kind: "item",
        id: family.id,
        title: family.label,
        icon: chosen ? "Check" : BLANK_ICON,
        disabled: missing,
        behavior: {
          kind: "menu",
          items: family.variants.map((variant) => ({
            kind: "item" as const,
            id: variant.id,
            title: variant.effort || variant.label,
            icon: variant.label === saved ? "Check" : BLANK_ICON,
            behavior: choose(variant.label),
          })),
        },
      };
    });
    entries.push({ kind: "separator", id: `${role}-separator` });
    entries.push({
      kind: "item",
      id: `${role}-default`,
      title: messages.message("orchestrator.default"),
      icon: saved ? BLANK_ICON : "Check",
      behavior: { kind: "action", onPress: () => chooseOrchestrator(agent, { ...scope, [role]: null }) },
    });
    return entries;
  }

  function renderOrchestratorPill(agent: ObservedAgent) {
    if (!agent.workspace || !isOrchestratorModel(agent.model) || !orchestrator) {
      orchestratorPills.get(agent.id)?.remove();
      orchestratorPills.delete(agent.id);
      return;
    }
    const state = orchestrator;
    const { isOverride, savedPlanner, savedExecutor, effectivePlanner, effectiveExecutor } = effectiveOrchestrator(agent, state);
    const overrideAccountId = isOverride ? agent.account : undefined;
    let label: PluginText;
    if (effectivePlanner && effectiveExecutor) {
      label = `${shortModelLabel(effectivePlanner)} / ${shortModelLabel(effectiveExecutor)}`;
    } else if (effectivePlanner) {
      label = shortModelLabel(effectivePlanner);
    } else if (effectiveExecutor) {
      label = `${client.i18n.t(messages, "orchestrator.pillDefault")} / ${shortModelLabel(effectiveExecutor)}`;
    } else {
      label = messages.message("orchestrator.pillDefault");
    }

    const menuItems: PluginButtonMenuEntry<PluginText>[] = [
      {
        kind: "item",
        id: "planner",
        title: messages.message("orchestrator.planner"),
        icon: "Sparkles",
        behavior: { kind: "menu", items: roleMenu(agent, "planner", state.planners, savedPlanner, overrideAccountId) },
      },
      {
        kind: "item",
        id: "executor",
        title: messages.message("orchestrator.executor"),
        icon: "Cpu",
        behavior: { kind: "menu", items: roleMenu(agent, "executor", state.executors, savedExecutor, overrideAccountId) },
      },
      { kind: "separator", id: "separator" },
      {
        kind: "item",
        id: "manage",
        title: messages.message("orchestrator.manage"),
        icon: "Settings2",
        behavior: { kind: "action", onPress: () => client.openScreen({ screenId: "accounts" }) },
      },
    ];

    const button: PluginButton<PluginText> = {
      icon: "Workflow",
      title: isOverride ? messages.message("orchestrator.pillOverride") : messages.message("orchestrator.pillTitle"),
      label,
      behavior: { kind: "menu", items: menuItems },
    };
    const pill = orchestratorPills.get(agent.id);
    if (pill) pill.update(button);
    else {
      orchestratorPills.set(
        agent.id,
        client.addComposerPill({ id: "orchestrator", agentId: agent.id, workspaceId: agent.workspace, button }),
      );
    }
  }

  async function readOrchestrator(refresh = false) {
    try {
      orchestrator = await client.rpc(getOrchestratorRpc, { refresh });
      agents.forEach(renderOrchestratorPill);
    } catch (error) {
      if (!lifetime.signal.aborted) console.warn("[antigravity-accounts] orchestrator settings unavailable", error);
    }
  }
  void readOrchestrator();
  const orchestratorTimer = setInterval(() => void readOrchestrator(), 10 * 60_000);

  const pendingTaskAgents = new Set<string>();
  const readingTasks = new Map<string, number>();
  const confirmAfterSwitch = new Set<string>();
  async function refreshTasks(ids: Iterable<string>) {
    for (const batch of chunk([...new Set(ids)], POLL_BATCH_SIZE)) {
      if (lifetime.signal.aborted) return;
      const startGen = new Map<string, number>();
      for (const id of batch) {
        if (!agents.has(id)) continue;
        const gen = sessionGen.get(id) ?? 0;
        if (readingTasks.get(id) === gen) {
          pendingTaskAgents.add(id);
        } else {
          readingTasks.set(id, gen);
          startGen.set(id, gen);
          pendingTaskAgents.delete(id);
        }
      }
      if (!startGen.size) continue;
      const agentIds = [...startGen.keys()];
      const response = await client.rpc(agentTasksRpc, { agentIds }).catch(() => null);
      if (lifetime.signal.aborted) return;
      const retry: string[] = [];
      for (const [id, gen] of startGen) {
        if (readingTasks.get(id) !== gen) continue;
        readingTasks.delete(id);
        const agent = agents.get(id);
        if (!agent || (sessionGen.get(id) ?? 0) !== gen) continue;
        const snapshot = response?.tasks[id];
        if (snapshot !== undefined && !response?.unavailable?.includes(id)) {
          // The first RPC may join a host refresh already in flight at the switch.
          // Confirm a nonempty result once that shared refresh has completed.
          if (confirmAfterSwitch.delete(id) && snapshot !== null) {
            pendingTaskAgents.add(id);
          } else {
            const previous = tasksStore.get(id);
            tasksStore.set(id, snapshot);
            if (previous !== tasksStore.get(id)) renderTasksPill(agent);
          }
        }
        if (pendingTaskAgents.delete(id)) retry.push(id);
      }
      if (retry.length) void refreshTasks(retry);
    }
  }

  let tasksTimer: Timer | undefined;
  function syncTasksSoon() {
    if (tasksTimer !== undefined || lifetime.signal.aborted) return;
    tasksTimer = setTimeout(() => {
      tasksTimer = undefined;
      void refreshTasks([...agents.values()].filter((agent) => agent.workspace).map((agent) => agent.id));
    }, 400);
  }

  let polling = false;
  async function pollContext(forceAll = false) {
    const now = Date.now();
    const due: string[] = [];
    for (const agent of agents.values()) {
      if (!agent.workspace) continue;
      const prev = lastPolledAt.get(agent.id) ?? 0;
      const hasRunningSubagents = (subagentCounts.get(agent.id)?.running ?? 0) > 0;
      if (forceAll || agent.running || hasRunningSubagents || prev === 0 || now - prev >= IDLE_POLL_MS) {
        due.push(agent.id);
      }
    }
    if (polling || lifetime.signal.aborted || due.length === 0) return;
    void refreshTasks(due);
    polling = true;
    try {
      for (const batch of chunk(due, POLL_BATCH_SIZE)) {
        if (lifetime.signal.aborted) break;
        const startGen = new Map(batch.map(id => [id, sessionGen.get(id) ?? 0]));
        const [contextRes, subagentRes] = await Promise.all([
          client.rpc(contextUsageRpc, { agentIds: batch }),
          client.rpc(subagentCountsRpc, { agentIds: batch }).catch(() => null),
        ]);
        if (lifetime.signal.aborted) break;
        for (const id of batch) {
          // Guard against writing back to agents that were archived or removed while the RPC was in flight.
          const agent = agents.get(id);
          if (!agent || (sessionGen.get(id) ?? 0) !== startGen.get(id)) continue;
          lastPolledAt.set(id, Date.now());
          const isNative = contextRes.native.includes(id);
          if (isNative) nativeContext.add(id);
          else nativeContext.delete(id);
          contextStore.set(id, contextRes.usage[id] ?? null, isNative);
          // Only overwrite subagent counts when the RPC succeeded, avoiding flicker on transient failures.
          if (subagentRes) {
            const found = subagentRes.counts[id];
            if (found) subagentCounts.set(id, found);
            else subagentCounts.delete(id);
          }
          renderContextPill(agent);
          renderSubagentPill(agent);
        }
      }
      publishWorkspaceSubagents();
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
    // Refresh Orchestrator model lists whenever account membership, sign-in state, or overrides change.
    const nextSignature = next.accounts
      .map((a) => `${a.id}:${a.status}:${a.email ?? ""}:${JSON.stringify(a.orchestratorOverride)}`)
      .join("|");
    if (accountSignature && nextSignature !== accountSignature) {
      void readOrchestrator(true);
    }
    accountSignature = nextSignature;
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

  function publishAgents() {
    const nextCounts = new Map<string, number>();
    const nextMembers: ObservedAgent[] = [];
    for (const member of agents.values()) {
      nextMembers.push(member);
      nextCounts.set(member.account, (nextCounts.get(member.account) ?? 0) + 1);
    }
    counts = nextCounts;
    memberSnapshot = nextMembers;
    publishWorkspaceSubagents();
    emit();
  }

  function remove(id: string) {
    if (agents.has(id)) sessionGen.set(id, (sessionGen.get(id) ?? 0) + 1);
    confirmAfterSwitch.delete(id);
    pendingTaskAgents.delete(id);
    accountPills.get(id)?.remove();
    accountPills.delete(id);
    contextPills.get(id)?.remove();
    contextPills.delete(id);
    subagentPills.get(id)?.remove();
    subagentPills.delete(id);
    tasksPills.get(id)?.remove();
    tasksPills.delete(id);
    orchestratorPills.get(id)?.remove();
    orchestratorPills.delete(id);
    subagentCounts.delete(id);
    lastPolledAt.delete(id);
    nativeContext.delete(id);
    contextStore.delete(id);
    tasksStore.delete(id);
    agents.delete(id);
  }

  function upsert(row: AgentRow) {
    if (row.archivedAt || !isAntigravityProvider(row.provider)) return remove(row.id);
    const member: ObservedAgent = {
      id: row.id,
      sessionKey: persistenceSessionKey(row.persistence),
      workspace: row.workspaceId ?? null,
      account: accountIdFromMetadata(row.metadata),
      running: row.status === "running" || row.status === "initializing",
      model: row.model ?? null,
      title: row.title ?? null,
    };
    const old = agents.get(row.id);
    const sessionChanged = old !== undefined && old.sessionKey !== member.sessionKey;
    // A status change usually means a turn started or ended: context changes then.
    if (!old || sessionChanged || old.running !== member.running) {
      lastPolledAt.delete(row.id);
      pollSoon();
    }
    if (
      old &&
      !sessionChanged &&
      old.workspace === member.workspace &&
      old.account === member.account &&
      old.running === member.running &&
      old.model === member.model &&
      old.title === member.title
    ) {
      return;
    }
    if (old && old.workspace !== member.workspace) remove(row.id);
    agents.set(row.id, member);
    if (sessionChanged) {
      sessionGen.set(row.id, (sessionGen.get(row.id) ?? 0) + 1);
      confirmAfterSwitch.add(row.id);
      tasksStore.delete(row.id);
    }
    renderTasksPill(member);
    if (sessionChanged) void refreshTasks([row.id]);
    renderAccountPill(member);
    renderContextPill(member);
    renderSubagentPill(member);
    renderOrchestratorPill(member);
  }

  let reconnect: Timer | undefined;
  async function subscribeToAgents() {
    const options = { subscribe: {}, signal: lifetime.signal };
    try {
      const { subscription } = await client.paseo.agents.list({ ...options, filter: { includeBackground: true } });
      return { subscription, includeBackground: true };
    } catch (error) {
      if (lifetime.signal.aborted || !isUnsupportedBackgroundFilterError(error)) throw error;
      const { subscription } = await client.paseo.agents.list(options);
      return { subscription, includeBackground: false };
    }
  }

  async function observe() {
    try {
      const { subscription, includeBackground } = await subscribeToAgents();
      if (lifetime.signal.aborted) return;
      let snapshotGen = 0;
      let paging: { gen: number; touched: Set<string>; removed: Set<string> } | null = null;
      subscription.subscribe({
        async snapshot({ entries, pageInfo }) {
          if (lifetime.signal.aborted) return;
          const gen = ++snapshotGen;
          const seenIds = new Set(entries.map(({ agent }) => agent.id));
          entries.forEach(({ agent }) => upsert(agent));
          if (!pageInfo?.hasMore || !pageInfo.nextCursor) {
            paging = null;
            for (const id of agents.keys()) if (!seenIds.has(id)) remove(id);
            publishAgents();
            return;
          }
          const activePaging = { gen, touched: new Set<string>(), removed: new Set<string>() };
          paging = activePaging;
          publishAgents();
          const current = () => snapshotGen === activePaging.gen && !lifetime.signal.aborted;
          const seenCursors = new Set<string>();
          let cursor = pageInfo.nextCursor;
          let filtered = includeBackground;
          try {
            while (current()) {
              if (seenCursors.has(cursor)) throw new Error("Repeated agent directory cursor");
              seenCursors.add(cursor);
              const options = { page: { limit: 200, cursor }, signal: lifetime.signal };
              let page;
              try {
                page = await client.paseo.agents.list(filtered ? { ...options, filter: { includeBackground: true } } : options);
              } catch (error) {
                if (!current() || !filtered || !isUnsupportedBackgroundFilterError(error)) throw error;
                filtered = false;
                page = await client.paseo.agents.list(options);
              }
              if (!current()) return;
              for (const { agent } of page.entries) {
                seenIds.add(agent.id);
                if (!activePaging.touched.has(agent.id) && !activePaging.removed.has(agent.id)) upsert(agent);
              }
              if (!page.pageInfo.hasMore) break;
              if (!page.pageInfo.nextCursor) throw new Error("Missing agent directory cursor");
              cursor = page.pageInfo.nextCursor;
            }
            if (!current()) return;
            for (const id of agents.keys()) if (!seenIds.has(id) && !activePaging.touched.has(id)) remove(id);
          } catch (error) {
            if (!current()) return;
            console.warn("[antigravity-accounts] agent directory pagination failed", error);
          } finally {
            if (paging === activePaging) {
              paging = null;
              if (current()) publishAgents();
            }
          }
        },
        update(message) {
          if (lifetime.signal.aborted || message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "remove") {
            paging?.removed.add(update.agentId);
            paging?.touched.delete(update.agentId);
            remove(update.agentId);
          } else {
            paging?.touched.add(update.agent.id);
            paging?.removed.delete(update.agent.id);
            upsert(update.agent);
          }
          publishAgents();
        },
      });
    } catch (error) {
      if (lifetime.signal.aborted) return;
      console.warn("[antigravity-accounts] agent observation unavailable", error);
      reconnect = setTimeout(observe, 5000);
    }
  }
  void observe();

  // ---- /account & /orchestrator -------------------------------------------------------------

  const slashAccount = client.addSlashCommand({
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
        const curAccount = list.find((account) => account.id === current);
        return notify(
          client.i18n.t(messages, "choices", {
            label: curAccount ? nameOf(curAccount.label, curAccount.kind) : current,
            list: list
              .map((account, index) => {
                const quota = compactQuotaSummary(account, agent.model, client.i18n.locale);
                const extras = [account.note, quota].filter(Boolean).join(" · ");
                return `${index + 1}. ${nameOf(account.label, account.kind)}${extras ? ` (${extras})` : ""}`;
              })
              .join("\n"),
          }),
        );
      }
      const named = (account: AccountSummary) => nameOf(account.label, account.kind).toLowerCase();
      let matches = list.filter((account) => named(account) === input || account.label.toLowerCase() === input);
      if (/^\d+$/.test(input)) matches = list.slice(Number(input) - 1, Number(input));
      else if (!matches.length) matches = list.filter((account) => named(account).startsWith(input));
      if (matches.length !== 1) return notify(client.i18n.t(messages, matches.length ? "ambiguous" : "noMatch"));
      const target = matches[0]!;
      if (!target.usable || target.status === "signed-out") {
        return notify(target.statusDetail || client.i18n.t(messages, "unusable"));
      }
      const busy = agent.status === "running" || agent.status === "initializing";
      await switchTo(agent.id, target, busy ? "after-turn" : "now");
    },
  });

  const slashOrchestrator = client.addSlashCommand({
    name: "orchestrator",
    context: "agent",
    description: messages.message("orchestrator.slash"),
    argumentHint: messages.message("orchestrator.slashHint"),
    async onSubmit({ agent, args }) {
      if (!isAntigravityProvider(agent.provider)) return notify(client.i18n.t(messages, "only"));
      const state = await client.rpc(getOrchestratorRpc, {});
      orchestrator = state;
      const member = agents.get(agent.id) ?? {
        id: agent.id,
        sessionKey: null,
        workspace: agent.workspaceId ?? null,
        account: accountIdFromMetadata(agent.metadata),
        running: agent.status === "running" || agent.status === "initializing",
        model: agent.model ?? null,
        title: agent.title ?? null,
      };
      const input = args.trim();
      if (!input) {
        const eff = effectiveOrchestrator(member, state);
        return notify(
          client.i18n.t(messages, "orchestrator.slashCurrent", {
            planner: eff.savedPlanner ?? client.i18n.t(messages, "orchestrator.default"),
            executor: eff.savedExecutor ?? client.i18n.t(messages, "orchestrator.default"),
          }),
        );
      }
      const lower = input.toLowerCase();
      const presets = resolvePresets(state);
      const preset = presets.find((p) => p.id === lower);
      if (preset) {
        await chooseOrchestrator(member, { planner: preset.planner, executor: preset.executor });
        return;
      }
      const [first, ...rest] = input.split(/\s+/);
      const role = first?.toLowerCase() === "planner" || first?.toLowerCase() === "executor" ? (first.toLowerCase() as "planner" | "executor") : null;
      const query = (role ? rest.join(" ") : input).trim().toLowerCase();
      const findVariant = (families: readonly ModelFamily[]) => {
        if (query === "default" || query === "reset") return null;
        for (const family of families) {
          for (const variant of family.variants) {
            if (
              variant.label.toLowerCase() === query ||
              variant.id.toLowerCase() === query ||
              shortModelLabel(variant.label).toLowerCase() === query
            ) {
              return variant.label;
            }
          }
        }
        for (const family of families) {
          for (const variant of family.variants) {
            if (variant.label.toLowerCase().includes(query) || variant.id.toLowerCase().includes(query)) {
              return variant.label;
            }
          }
        }
        return undefined;
      };
      if (role) {
        const picked = findVariant(role === "planner" ? state.planners : state.executors);
        if (picked === undefined) return notify(client.i18n.t(messages, "orchestrator.slashNoMatch"));
        await chooseOrchestrator(member, { [role]: picked });
        return;
      }
      const asPlanner = findVariant(state.planners);
      if (asPlanner !== undefined) {
        await chooseOrchestrator(member, { planner: asPlanner });
        return;
      }
      const asExecutor = findVariant(state.executors);
      if (asExecutor !== undefined) {
        await chooseOrchestrator(member, { executor: asExecutor });
        return;
      }
      notify(client.i18n.t(messages, "orchestrator.slashNoMatch"));
    },
  });

  return {
    useNotifications,
    notify,
    counts: () => counts,
    members: () => memberSnapshot,
    workspaceRunningSubagents: () => workspaceSubagents,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refreshContext: () => pollContext(true),
    /** Debounced fast sync triggered when a timeline `update_steps` call completes. */
    syncTasksSoon,
    /** Settings changed elsewhere (the console screen): redraw the Orchestrator pills. */
    setOrchestrator(state: OrchestratorState) {
      orchestrator = state;
      agents.forEach(renderOrchestratorPill);
    },
    stop() {
      lifetime.abort();
      clearTimeout(retry);
      clearTimeout(reconnect);
      clearTimeout(soon);
      clearTimeout(tasksTimer);
      pendingTaskAgents.clear();
      confirmAfterSwitch.clear();
      readingTasks.clear();
      clearInterval(contextTimer);
      clearInterval(orchestratorTimer);
      slashAccount();
      slashOrchestrator();
      accountPills.forEach((pill) => pill.remove());
      contextPills.forEach((pill) => pill.remove());
      subagentPills.forEach((pill) => pill.remove());
      tasksPills.forEach((pill) => pill.remove());
      orchestratorPills.forEach((pill) => pill.remove());
      accountPills.clear();
      contextPills.clear();
      subagentPills.clear();
      tasksPills.clear();
      orchestratorPills.clear();
      subagentCounts.clear();
      lastPolledAt.clear();
      sessionGen.clear();
      agents.clear();
      listeners.clear();
      presenters.clear();
      contextStore.clear();
      tasksStore.clear();
      pendingNotice = undefined;
    },
  };
}

export type AgentObservation = ReturnType<typeof observeAgents>;
