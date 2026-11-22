import fs from "node:fs/promises";
import path from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { isAntigravityProvider, type ContextUsage } from "../shared/contracts";
import { REAL_CLI_DIR, SHARED_CLI_DIRS } from "./paths";
import { decode, int as number, message } from "./protobuf";

/**
 * Reads context usage from agy's conversation database. Every model call stores a generation
 * record (table `gen_metadata`, protobuf). Field 1.4 holds that call's token usage:
 * 2 = new input tokens, 3 = output tokens, 5 = cache-read tokens. Field 3.13.2.22 holds the
 * model's context window. input + cache + output equals the `used` value agy reports over ACP.
 */

const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface GenerationUsage {
  input: number;
  output: number;
  cached: number;
  window: number | null;
}

function parseGeneration(data: Uint8Array): GenerationUsage | null {
  const root = decode(data);
  const usage = message(root, [1, 4]);
  if (!usage) return null;
  const input = number(usage, 2);
  const output = number(usage, 3);
  const cached = number(usage, 5);
  if (input + output + cached === 0) return null;
  const window = number(message(root, [3, 13, 2]), 22) || null;
  return { input, output, cached, window };
}

type SqliteModule = typeof import("node:sqlite");
let sqlite: Promise<SqliteModule | null> | null = null;

function loadSqlite(): Promise<SqliteModule | null> {
  sqlite ??= import("node:sqlite").catch((error: unknown) => {
    console.error("antigravity-accounts: node:sqlite is unavailable; context usage is disabled", error);
    return null;
  });
  return sqlite;
}

/** Guesses the window when agy did not record it. Gemini models in Antigravity use 1M tokens. */
function windowForModel(model: string | null): number | null {
  const name = (model ?? "").toLowerCase();
  if (name.startsWith("gemini") || name.includes("orchestrator")) return 1_048_576;
  if (name.startsWith("claude")) return 200_000;
  if (name.startsWith("gpt-oss")) return 131_072;
  return null;
}

export async function readConversationUsage(
  conversationId: string,
  model: string | null,
): Promise<ContextUsage | null> {
  if (!CONVERSATION_ID.test(conversationId)) return null;
  const conversations = path.join(REAL_CLI_DIR, SHARED_CLI_DIRS[0]);
  const file = path.join(conversations, `${conversationId}.db`);
  const stat = await fs.stat(file).catch(() => null);
  if (!stat?.isFile()) return null;
  const walStat = await fs.stat(`${file}-wal`).catch(() => null);
  const module = await loadSqlite();
  if (!module) return null;
  let db: InstanceType<SqliteModule["DatabaseSync"]> | null = null;
  try {
    // Not readOnly: a read-only handle cannot attach to agy's WAL without its -shm file.
    db = new module.DatabaseSync(file, { timeout: 1000 });
    db.exec("PRAGMA query_only = ON");
    const rows = db
      .prepare("SELECT idx, data FROM gen_metadata ORDER BY idx DESC LIMIT 12")
      .all() as Array<{ idx: number; data: Uint8Array | null }>;
    let latest: GenerationUsage | null = null;
    let window: number | null = null;
    for (const row of rows) {
      if (!row.data) continue;
      const parsed = parseGeneration(new Uint8Array(row.data));
      if (!parsed) continue;
      latest ??= parsed;
      window ??= parsed.window;
      if (latest && window) break;
    }
    if (!latest) return null;
    const guessed = windowForModel(model);
    const size = window ?? guessed;
    return {
      used: latest.input + latest.cached + latest.output,
      size,
      input: latest.input,
      cached: latest.cached,
      output: latest.output,
      sizeSource: window ? "agy" : guessed ? "model" : null,
      // agy writes through a WAL; the main file's time only moves at checkpoints.
      updatedAt: new Date(Math.max(stat.mtimeMs, walStat?.mtimeMs ?? 0)).toISOString(),
      model,
    };
  } catch (error) {
    console.error(`antigravity-accounts: could not read context usage of ${conversationId}`, error);
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // Already closed.
    }
  }
}

interface AgentInfo {
  conversationId: string | null;
  model: string | null;
  /** The provider process is not running (closed or failed). */
  closed: boolean;
  native: boolean;
  antigravity: boolean;
  fetchedAt: number;
}

const UUID_IN_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function conversationIdFrom(persistence: unknown): string | null {
  if (!persistence) return null;
  const text = JSON.stringify(persistence);
  const named = /"conversationId"\s*:\s*"([0-9a-f-]{36})"/i.exec(text)?.[1];
  if (named) return named;
  if (typeof persistence === "object") {
    const record = persistence as { sessionId?: unknown; nativeHandle?: unknown };
    for (const candidate of [record.nativeHandle, record.sessionId]) {
      if (typeof candidate === "string" && CONVERSATION_ID.test(candidate)) return candidate;
    }
  }
  return UUID_IN_TEXT.exec(text)?.[0] ?? null;
}

/** Maps agents to their agy conversations, re-reading each agent's snapshot every 20 seconds. */
export class ContextReader {
  private readonly agents = new Map<string, AgentInfo>();

  private async info(paseo: PaseoApi, agentId: string): Promise<AgentInfo | null> {
    const cached = this.agents.get(agentId);
    if (cached && Date.now() - cached.fetchedAt < 20_000) return cached;
    const refreshed = await paseo.agents
      .ref(agentId)
      .refresh()
      .catch(() => null);
    if (!refreshed) {
      this.agents.delete(agentId);
      return null;
    }
    const agent = refreshed.agent;
    const info: AgentInfo = {
      conversationId: conversationIdFrom(agent.persistence),
      model: agent.model ?? null,
      closed: agent.status === "closed" || agent.status === "error",
      native: typeof agent.lastUsage?.contextWindowMaxTokens === "number",
      antigravity: isAntigravityProvider(agent.provider),
      fetchedAt: Date.now(),
    };
    this.agents.set(agentId, info);
    return info;
  }

  async usage(
    paseo: PaseoApi,
    agentIds: readonly string[],
  ): Promise<{ usage: Record<string, ContextUsage | null>; native: string[] }> {
    const usage: Record<string, ContextUsage | null> = {};
    const native: string[] = [];
    await Promise.all(
      [...new Set(agentIds)].map(async (agentId) => {
        const info = await this.info(paseo, agentId);
        if (!info?.antigravity) {
          usage[agentId] = null;
          return;
        }
        if (info.native) native.push(agentId);
        usage[agentId] = info.conversationId
          ? await readConversationUsage(info.conversationId, info.model)
          : null;
      }),
    );
    return { usage, native };
  }

  /** The agy conversation an Antigravity agent runs, or null for other agents. */
  async conversationOf(
    paseo: PaseoApi,
    agentId: string,
  ): Promise<{ conversationId: string | null; closed: boolean } | null> {
    const info = await this.info(paseo, agentId);
    if (!info?.antigravity) return null;
    return { conversationId: info.conversationId, closed: info.closed };
  }

  forget(agentId: string): void {
    this.agents.delete(agentId);
  }
}
