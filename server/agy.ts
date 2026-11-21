import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { SYSTEM_ACCOUNT_ID, type QuotaGroup } from "../shared/contracts";
import { REAL_CLI_DIR, profileCliDir, profileHome } from "./paths";

/** agy 1.5 keeps Google sign-ins in one OS keyring entry unless it believes it runs over SSH. */
export const FAKE_SSH_CONNECTION = "127.0.0.1 0 127.0.0.1 0";

/** Marker the usage source reads back from a session's environment. */
export const ACCOUNT_ENV = "PASEO_AGY_ACCOUNT";

/**
 * Environment added to an agent session on a profile account. HOME moves agy's data directory and
 * hides the keyring sign-in; SSH_CONNECTION makes agy store its own sign-in in a file inside HOME.
 * ANTIGRAVITY_HOME is ignored by agy but keeps Paseo's built-in usage reader per account.
 */
export function sessionEnv(accountId: string, current: Readonly<Record<string, string>>): Record<string, string> {
  if (accountId === SYSTEM_ACCOUNT_ID) return { [ACCOUNT_ENV]: SYSTEM_ACCOUNT_ID };
  return {
    HOME: profileHome(accountId),
    SSH_CONNECTION: current.SSH_CONNECTION || FAKE_SSH_CONNECTION,
    ANTIGRAVITY_HOME: profileCliDir(accountId),
    [ACCOUNT_ENV]: accountId,
  };
}

/** Full environment for the plugin's own agy calls (probes and sign-in). */
export function commandEnv(accountId: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined) base[key] = value;
  Object.assign(env, sessionEnv(accountId, base));
  // Never let a probe or sign-in open a browser on the daemon host or update the CLI.
  env.BROWSER = "/usr/bin/false";
  env.AGY_CLI_DISABLE_AUTO_UPDATE = "1";
  return env;
}

export function accountHome(accountId: string): string {
  return accountId === SYSTEM_ACCOUNT_ID ? os.homedir() : profileHome(accountId);
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** True when `stopWhen` matched and the process was stopped early. */
  stopped: boolean;
}

