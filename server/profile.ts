import type { Dirent, Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  REAL_CLI_DIR,
  REAL_GEMINI,
  REAL_HOME,
  REAL_SETTINGS_FILE,
  RECOVERY_DIR,
  SHARED_CLI_DIRS,
  displayPath,
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
  await ensureRealDir(profileRoot(accountId));
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
  await syncSettings(cli);
  return home;
}

/**
 * Copies agy's settings.json into the profile, so every account runs with the same Orchestrator
 * planner and executor and the same preferences. A copy, not a link: agy replaces the file when
 * it saves, which would turn a link into a stale private copy.
 */
async function syncSettings(cli: string): Promise<void> {
  const target = path.join(cli, "settings.json");
  try {
    await fs.copyFile(REAL_SETTINGS_FILE, target);
    await fs.chmod(target, 0o600).catch(() => undefined);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    // No settings of its own: a stale copy must not keep an old choice alive.
    await fs.rm(target, { force: true });
  }
}

/** Creates or refreshes an account's profile and returns its HOME. Safe to call concurrently. */
export function ensureProfile(accountId: string): Promise<string> {
  return withLock(accountId, () => syncProfile(accountId));
}

/**
 * Looks at a path in an account's profile without following links, but only when it is reached
 * from the profile folder through real folders. A linked folder on the way leads elsewhere: with a
 * `.gemini` that links to the real one, deleting the profile's agy data would delete the system
 * account's. Null for such paths, for paths outside the profile and for missing ones.
 */
async function profileEntry(accountId: string, target: string): Promise<Stats | null> {
  const root = profileRoot(accountId);
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return null;
  }
  let current = root;
  let stat = await fs.lstat(current).catch(() => null);
  for (const part of relative ? relative.split(path.sep) : []) {
    // lstat: a link to a folder is not a directory here.
    if (!stat?.isDirectory()) return null;
    current = path.join(current, part);
    stat = await fs.lstat(current).catch(() => null);
  }
  return stat;
}

/** Entries of a real folder in the profile. Never reads through a link, into the real home or elsewhere. */
async function realEntries(accountId: string, dir: string): Promise<Dirent[]> {
  return (await profileEntry(accountId, dir))?.isDirectory() ? readDirSafe(dir) : [];
}

/** True when a file, or a folder with at least one file or link somewhere inside. */
async function holdsData(full: string, entry: Dirent): Promise<boolean> {
  if (!entry.isDirectory()) return entry.isFile() || entry.isSymbolicLink();
  for (const child of await readDirSafe(full)) {
    if (await holdsData(path.join(full, child.name), child)) return true;
  }
  return false;
}

/**
 * What agents saved in a profile's HOME, relative to it: entries that are not links to the real
 * home, outside agy's own data folder for the account. Empty folders are left out.
 */
export async function savedFiles(accountId: string): Promise<string[]> {
  const home = profileHome(accountId);
  const found: string[] = [];
  const collect = async (dir: string, skip: string) => {
    for (const entry of await realEntries(accountId, dir)) {
      if (entry.isSymbolicLink() || entry.name === skip) continue;
      const full = path.join(dir, entry.name);
      if (await holdsData(full, entry)) found.push(path.relative(home, full));
    }
  };
  await collect(home, ".gemini");
  await collect(path.join(home, ".gemini"), "antigravity-cli");
  return found.sort((a, b) => a.localeCompare(b));
}

/** A folder name made from an account label. */
function folderName(label: string): string {
  const name = label
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 60)
    .trim();
  return name || "Account";
}

function candidate(name: string, attempt: number): string {
  return path.join(RECOVERY_DIR, attempt === 1 ? name : `${name} ${attempt}`);
}

/** The folder a removal would move saved files to, without creating it. */
export async function recoveryFolder(label: string): Promise<string> {
  const name = folderName(label);
  for (let attempt = 1; ; attempt++) {
    const folder = candidate(name, attempt);
    if (!(await fs.lstat(folder).catch(() => null))) return folder;
  }
}

