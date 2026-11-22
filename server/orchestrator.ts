import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PaseoApi } from "./types";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  SYSTEM_ACCOUNT_ID,
  isAntigravityProvider,
  type ModelFamily,
  type OrchestratorState,
} from "../shared/contracts";
import type { AccountService } from "./accounts";
import { commandEnv, runAgy } from "./agy";
import { REAL_CLI_DIR, REAL_SETTINGS_FILE, paseoHome, resolveAgy } from "./paths";

/**
 * agy 1.5.14 runs its Orchestrator models as a planner that hands the plan to an executor. Which
 * models play those roles comes from `"orchestrator": { "planner", "executor" }` in agy's
 * settings.json (values are model labels such as `Gemini 4 Carbon (High)`), not from the
 * Orchestrator model's own name. A planner the account cannot run falls back to agy's default.
 */
const SETTINGS_FILE = REAL_SETTINGS_FILE;

/** Model families agy accepts in each role (agy's built-in `orchestrator-model-roles`). */
const PLANNER_FAMILIES = ["gemini-4-neon", "gemini-4-carbon", "gemini-4-argon", "claude-opus-5-5"];
const EXECUTOR_FAMILIES = ["gemini-4-hydrogen", "claude-sonnet-5-5"];

const EFFORT_SUFFIX = /-(low|medium|high|xhigh|max)$/;
const LABEL_EFFORT = /^(.*?)\s*\(([^()]+)\)\s*$/;
const CATALOG_TTL_MS = 10 * 60_000;

interface CatalogModel {
  id: string;
  label: string;
}

interface Catalog {
  models: CatalogModel[];
  fetchedAt: number;
}

type SettingsJson = Record<string, unknown> & { orchestrator?: Record<string, unknown> };

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

