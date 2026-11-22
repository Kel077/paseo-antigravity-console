import type { PluginClientContext } from "@getpaseo/plugin/client";
import {
  SUBAGENT_LIST_TIMELINE_KIND,
  SUBAGENT_TIMELINE_KIND,
  type SubagentCard,
  type SubagentCheck,
} from "../shared/contracts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** agy logs live under `<home>/.gemini/antigravity-cli/brain/<conversation>/`. */
const AGY_LOG = /[/\\]brain[/\\][0-9a-f-]{36}[/\\]/i;

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The JSON list `manage_subagents` prints after "You have N active subagent(s):". */
function listedStates(output: unknown): SubagentCheck["states"] {
  if (typeof output !== "string") return [];
  const start = output.indexOf("[");
  const end = output.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  try {
    const parsed: unknown = JSON.parse(output.slice(start, end + 1));
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const record = entry as { conversationId?: unknown; role?: unknown; state?: unknown };
      if (typeof record.conversationId !== "string") return [];
      return [
        {
          id: record.conversationId,
          role: typeof record.role === "string" ? record.role : null,
          state: typeof record.state === "string" ? normalizeState(record.state) : "idle",
        },
      ];
    });
  } catch {
    return [];
  }
}

function normalizeState(state: string): string {
  const value = state.toLowerCase();
  if (value === "running" || value === "active") return "running";
  // agy reports a subagent that ended its turn as `idle`: in a check, that is a finished one.
  if (value === "completed" || value === "done" || value === "finished" || value === "idle") return "done";
  if (value === "killed" || value === "canceled" || value === "cancelled" || value === "stopped") return "stopped";
  if (value === "failed" || value === "error") return "failed";
  return value;
}

/** Ids and roles a `kill` call names. */
function killedStates(input: unknown, output: unknown): SubagentCheck["states"] {
  const record = (input && typeof input === "object" ? input : {}) as { ConversationIds?: unknown };
  const ids = Array.isArray(record.ConversationIds)
    ? record.ConversationIds.filter((id): id is string => typeof id === "string")
    : [];
  const roles =
    typeof output === "string" ? (/Killed roles:\s*([^\n]+)/.exec(output)?.[1] ?? "").split(/,\s*/).filter(Boolean) : [];
  const count = Math.max(ids.length, roles.length);
  return Array.from({ length: count }, (_, index) => ({
    id: ids[index] ?? `#${index + 1}`,
    role: roles[index] ?? null,
    state: "stopped",
  }));
}

/**
 * Antigravity's own subagent rows: `invoke_subagent` becomes a live card of the child it started,
 * and `manage_subagents` becomes a one-line summary.
 */
export function registerSubagentTransforms(client: PluginClientContext) {
  return client.addTimelineTransformer({
    id: "antigravity-subagents",
    query: { itemType: "tool_call" },
    transform({ item }) {
      const status = item.status;
      if (item.name === "invoke_subagent" && item.detail.type === "sub_agent") {
        const detail = item.detail;
        const childId = detail.childSessionId && UUID.test(detail.childSessionId) ? detail.childSessionId : "";
        // Only agy's subagents: other providers have their own subagent views.
        if (childId && detail.log && !AGY_LOG.test(detail.log)) return undefined;
        const data: SubagentCard = {
          id: childId,
          type: detail.subAgentType ?? null,
          task: cut((detail.description ?? "").trim(), 600),
          status,
        };
        return { items: [{ type: "plugin", kind: SUBAGENT_TIMELINE_KIND, version: 1, data }] };
      }
      if (item.name === "manage_subagents" && item.detail.type === "unknown") {
        const input = item.detail.input as { Action?: unknown } | null;
        const action = typeof input?.Action === "string" ? input.Action : "";
        if (!action) return undefined;
        const states =
          action === "kill" ? killedStates(item.detail.input, item.detail.output) : listedStates(item.detail.output);
        const data: SubagentCheck = { action, states, status };
        return { items: [{ type: "plugin", kind: SUBAGENT_LIST_TIMELINE_KIND, version: 1, data }] };
      }
      return undefined;
    },
  });
}