/** Runs agy with stdin closed, a byte cap, and a hard timeout. */
export function runAgy(
  agyPath: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; cwd: string; timeoutMs: number; stopWhen?: RegExp },
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(agyPath, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let stopped = false;
    const cap = 4 * 1024 * 1024;
    const check = () => {
      if (stopped || !options.stopWhen) return;
      if (options.stopWhen.test(stdout) || options.stopWhen.test(stderr)) {
        stopped = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 2000).unref();
      }
    };
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < cap) stdout += chunk.toString("utf8");
      check();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < cap) stderr += chunk.toString("utf8");
      check();
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000).unref();
    }, options.timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}${error.message}`, timedOut, stopped });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, stopped });
    });
  });
}

export async function agyVersion(agyPath: string): Promise<string | null> {
  const result = await runAgy(agyPath, ["--version"], {
    env: commandEnv(SYSTEM_ACCOUNT_ID),
    cwd: os.tmpdir(),
    timeoutMs: 8000,
  });
  return /\b\d+\.\d+\.\d+\S*/.exec(result.stdout)?.[0] ?? null;
}

const usageResponse = z.object({
  status: z.string(),
  error: z.string().optional(),
  response: z.string().optional(),
  command: z
    .object({
      name: z.string(),
      data: z.object({
        groups: z.array(
          z.object({
            name: z.string(),
            buckets: z.array(
              z.object({
                id: z.string().min(1),
                name: z.string(),
                window: z.string(),
                remaining_fraction: z.number().min(0).max(1).nullish(),
                reset_time: z.string().nullish(),
                disabled: z.boolean().optional(),
              }),
            ),
          }),
        ),
      }),
    })
    .optional(),
});

export type ProbeResult =
  | { kind: "signed-in"; quota: QuotaGroup[] }
  | { kind: "signed-out"; detail: string }
  | { kind: "error"; detail: string };

const SIGN_IN_TEXT = /(authentication required|authentication failed|not signed in|sign in|log in|login)/i;
/** agy prints this and then waits up to 60 s for a code; there is no point waiting. */
const NEEDS_SIGN_IN = /Authentication required|paste the authorization code/i;

function firstMeaningfulLine(text: string): string {
  const line = text
    .split("\n")
    .map((value) => value.trim())
    .find((value) => value.length > 0 && !value.startsWith("https://"));
  return (line ?? "").slice(0, 300);
}

/** Reads an account's quota with `agy -p /usage`, which also tells whether it is signed in. */
export async function probeAccount(agyPath: string, accountId: string): Promise<ProbeResult> {
  const result = await runAgy(agyPath, ["-p", "/usage", "--output-format", "json"], {
    env: commandEnv(accountId),
    cwd: accountId === SYSTEM_ACCOUNT_ID ? os.tmpdir() : profileHome(accountId),
    timeoutMs: 25_000,
    stopWhen: NEEDS_SIGN_IN,
  });
  if (result.stopped) return { kind: "signed-out", detail: "Not signed in" };
  const stdout = result.stdout.trim();
  const jsonStart = stdout.indexOf("{");
  if (jsonStart >= 0) {
    try {
      const parsed = usageResponse.parse(JSON.parse(stdout.slice(jsonStart)));
      if (parsed.status === "SUCCESS" && parsed.command?.name === "usage") {
        return {
          kind: "signed-in",
          quota: parsed.command.data.groups.map((group) => ({
            name: group.name,
            buckets: group.buckets.map((bucket) => ({
              id: bucket.id,
              name: bucket.name,
              window: bucket.window,
              remainingFraction: bucket.remaining_fraction ?? null,
              resetTime: bucket.reset_time ?? null,
              disabled: bucket.disabled === true,
            })),
          })),
        };
      }
      const detail = parsed.error || parsed.response || `agy reported ${parsed.status}`;
      if (SIGN_IN_TEXT.test(detail)) return { kind: "signed-out", detail: firstMeaningfulLine(detail) };
      return { kind: "error", detail: firstMeaningfulLine(detail) };
    } catch {
      // Fall through to the text checks below.
    }
  }
  const combined = `${result.stdout}\n${result.stderr}`;
  if (SIGN_IN_TEXT.test(combined)) {
    return { kind: "signed-out", detail: "Not signed in" };
  }
  if (result.timedOut) return { kind: "error", detail: "agy did not answer within 25 seconds" };
  return {
    kind: "error",
    detail: firstMeaningfulLine(combined) || `agy exited with code ${String(result.code)}`,
  };
}

const EMAIL_LINE = /authenticated successfully as (\S+@\S+)/g;

/** The Google account agy last reported for this account, from its own logs. */
export async function readAccountEmail(accountId: string): Promise<string | null> {
  const logDir = path.join(
    accountId === SYSTEM_ACCOUNT_ID ? REAL_CLI_DIR : profileCliDir(accountId),
    "log",
  );
  let names: string[];
  try {
    names = await fs.readdir(logDir);
  } catch {
    return null;
  }
  const files = await Promise.all(
    names
      .filter((name) => name.endsWith(".log"))
      .map(async (name) => {
        const full = path.join(logDir, name);
        const stat = await fs.stat(full).catch(() => null);
        return stat?.isFile() ? { full, mtime: stat.mtimeMs } : null;
      }),
  );
  const recent = files
    .filter((file): file is { full: string; mtime: number } => file !== null)
    .sort((left, right) => right.mtime - left.mtime)
    .slice(0, 25);
  for (const file of recent) {
    const text = await fs.readFile(file.full, "utf8").catch(() => "");
    let last: string | null = null;
    for (const match of text.matchAll(EMAIL_LINE)) last = match[1] ?? null;
    if (last) return last.replace(/[.,;)]+$/, "");
  }
  return null;
}