async function readSettingsJson(): Promise<SettingsJson> {
  let raw: string;
  try {
    raw = await fs.readFile(SETTINGS_FILE, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return {};
    throw error;
  }
  const text = stripBom(raw).trim();
  if (!text) return {};
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${SETTINGS_FILE} does not hold a JSON object`);
  }
  return parsed as SettingsJson;
}

function savedRole(settings: SettingsJson, role: "planner" | "executor"): string | null {
  const value = settings.orchestrator?.[role];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Model ids the user kept in Paseo's own Antigravity model list, when they curated one. */
async function curatedModelIds(): Promise<Set<string> | null> {
  try {
    const raw = await fs.readFile(path.join(paseoHome(), "config.json"), "utf8");
    const config = JSON.parse(raw) as {
      agents?: { providers?: Record<string, { models?: Array<{ id?: unknown }> }> };
    };
    const models = config.agents?.providers?.antigravity?.models;
    if (!Array.isArray(models)) return null;
    return new Set(models.map((model) => (typeof model?.id === "string" ? model.id : "")).filter(Boolean));
  } catch {
    return null;
  }
}

function parseCatalog(output: string): CatalogModel[] {
  const models: CatalogModel[] = [];
  for (const line of output.split(/\r?\n/)) {
    const [id, label, ...extra] = line.split("\t");
    if (!id || !label || extra.length > 0 || /\s/.test(id)) continue;
    models.push({ id: id.trim(), label: label.trim() });
  }
  return models;
}

function familiesFor(
  allowed: readonly string[],
  catalogs: ReadonlyMap<string, CatalogModel[]>,
  curated: ReadonlySet<string> | null,
): ModelFamily[] {
  const families = new Map<string, ModelFamily>();
  for (const [accountId, models] of catalogs) {
    for (const model of models) {
      const familyId = model.id.replace(EFFORT_SUFFIX, "");
      if (familyId === model.id || !allowed.includes(familyId)) continue;
      const match = LABEL_EFFORT.exec(model.label);
      const familyLabel = match?.[1] ?? model.label;
      const effort = match?.[2] ?? "";
      let family = families.get(familyId);
      if (!family) {
        family = { id: familyId, label: familyLabel, variants: [], accounts: [] };
        families.set(familyId, family);
      }
      if (!family.accounts.includes(accountId)) family.accounts.push(accountId);
      if (!family.variants.some((variant) => variant.id === model.id)) {
        family.variants.push({ id: model.id, label: model.label, effort });
      }
    }
  }
  const order = ["low", "medium", "high", "xhigh", "max"];
  const rank = (id: string) => order.indexOf(EFFORT_SUFFIX.exec(id)?.[1] ?? "");
  return allowed
    .map((id) => families.get(id))
    .filter((family): family is ModelFamily => Boolean(family))
    // A family the user removed from Paseo's model list stays out of these choices too.
    .filter((family) => !curated || family.variants.some((variant) => curated.has(variant.id)))
    .map((family) => ({ ...family, variants: family.variants.sort((a, b) => rank(a.id) - rank(b.id)) }));
}

export class OrchestratorSettings {
  private readonly catalogs = new Map<string, Catalog>();
  private readonly pendingReloads = new Set<string>();
  private writing: Promise<unknown> = Promise.resolve();

  constructor(private readonly service: AccountService) {}

  private async catalog(accountId: string, refresh: boolean): Promise<CatalogModel[] | null> {
    const cached = this.catalogs.get(accountId);
    if (cached && !refresh && Date.now() - cached.fetchedAt < CATALOG_TTL_MS) return cached.models;
    const agy = await resolveAgy();
    if (!agy) throw new Error("Antigravity CLI (agy) was not found.");
    const result = await runAgy(agy, ["models"], {
      env: commandEnv(accountId),
      cwd: os.homedir(),
      timeoutMs: 30_000,
      stopWhen: /Authentication required/i,
    });
    const models = parseCatalog(result.stdout);
    if (!models.length) return cached?.models ?? null;
    this.catalogs.set(accountId, { models, fetchedAt: Date.now() });
    return models;
  }

  async state(refresh = false): Promise<OrchestratorState> {
    await this.service.init();
    const accounts = (await this.service.state()).accounts.filter(
      (account) => account.usable && account.status !== "signed-out",
    );
    const catalogs = new Map<string, CatalogModel[]>();
    let error: string | null = null;
    await Promise.all(
      accounts.map(async (account) => {
        try {
          const models = await this.catalog(account.id, refresh);
          if (models) catalogs.set(account.id, models);
        } catch (failure) {
          error = failure instanceof Error ? failure.message : String(failure);
        }
      }),
    );
    // Keep the system sign-in first, then the list order.
    const ordered = new Map(
      [...catalogs].sort(
        ([a], [b]) =>
          (a === SYSTEM_ACCOUNT_ID ? -1 : accounts.findIndex((x) => x.id === a)) -
          (b === SYSTEM_ACCOUNT_ID ? -1 : accounts.findIndex((x) => x.id === b)),
      ),
    );
    const curated = await curatedModelIds();
    let settings: SettingsJson = {};
    try {
      settings = await readSettingsJson();
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    }
    if (!ordered.size && !error) error = "No signed-in account could list its models.";
    return {
      planner: savedRole(settings, "planner"),
      executor: savedRole(settings, "executor"),
      planners: familiesFor(PLANNER_FAMILIES, ordered, curated),
      executors: familiesFor(EXECUTOR_FAMILIES, ordered, curated),
      error,
    };
  }

  /** Saves the planner and executor the way agy's own `/model` does. `null` restores agy's default. */
  async save(update: { planner?: string | null; executor?: string | null }): Promise<OrchestratorState> {
    const state = await this.state();
    const known = (families: readonly ModelFamily[], label: string) =>
      families.some((family) => family.variants.some((variant) => variant.label === label));
    if (update.planner && !known(state.planners, update.planner)) {
      throw new Error(`${update.planner} is not a planner model your accounts can use.`);
    }
    if (update.executor && !known(state.executors, update.executor)) {
      throw new Error(`${update.executor} is not an executor model your accounts can use.`);
    }
    const run = this.writing.then(async () => {
      const settings = await readSettingsJson();
      const orchestrator: Record<string, unknown> = { ...(settings.orchestrator ?? {}) };
      for (const role of ["planner", "executor"] as const) {
        const value = update[role];
        if (value === undefined) continue;
        if (value === null) delete orchestrator[role];
        else orchestrator[role] = value;
      }
      if (Object.keys(orchestrator).length) settings.orchestrator = orchestrator;
      else delete settings.orchestrator;
      await fs.mkdir(REAL_CLI_DIR, { recursive: true });
      const temp = `${SETTINGS_FILE}.paseo-${process.pid}-${Date.now()}.tmp`;
      await fs.writeFile(temp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
      await fs.rename(temp, SETTINGS_FILE);
    });
    this.writing = run.catch(() => undefined);
    await run;
    return this.state();
  }

  /** Reopens an agent so its next turn uses the saved choice; waits for a running turn to end. */
  async apply(paseo: PaseoApi, agentId: string): Promise<"now" | "after-turn" | "none"> {
    const handle = paseo.agents.ref(agentId);
    const snapshot = await handle.refresh().catch(() => null);
    if (!snapshot || snapshot.agent.archivedAt || !isAntigravityProvider(snapshot.agent.provider)) return "none";
    if (snapshot.agent.status === "running" || snapshot.agent.status === "initializing") {
      this.pendingReloads.add(agentId);
      return "after-turn";
    }
    await handle.reload();
    return "now";
  }

  register(server: PluginServerContext): Array<() => void> {
    return [
      server.addHook("agent.turn.after", async ({ agent }, { paseo }) => {
        if (!this.pendingReloads.delete(agent.id)) return;
        await new Promise((resolve) => setTimeout(resolve, 500));
        await paseo.agents
          .ref(agent.id)
          .reload()
          .catch((error: unknown) => console.error(`antigravity-accounts: could not reopen ${agent.id}`, error));
      }),
      server.addHook("agent.archive.after", async ({ agent }) => {
        this.pendingReloads.delete(agent.id);
      }),
      () => this.pendingReloads.clear(),
    ];
  }
}
