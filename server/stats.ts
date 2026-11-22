import fs from "node:fs/promises";
import path from "node:path";
import type { StatsRange, UsageStats, UsageTotals } from "../shared/contracts";
import { REAL_CLI_DIR, SHARED_CLI_DIRS } from "./paths";
import { decode, int, message, seconds, text } from "./protobuf";

/**
 * Aggregates model calls from agy's conversation databases. Each generation record
 * (`gen_metadata`) carries usage (1.4: 2 input, 3 output, 5 cache reads, 7 response id),
 * time to first token (1.11) and streaming time (1.12) as Durations, and the model label (1.21).
 * The step that issued the call (`steps.metadata`, 9.7 = response id) carries its start time (1).
 */

interface Generation {
  responseId: string | null;
  label: string;
  input: number;
  cached: number;
  output: number;
  firstToken: number;
  generation: number;
}

interface CallRecord extends Generation {
  at: number;
}

interface FileCache {
  signature: string;
  lastGenIndex: number;
  generations: Generation[];
  started: Map<string, number>;
  fallback: number;
}

const RANGES: Record<StatsRange, { binMs: number; bins: number }> = {
  "24h": { binMs: 3_600_000, bins: 24 },
  "7d": { binMs: 6 * 3_600_000, bins: 28 },
  "30d": { binMs: 86_400_000, bins: 30 },
};

type SqliteModule = typeof import("node:sqlite");
let sqlite: Promise<SqliteModule | null> | null = null;

function loadSqlite(): Promise<SqliteModule | null> {
  sqlite ??= import("node:sqlite").catch(() => null);
  return sqlite;
}

function parseGeneration(data: Uint8Array): Generation | null {
  const root = decode(data);
  const request = message(root, [1]);
  const usage = message(request, [4]);
  if (!usage) return null;
  const input = int(usage, 2);
  const output = int(usage, 3);
  const cached = int(usage, 5);
  if (input + output + cached === 0) return null;
  const label =
    text(request, 21) ?? text(message(root, [3]), 28) ?? text(request, 19) ?? "Unknown model";
  return {
    responseId: text(usage, 7),
    label: label.trim() || "Unknown model",
    input,
    cached,
    output,
    firstToken: seconds(message(request, [11])),
    generation: seconds(message(request, [12])),
  };
}

function emptyTotals(): UsageTotals {
  return { requests: 0, input: 0, cached: 0, output: 0, generationSeconds: 0, firstTokenSeconds: 0 };
}

function add(totals: UsageTotals, record: CallRecord): void {
  totals.requests += 1;
  totals.input += record.input;
  totals.cached += record.cached;
  totals.output += record.output;
  totals.generationSeconds += record.generation;
  totals.firstTokenSeconds += record.firstToken;
}

/** Start of the bin containing `time`, aligned to local hours / quarter days / days. */
function binStart(time: number, binMs: number): number {
  const date = new Date(time);
  if (binMs >= 86_400_000) {
    date.setHours(0, 0, 0, 0);
  } else {
    const hours = binMs / 3_600_000;
    date.setHours(Math.floor(date.getHours() / hours) * hours, 0, 0, 0);
  }
  return date.getTime();
}

export class UsageStatsReader {
  private readonly files = new Map<string, FileCache>();
  private running: Promise<CallRecord[]> | null = null;

