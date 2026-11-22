import fs from "node:fs/promises";
import path from "node:path";
import type { PaseoApi } from "./types";
import type {
  SubagentDetail,
  SubagentList,
  SubagentState,
  SubagentSummary,
  TranscriptEntry,
} from "../shared/contracts";
import type { ContextReader } from "./context";
import { REAL_CLI_DIR } from "./paths";

/**
 * agy runs subagents as conversations of their own. Every conversation keeps a JSON-lines log at
 * `brain/<id>/.system_generated/logs/transcript.jsonl` (agy hands the same path to the parent model).
 * A parent's log holds each `invoke_subagent` call and the id of the conversation it created; a
 * child reports back with `send_message`, which lands in the parent's `messages/` folder.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CREATED_ID = /Created the following subagent:[\s\S]*?"conversationId"\s*:\s*"([0-9a-f-]{36})"/i;
const TIME_HEADER = /^(?:(?:Created|Completed) At: [^\n]*\n)+/;
/** A child with no new step for this long is no longer running, whatever its last step says. */
const STALE_MS = 12 * 60_000;
const MAX_DEPTH = 3;
const MAX_ENTRIES = 300;
/** Step states agy may still rewrite in place. */
const UNFINISHED = new Set(["RUNNING", "PENDING", "GENERATING", "WAITING", "QUEUED"]);
/** How far back an unfinished step is looked for when resuming a read. */
const RESUME_WINDOW = 64;

interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

interface Row {
  step_index: number;
  source?: string;
  type?: string;
  status?: string;
  created_at?: string;
  content?: string;
  thinking?: string;
  tool_calls?: ToolCall[];
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
}

interface Child {
  id: string;
  role: string | null;
  type: string | null;
  task: string;
  /** Set when the parent stopped it with `manage_subagents` (`kill`). */
  killedAt: string | null;
}

interface CachedLog {
  size: number;
  mtimeMs: number;
  rows: Row[];
  /** Byte offset where each row's line starts. */
  starts: number[];
}

function logPath(conversationId: string): string {
  return path.join(REAL_CLI_DIR, "brain", conversationId, ".system_generated", "logs", "transcript.jsonl");
}

function inboxDir(conversationId: string): string {
  return path.join(REAL_CLI_DIR, "brain", conversationId, ".system_generated", "messages");
}

/**
 * Tool arguments are JSON-encoded strings in the log (`"Role": "\"Auditor\""`). Long values are
 * cut short by agy, which leaves an unterminated JSON string; those are decoded leniently.
 */
function argValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (!text || !/^["[{]|^(true|false|null|-?\d)/.test(text)) return value;
  try {
    return JSON.parse(text);
  } catch {
    if (!text.startsWith('"')) return value;
    const body = text.slice(1).replace(/\\$/, "");
    try {
      return JSON.parse(`"${body}"`);
    } catch {
      return body.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
  }
}

function argText(call: ToolCall, key: string): string | null {
  const value = argValue(call.args?.[key]);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function oneLine(text: string, max = 140): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

const SUMMARY_KEYS = [
  "toolSummary",
  "CommandLine",
  "Path",
  "AbsolutePath",
  "TargetFile",
  "File",
  "DirectoryPath",
  "SearchPath",
  "Query",
  "Pattern",
  "Url",
  "Role",
  "Action",
];

export function describeCall(call: ToolCall): string {
  const pathLike = new Set(["Path", "AbsolutePath", "TargetFile", "File", "DirectoryPath", "SearchPath"]);
  for (const key of SUMMARY_KEYS) {
    const value = argText(call, key);
    if (!value) continue;
    if (pathLike.has(key)) {
      const start = argText(call, "StartLine");
      const end = argText(call, "EndLine");
      const range = start && end ? ` ${start}–${end}` : "";
      return oneLine(`${path.basename(value)}${range}`);
    }
    return oneLine(value);
  }
  for (const value of Object.values(call.args ?? {})) {
    const parsed = argValue(value);
    if (typeof parsed === "string" && parsed.trim()) return oneLine(parsed);
  }
  return "";
}

function stripTimes(text: string): string {
  return text.replace(TIME_HEADER, "").trim();
}

function clip(text: string | null | undefined, max: number): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/** The text of a message, without agy's `<SYSTEM_MESSAGE>` or `<USER_REQUEST>` wrapper. */
function messageBody(content: string): string {
  if (content.includes("<SYSTEM_MESSAGE>")) {
    const inner = /content=([\s\S]*?)(?:<\/SYSTEM_MESSAGE>|$)/.exec(content)?.[1];
    if (inner !== undefined) return inner.trim();
  }
  const request = /<USER_REQUEST>([\s\S]*?)(?:<\/USER_REQUEST>|$)/.exec(content)?.[1];
  return (request ?? content).trim();
}

/** Whether a conversation's first message came from `parentId` (agy names the sender). */
function sentBy(rows: readonly Row[], parentId: string): boolean | null {
  const first = rows.find((row) => row.type === "SYSTEM_MESSAGE" || row.type === "USER_INPUT");
  if (!first?.content) return null;
  return first.content.includes(`sender=${parentId}`);
}

/** Roles and types `manage_subagents` listed, by conversation id. */
function listedRoles(content: string): Map<string, { role: string | null; type: string | null }> {
  const result = new Map<string, { role: string | null; type: string | null }>();
  const start = content.indexOf("[");
  const end = content.lastIndexOf("]");
  if (start < 0 || end <= start) return result;
  try {
    const entries: unknown = JSON.parse(content.slice(start, end + 1));
    for (const entry of Array.isArray(entries) ? entries : []) {
      const record = entry as { conversationId?: unknown; role?: unknown; type?: unknown };
      if (typeof record.conversationId !== "string") continue;
      result.set(record.conversationId, {
        role: typeof record.role === "string" ? record.role : null,
        type: typeof record.type === "string" ? record.type : null,
      });
    }
  } catch {
    // Not a list.
  }
  return result;
}

export class SubagentReader {
  private readonly logs = new Map<string, CachedLog>();
  private readonly listCache = new Map<string, { at: number; value: SubagentList }>();

  constructor(private readonly agents: ContextReader) {}

  /**
   * Reads a conversation log incrementally. agy appends a line per step and rewrites a step's line
   * while it runs, so reading resumes at the earliest step that may still change.
   */
  private async rows(conversationId: string): Promise<{ rows: Row[]; mtimeMs: number } | null> {
    const file = logPath(conversationId);
    const stat = await fs.stat(file).catch(() => null);
    if (!stat?.isFile()) return null;
    const cached = this.logs.get(file);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
      return { rows: cached.rows, mtimeMs: stat.mtimeMs };
    }
    let keep = 0;
    if (cached?.rows.length) {
      keep = cached.rows.length - 1;
      for (let index = Math.max(0, cached.rows.length - RESUME_WINDOW); index < cached.rows.length; index += 1) {
        if (UNFINISHED.has(cached.rows[index]!.status ?? "")) {
          keep = index;
          break;
        }
      }
    }
    const offset = cached?.rows.length ? cached.starts[keep]! : 0;
    const parsed = await readRows(file, offset, stat.size);
    // The first line read must be the step it resumes at; anything else means the file was rewritten.
    const aligned =
      !cached?.rows.length || (parsed !== null && parsed.rows[0]?.step_index === cached.rows[keep]!.step_index);
    const next: CachedLog = aligned && parsed
      ? {
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          rows: [...(cached?.rows.slice(0, keep) ?? []), ...parsed.rows],
          starts: [...(cached?.starts.slice(0, keep) ?? []), ...parsed.starts],
        }
      : { size: stat.size, mtimeMs: stat.mtimeMs, ...((await readRows(file, 0, stat.size)) ?? { rows: [], starts: [] }) };
    dedupe(next);
    this.logs.set(file, next);
    return { rows: next.rows, mtimeMs: stat.mtimeMs };
  }

  /**
   * The children a conversation created, with the role and task it gave each. Each tool call of a
   * response gets one result line, in call order, before the next response; an `invoke_subagent`
   * result names the conversation it created.
   */
  private async children(conversationId: string): Promise<Child[]> {
    const log = await this.rows(conversationId);
    if (!log) return [];
    const found: Child[] = [];
    const killed = new Map<string, string | null>();
    const listed = new Map<string, { role: string | null; type: string | null }>();
    let queue: ToolCall[] = [];
    for (const row of log.rows) {
      if (row.type === "PLANNER_RESPONSE") {
        // A result that never arrived must not shift the next response's pairing.
        queue = [...(row.tool_calls ?? [])];
        for (const call of queue) {
          if (call.name !== "manage_subagents" || argText(call, "Action") !== "kill") continue;
          const ids = argValue(call.args?.ConversationIds);
          for (const id of Array.isArray(ids) ? ids : []) {
            if (typeof id === "string") killed.set(id, row.created_at ?? null);
          }
        }
        continue;
      }
      if (row.type !== "GENERIC") continue;
      const call = queue.shift();
      if (!call || !row.content) continue;
      if (call.name === "manage_subagents") {
        for (const [id, entry] of listedRoles(row.content)) listed.set(id, entry);
        continue;
      }
      if (call.name !== "invoke_subagent") continue;
      const id = CREATED_ID.exec(row.content)?.[1];
      if (!id || !UUID.test(id) || found.some((child) => child.id === id)) continue;
      found.push({
        id,
        role: argText(call, "Role"),
        type: argText(call, "TypeName"),
        task: argText(call, "Prompt") ?? "",
        killedAt: null,
      });
    }
    for (const child of found) {
      if (killed.has(child.id)) child.killedAt = killed.get(child.id) ?? "";
      const entry = listed.get(child.id);
      child.role ??= entry?.role ?? null;
      child.type ??= entry?.type ?? null;
    }
    return found;
  }

  /** Messages a conversation received, by sender. */
  private async reports(conversationId: string): Promise<Map<string, { at: string | null; content: string }>> {
    const result = new Map<string, { at: string | null; content: string }>();
    const dir = inboxDir(conversationId);
    const names = await fs.readdir(dir).catch(() => [] as string[]);
    for (const name of names) {
      if (!name.endsWith(".json") || name === "read.json") continue;
      try {
        const message = JSON.parse(await fs.readFile(path.join(dir, name), "utf8")) as {
          sender?: unknown;
          timestamp?: unknown;
          content?: unknown;
        };
        if (typeof message.sender !== "string" || typeof message.content !== "string") continue;
        const at = typeof message.timestamp === "string" ? message.timestamp : null;
        const previous = result.get(message.sender);
        if (!previous || (at && (!previous.at || at > previous.at))) {
          result.set(message.sender, { at, content: message.content });
        }
      } catch {
        // Not a message file.
      }
    }
    return result;
  }

  private async summarize(
    child: Child,
    parentId: string,
    depth: number,
    reported: { at: string | null; content: string } | undefined,
    parentClosed: boolean,
  ): Promise<SubagentSummary> {
    const log = await this.rows(child.id);
    const rows = log?.rows ?? [];
    let tools = 0;
    let input = 0;
    let output = 0;
    let cached = 0;
    let model: string | null = null;
    let lastCall: ToolCall | null = null;
    for (const row of rows) {
      tools += row.tool_calls?.length ?? 0;
      input += row.input_tokens ?? 0;
      output += row.output_tokens ?? 0;
      cached += row.cache_read_tokens ?? 0;
      if (row.model) model = row.model;
      const calls = row.tool_calls ?? [];
      if (calls.length) lastCall = calls[calls.length - 1]!;
    }
    const last = rows[rows.length - 1];
    const dbStat = await fs
      .stat(path.join(REAL_CLI_DIR, "conversations", `${child.id}.db-wal`))
      .catch(() => fs.stat(path.join(REAL_CLI_DIR, "conversations", `${child.id}.db`)).catch(() => null));
    const touched = Math.max(log?.mtimeMs ?? 0, dbStat?.mtimeMs ?? 0);
    const finalAnswer = last?.type === "PLANNER_RESPONSE" && last.status === "DONE" && !(last.tool_calls?.length);
    // A tool error is routine; an error in the model's own step ends the run.
    const failed = Boolean(last && (last.type?.includes("ERROR") || (last.status === "ERROR" && last.type !== "GENERIC")));
    let state: SubagentState;
    let phase: "thinking" | "tool" | null = null;
    if (child.killedAt !== null && !(finalAnswer && reported)) state = "stopped";
    else if (!last) state = parentClosed ? "stopped" : "running";
    else if (last.status === "CANCELED" || last.status === "INTERRUPTED") state = "stopped";
    else if (failed) state = "failed";
    else if (finalAnswer) state = reported ? "done" : parentClosed ? "stopped" : "idle";
    else {
      state = "running";
      phase = last.type === "PLANNER_RESPONSE" && last.tool_calls?.length && last.status === "DONE" ? "tool" : "thinking";
      if (last.type === "GENERIC" && last.status === "RUNNING") phase = "tool";
    }
    if (state === "running" && (parentClosed || Date.now() - touched > STALE_MS)) {
      state = "stopped";
      phase = null;
    }
    const activity =
      state === "running" && phase === "thinking"
        ? null
        : lastCall
          ? `${lastCall.name}${describeCall(lastCall) ? ` · ${describeCall(lastCall)}` : ""}`
          : null;
    return {
      id: child.id,
      parentId,
      depth,
      role: child.role,
      type: child.type,
      // The child's own first message holds the whole task; the parent's call may be cut short.
      task: oneLine(messageBody(rows.find((row) => row.type === "SYSTEM_MESSAGE")?.content ?? "") || child.task, 600),
      state,
      phase,
      activity,
      steps: rows.length,
      tools,
      model,
      inputTokens: input,
      outputTokens: output,
      cachedTokens: cached,
      startedAt: rows[0]?.created_at ?? null,
      updatedAt: last?.created_at ?? (touched ? new Date(touched).toISOString() : null),
      reportedAt: reported?.at ?? null,
    };
  }

  private async collect(
    conversationId: string,
    depth: number,
    parentClosed: boolean,
    out: SubagentSummary[],
  ): Promise<void> {
    if (depth > MAX_DEPTH) return;
    const children = await this.children(conversationId);
    if (!children.length) return;
    const inbox = await this.reports(conversationId);
    for (const child of children) {
      // Only a conversation whose first message came from this parent is its child.
      const own = await this.rows(child.id);
      if (own && sentBy(own.rows, conversationId) === false) continue;
      const summary = await this.summarize(child, conversationId, depth, inbox.get(child.id), parentClosed);
      out.push(summary);
      await this.collect(child.id, depth + 1, parentClosed || summary.state === "stopped", out);
    }
  }

  async list(paseo: PaseoApi, agentId: string): Promise<SubagentList> {
    const cached = this.listCache.get(agentId);
    if (cached && Date.now() - cached.at < 1500) return cached.value;
    const info = await this.agents.conversationOf(paseo, agentId);
    const value: SubagentList = { conversationId: info?.conversationId ?? null, subagents: [] };
    if (info?.conversationId) {
      await this.collect(info.conversationId, 1, info.closed, value.subagents);
    }
    this.listCache.set(agentId, { at: Date.now(), value });
    return value;
  }

  async counts(paseo: PaseoApi, agentIds: readonly string[]): Promise<Record<string, { total: number; running: number }>> {
    const result: Record<string, { total: number; running: number }> = {};
    await Promise.all(
      [...new Set(agentIds)].map(async (agentId) => {
        const list = await this.list(paseo, agentId).catch(() => null);
        if (!list) return;
        result[agentId] = {
          total: list.subagents.length,
          running: list.subagents.filter((subagent) => subagent.state === "running").length,
        };
      }),
    );
    return result;
  }

  async detail(paseo: PaseoApi, agentId: string, subagentId: string): Promise<SubagentDetail> {
    const list = await this.list(paseo, agentId);
    const summary = list.subagents.find((subagent) => subagent.id === subagentId) ?? null;
    // Only conversations this agent created can be read through it.
    if (!summary) return { summary: null, entries: [], report: null, truncated: false };
    const log = await this.rows(subagentId);
    const rows = log?.rows ?? [];
    const entries: TranscriptEntry[] = [];
    const open: TranscriptEntry["tools"] = [];
    let report: string | null = null;
    for (const row of rows) {
      if (row.type === "SYSTEM_MESSAGE" || row.type === "USER_INPUT") {
        entries.push({
          index: row.step_index,
          kind: entries.length === 0 ? "task" : "message",
          at: row.created_at ?? null,
          text: clip(messageBody(row.content ?? ""), 4000),
          thinking: null,
          tools: [],
          model: null,
        });
        continue;
      }
      if (row.type === "PLANNER_RESPONSE") {
        const tools = (row.tool_calls ?? []).map((call) => {
          const recipient = argText(call, "Recipient");
          if (call.name === "send_message" && (!recipient || recipient === summary.parentId)) {
            report = argText(call, "Message") ?? report;
          }
          return { name: call.name, summary: describeCall(call), output: null, failed: false };
        });
        // Results of an interrupted response never arrive; they must not shift this one's.
        open.length = 0;
        open.push(...tools);
        entries.push({
          index: row.step_index,
          kind: "response",
          at: row.created_at ?? null,
          text: clip(row.content, 4000),
          thinking: clip(row.thinking, 1500),
          tools,
          model: row.model ?? null,
        });
        continue;
      }
      if (row.type === "GENERIC") {
        const tool = open.shift();
        if (tool) {
          tool.output = clip(stripTimes(row.content ?? ""), 1200);
          tool.failed = row.status === "ERROR";
        }
        continue;
      }
      if (row.type?.includes("ERROR")) {
        entries.push({
          index: row.step_index,
          kind: "error",
          at: row.created_at ?? null,
          text: clip(row.content, 1200),
          thinking: null,
          tools: [],
          model: null,
        });
      }
    }
    const inbox = await this.reports(summary.parentId);
    const full = inbox.get(subagentId)?.content ?? null;
    const truncated = entries.length > MAX_ENTRIES;
    const task = entries[0]?.kind === "task" ? entries[0] : null;
    return {
      summary,
      // Keep the task when only the latest steps fit.
      entries: truncated ? [...(task ? [task] : []), ...entries.slice(-(MAX_ENTRIES - 1))] : entries,
      report: full ?? report,
      truncated,
    };
  }

  forget(agentId: string): void {
    this.listCache.delete(agentId);
  }
}

/** Parses the complete lines of `file` between `from` and `to`, with each line's start offset. */
async function readRows(file: string, from: number, to: number): Promise<{ rows: Row[]; starts: number[] } | null> {
  const length = Math.max(0, to - from);
  const buffer = Buffer.alloc(length);
  const handle = await fs.open(file, "r").catch(() => null);
  if (!handle) return null;
  try {
    if (length > 0) await handle.read(buffer, 0, length, from);
  } finally {
    await handle.close();
  }
  const rows: Row[] = [];
  const starts: number[] = [];
  let start = 0;
  for (;;) {
    const newline = buffer.indexOf(0x0a, start);
    // A line without its newline is still being written: leave it for the next read.
    if (newline < 0) break;
    const line = buffer.subarray(start, newline).toString("utf8").trim();
    if (line) {
      try {
        const row = JSON.parse(line) as Row;
        if (typeof row.step_index === "number") {
          rows.push(row);
          starts.push(from + start);
        }
      } catch {
        if (rows.length === 0 && from > 0) return null;
      }
    }
    start = newline + 1;
  }
  return { rows, starts };
}

/** Keeps the newest line of a step that agy wrote more than once. */
function dedupe(log: CachedLog): void {
  const seen = new Set<number>();
  let duplicate = false;
  for (const row of log.rows) {
    if (seen.has(row.step_index)) duplicate = true;
    seen.add(row.step_index);
  }
  if (!duplicate) return;
  const rows: Row[] = [];
  const starts: number[] = [];
  const kept = new Set<number>();
  for (let index = log.rows.length - 1; index >= 0; index -= 1) {
    const row = log.rows[index]!;
    if (kept.has(row.step_index)) continue;
    kept.add(row.step_index);
    rows.unshift(row);
    starts.unshift(log.starts[index]!);
  }
  log.rows = rows;
  log.starts = starts;
}
