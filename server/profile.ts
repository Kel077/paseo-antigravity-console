import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  REAL_CLI_DIR,
  REAL_GEMINI,
  REAL_HOME,
  SHARED_CLI_DIRS,
  profileCliDir,
  profileHome,
  profileRoot,
} from "./paths";

/**
 * A profile is a HOME directory that mirrors the real home with symlinks, so tools an agent runs
 * still find ~/.gitconfig, ~/.ssh, ~/Library and so on. Only `.gemini/antigravity-cli` is a real
 * directory of its own: agy keeps the profile's sign-in there. Its conversation folders link back to
 * the real ones, so every account sees the same conversations.
 */

/** File names that may hold a sign-in. Never mirrored from the real ~/.gemini root. */
export const CREDENTIAL_NAME = /(auth|token|cred|oauth|keyring|secret|account)/i;

const locks = new Map<string, Promise<unknown>>();

function withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const next = previous.then(task, task);
  locks.set(
    key,
    next.catch(() => undefined),
  );
  return next;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

async function readDirSafe(dir: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
}

/** Ensures `link` is a symlink to `target`. Leaves real files and directories alone. */
async function ensureLink(link: string, target: string): Promise<void> {
  try {
    const stat = await fs.lstat(link);
    if (!stat.isSymbolicLink()) return;
    if ((await fs.readlink(link)) === target) return;
    await fs.unlink(link);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  try {
    await fs.symlink(target, link);
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
}

/** Ensures `dir` is a real directory (replacing a symlink left by an older layout). */
async function ensureRealDir(dir: string): Promise<void> {
  try {
    const stat = await fs.lstat(dir);
    if (stat.isDirectory()) return;
    if (stat.isSymbolicLink()) await fs.unlink(dir);
    else throw new Error(`${dir} exists and is not a directory`);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
}

/** Removes symlinks in `dir` that point into `sourceDir` at entries that no longer exist. */
async function pruneLinks(dir: string, sourceDir: string, keep: ReadonlySet<string>): Promise<void> {
  for (const entry of await readDirSafe(dir)) {
    if (!entry.isSymbolicLink() || keep.has(entry.name)) continue;
    const link = path.join(dir, entry.name);
    const target = await fs.readlink(link).catch(() => "");
    if (path.dirname(target) === sourceDir) await fs.unlink(link).catch(() => undefined);
  }
}

async function mirror(
  sourceDir: string,
  destinationDir: string,
  skip: (name: string) => boolean,
): Promise<void> {
  const keep = new Set<string>();
  for (const entry of await readDirSafe(sourceDir)) {
    if (skip(entry.name)) continue;
    keep.add(entry.name);
    await ensureLink(path.join(destinationDir, entry.name), path.join(sourceDir, entry.name));
  }
  await pruneLinks(destinationDir, sourceDir, keep);
}

async function syncProfile(accountId: string): Promise<string> {
  const home = profileHome(accountId);
  await fs.mkdir(profileRoot(accountId), { recursive: true, mode: 0o700 });
  await ensureRealDir(home);
  await mirror(REAL_HOME, home, (name) => name === ".gemini");

  const gemini = path.join(home, ".gemini");
  await ensureRealDir(gemini);
  await mirror(
    REAL_GEMINI,
    gemini,
    (name) => name === "antigravity-cli" || CREDENTIAL_NAME.test(name),
  );

  const cli = profileCliDir(accountId);
  await ensureRealDir(cli);
  for (const name of SHARED_CLI_DIRS) {
    const target = path.join(REAL_CLI_DIR, name);
    await fs.mkdir(target, { recursive: true });
    await ensureLink(path.join(cli, name), target);
  }
  return home;
}

/** Creates or refreshes an account's profile and returns its HOME. Safe to call concurrently. */
export function ensureProfile(accountId: string): Promise<string> {
  return withLock(accountId, () => syncProfile(accountId));
}

/** Deletes a profile. Symlinks are removed without touching what they point at. */
export function removeProfile(accountId: string): Promise<void> {
  return withLock(accountId, () => fs.rm(profileRoot(accountId), { recursive: true, force: true }));
}

interface ScanOptions {
  since: number;
  maxDepth: number;
}

/** Files (not followed through symlinks) changed since `since` whose names look like credentials. */
async function scanCredentialFiles(root: string, options: ScanOptions): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    for (const entry of await readDirSafe(dir)) {
      if (entry.isSymbolicLink() || entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < options.maxDepth) await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile() || !CREDENTIAL_NAME.test(entry.name)) continue;
      const stat = await fs.stat(full).catch(() => null);
      if (stat && stat.mtimeMs >= options.since) found.push(full);
    }
  }
  await walk(root, 0);
  return found;
}

export interface CredentialScan {
  /** Sign-in files agy wrote inside the profile, relative to the profile HOME. */
  own: string[];
  /** Sign-in-looking files written outside the profile during the sign-in (absolute paths). */
  leaked: string[];
}

/**
 * After a sign-in, finds where agy stored it. `leaked` is non-empty when something landed in a
 * folder the profile shares with the system sign-in, which would let accounts overwrite each other.
 */
export async function scanAfterSignIn(accountId: string, since: number): Promise<CredentialScan> {
  const home = profileHome(accountId);
  const own = (await scanCredentialFiles(path.join(home, ".gemini"), { since, maxDepth: 4 })).map(
    (file) => path.relative(home, file),
  );
  const leaked: string[] = [];
  for (const entry of await readDirSafe(REAL_GEMINI)) {
    const full = path.join(REAL_GEMINI, entry.name);
    if (entry.name === "antigravity-cli") {
      // The system sign-in's own folder: only its top-level files and the shared conversation dirs.
      for (const file of await readDirSafe(full)) {
        const filePath = path.join(full, file.name);
        if (file.isFile() && CREDENTIAL_NAME.test(file.name)) {
          const stat = await fs.stat(filePath).catch(() => null);
          if (stat && stat.mtimeMs >= since) leaked.push(filePath);
        }
      }
      for (const shared of SHARED_CLI_DIRS) {
        leaked.push(...(await scanCredentialFiles(path.join(full, shared), { since, maxDepth: 2 })));
      }
      continue;
    }
    if (entry.isDirectory()) {
      leaked.push(...(await scanCredentialFiles(full, { since, maxDepth: 4 })));
    } else if (entry.isFile() && CREDENTIAL_NAME.test(entry.name)) {
      const stat = await fs.stat(full).catch(() => null);
      if (stat && stat.mtimeMs >= since) leaked.push(full);
    }
  }
  return { own, leaked };
}

/** Deletes the sign-in files recorded for a profile (or found by name when none were recorded). */
export async function deleteSignIn(accountId: string, recorded: readonly string[]): Promise<string[]> {
  const home = profileHome(accountId);
  const cli = profileCliDir(accountId);
  const targets = new Set<string>();
  for (const relative of recorded) {
    const full = path.resolve(home, relative);
    if (full.startsWith(cli + path.sep)) targets.add(full);
  }
  if (targets.size === 0) {
    for (const file of await scanCredentialFiles(cli, { since: 0, maxDepth: 2 })) targets.add(file);
  }
  const removed: string[] = [];
  for (const file of targets) {
    const stat = await fs.lstat(file).catch(() => null);
    if (!stat || stat.isSymbolicLink() || !stat.isFile()) continue;
    await fs.unlink(file);
    removed.push(path.relative(home, file));
  }
  return removed;
}