/** Creates and returns a new, empty recovery folder for an account. */
async function claimRecoveryFolder(label: string): Promise<string> {
  await fs.mkdir(RECOVERY_DIR, { recursive: true });
  const name = folderName(label);
  for (let attempt = 1; ; attempt++) {
    const folder = candidate(name, attempt);
    try {
      await fs.mkdir(folder);
      return folder;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
  }
}

/** `destination`, or the first free "name 2.ext", "name 3.ext" beside it. */
async function freePath(destination: string): Promise<string> {
  const { dir, name, ext } = path.parse(destination);
  for (let attempt = 1; ; attempt++) {
    const candidate = attempt === 1 ? destination : path.join(dir, `${name} ${attempt}${ext}`);
    if (!(await fs.lstat(candidate).catch(() => null))) return candidate;
  }
}

/**
 * Moves a file or folder out of the profile without replacing anything, copying when it crosses to
 * another volume. The copied source is deleted only while it is still behind real folders.
 */
async function move(accountId: string, source: string, destination: string): Promise<void> {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const target = await freePath(destination);
  try {
    await fs.rename(source, target);
  } catch (error) {
    if (errorCode(error) !== "EXDEV") throw error;
    await fs.cp(source, target, {
      recursive: true,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
      verbatimSymlinks: true,
      // Sockets and pipes cannot be copied and hold nothing worth keeping.
      filter: async (file) => {
        const stat = await fs.lstat(file);
        return stat.isFile() || stat.isDirectory() || stat.isSymbolicLink();
      },
    });
    if (await profileEntry(accountId, source)) await fs.rm(source, { recursive: true, force: true });
  }
}

/**
 * Deletes what is left of a profile once its saved files are out: links into the real home,
 * sockets and other special files, and empty folders. A link is removed, never followed, and a
 * regular file is never deleted, so a file written after the scan stays where it is. True when
 * nothing is left at `dir`.
 */
async function clearProfile(dir: string): Promise<boolean> {
  const stat = await fs.lstat(dir).catch(() => null);
  if (!stat) return true;
  if (stat.isFile()) return false;
  const gone = (error: unknown) => errorCode(error) === "ENOENT";
  if (!stat.isDirectory()) return fs.unlink(dir).then(() => true, gone);
  for (const entry of await readDirSafe(dir)) await clearProfile(path.join(dir, entry.name));
  return fs.rmdir(dir).then(() => true, gone);
}

export interface PreservedFiles {
  /** Absolute path of the folder the saved files were moved to. */
  folder: string;
  /** The moved entries, relative to the profile HOME (and to `folder`). */
  items: string[];
}

/**
 * Deletes a profile. Files agents saved in its HOME are first moved to a new folder under
 * RECOVERY_DIR, then agy's data for the account, its sign-in included, is deleted. A failed move
 * stops the removal, and agy's data is deleted only after every file found was moved. Only agy's
 * data is deleted recursively, and only when every folder from the profile folder down to it is a
 * real folder. Links anywhere in the profile are removed without touching what they point at.
 */
export function removeProfile(accountId: string, label: string): Promise<PreservedFiles | null> {
  return withLock(accountId, async () => {
    const home = profileHome(accountId);
    const cli = profileCliDir(accountId);
    let folder: string | null = null;
    const moved: string[] = [];
    const movedSoFar = () => (folder ? ` Files moved so far are in ${displayPath(folder)}.` : "");
    // A running agent can still write while this runs: whatever appears is moved on the next pass.
    for (let pass = 1; pass <= 3; pass++) {
      for (const item of await savedFiles(accountId)) {
        const source = path.join(home, item);
        // Listed behind real folders a moment ago; skip it if a folder above it became a link since.
        if (!(await profileEntry(accountId, source))) continue;
        folder ??= await claimRecoveryFolder(label);
        try {
          await move(accountId, source, path.join(folder, item));
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(`Couldn't move ${item} out of the account's home folder: ${reason}.${movedSoFar()}`);
        }
        if (!moved.includes(item)) moved.push(item);
      }
      // Behind a linked folder this would be another account's agy data, such as the system one's.
      if (pass === 1 && (await profileEntry(accountId, cli))?.isDirectory()) {
        await fs.rm(cli, { recursive: true, force: true });
      }
      if (await clearProfile(profileRoot(accountId))) return folder ? { folder, items: moved } : null;
    }
    throw new Error(`Files keep appearing in the account's home folder. Stop its agents and remove it again.${movedSoFar()}`);
  });
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

/**
 * Deletes the sign-in files recorded for a profile (or found by name when none were recorded).
 * Only files behind real folders: through a linked `.gemini` they would be the system sign-in.
 */
export function deleteSignIn(accountId: string, recorded: readonly string[]): Promise<string[]> {
  return withLock(accountId, async () => {
    const home = profileHome(accountId);
    const cli = profileCliDir(accountId);
    if (!(await profileEntry(accountId, cli))?.isDirectory()) return [];
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
      // lstat: a link is not a file here.
      if (!(await profileEntry(accountId, file))?.isFile()) continue;
      await fs.unlink(file);
      removed.push(path.relative(home, file));
    }
    return removed;
  });
}