  private async readFile(file: string, signature: string, birth: number): Promise<FileCache | null> {
    const module = await loadSqlite();
    if (!module) return null;
    const previous = this.files.get(file);
    const cache: FileCache = previous ?? {
      signature: "",
      lastGenIndex: -1,
      generations: [],
      started: new Map(),
      fallback: birth,
    };
    let db: InstanceType<SqliteModule["DatabaseSync"]> | null = null;
    try {
      db = new module.DatabaseSync(file, { timeout: 1000 });
      db.exec("PRAGMA query_only = ON");
      // Generation records are written once per call, so only new rows need reading.
      const rows = db
        .prepare("SELECT idx, data FROM gen_metadata WHERE idx > ? ORDER BY idx")
        .all(cache.lastGenIndex) as Array<{ idx: number; data: Uint8Array | null }>;
      for (const row of rows) {
        cache.lastGenIndex = Math.max(cache.lastGenIndex, row.idx);
        if (!row.data) continue;
        const generation = parseGeneration(new Uint8Array(row.data));
        if (generation) cache.generations.push(generation);
      }
      // Steps change state while they run; their metadata is small, so re-read it all.
      const steps = db.prepare("SELECT metadata FROM steps WHERE metadata IS NOT NULL").all() as Array<{
        metadata: Uint8Array | null;
      }>;
      const started = new Map<string, number>();
      for (const step of steps) {
        const meta = decode(step.metadata ? new Uint8Array(step.metadata) : null);
        const responseId = text(message(meta, [9]), 7);
        if (!responseId) continue;
        const at = seconds(message(meta, [1]));
        if (at > 0) started.set(responseId, at * 1000);
      }
      cache.started = started;
      cache.signature = signature;
      this.files.set(file, cache);
      return cache;
    } catch (error) {
      console.error(`antigravity-accounts: could not read usage from ${path.basename(file)}`, error);
      return previous ?? null;
    } finally {
      try {
        db?.close();
      } catch {
        // Already closed.
      }
    }
  }

  private async collect(): Promise<CallRecord[]> {
    const dir = path.join(REAL_CLI_DIR, SHARED_CLI_DIRS[0]);
    let names: string[] = [];
    try {
      names = (await fs.readdir(dir)).filter((name) => /^[0-9a-f-]{36}\.db$/i.test(name));
    } catch {
      return [];
    }
    const records: CallRecord[] = [];
    const seen = new Set<string>();
    for (const name of names) {
      const file = path.join(dir, name);
      seen.add(file);
      const stat = await fs.stat(file).catch(() => null);
      if (!stat) continue;
      const wal = await fs.stat(`${file}-wal`).catch(() => null);
      const signature = `${stat.mtimeMs}:${stat.size}:${wal?.mtimeMs ?? 0}:${wal?.size ?? 0}`;
      let cache = this.files.get(file);
      if (!cache || cache.signature !== signature) {
        cache = (await this.readFile(file, signature, stat.birthtimeMs || stat.mtimeMs)) ?? undefined;
      }
      if (!cache) continue;
      // A call whose step is missing takes the time of the call before it.
      let last = cache.fallback;
      for (const generation of cache.generations) {
        const at = (generation.responseId && cache.started.get(generation.responseId)) || last;
        last = at;
        records.push({ ...generation, at });
      }
    }
    for (const file of this.files.keys()) if (!seen.has(file)) this.files.delete(file);
    return records;
  }

  private records(): Promise<CallRecord[]> {
    // Concurrent requests share one scan.
    this.running ??= this.collect().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  async summary(range: StatsRange): Promise<UsageStats> {
    const { binMs, bins: count } = RANGES[range];
    const now = Date.now();
    const lastBin = binStart(now, binMs);
    const firstBin = lastBin - (count - 1) * binMs;
    const bins = Array.from({ length: count }, (_, index) => ({ start: firstBin + index * binMs, ...emptyTotals() }));
    const totals = emptyTotals();
    const models = new Map<string, UsageTotals>();
    const records = await this.records();
    for (const record of records) {
      if (record.at < firstBin || record.at > now + 60_000) continue;
      const index = Math.min(count - 1, Math.floor((record.at - firstBin) / binMs));
      add(bins[index]!, record);
      add(totals, record);
      let model = models.get(record.label);
      if (!model) models.set(record.label, (model = emptyTotals()));
      add(model, record);
    }
    return {
      range,
      binMs,
      bins,
      totals,
      models: [...models.entries()]
        .map(([label, value]) => ({ label, ...value }))
        .sort((left, right) => right.requests - left.requests),
      conversations: this.countConversations(firstBin),
      generatedAt: new Date(now).toISOString(),
    };
  }

  /** Conversations with at least one call inside the range. */
  private countConversations(since: number): number {
    let count = 0;
    for (const cache of this.files.values()) {
      if (cache.generations.some((generation) => (generation.responseId ? (cache.started.get(generation.responseId) ?? 0) : 0) >= since)) {
        count += 1;
      }
    }
    return count;
  }
}
