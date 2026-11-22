import {
  SYSTEM_ACCOUNT_ID,
  type AccountSummary,
  type AccountsState,
  type QuotaGroup,
} from "../shared/contracts";
import { agyVersion, probeAccount, readAccountEmail } from "./agy";
import fs from "node:fs/promises";
import path from "node:path";
import { dataDir, resolveAgy } from "./paths";

const statusFile = () => path.join(dataDir(), "status.json");
import { deleteSignIn, ensureProfile, removeProfile, scanAfterSignIn } from "./profile";
import { SignInManager } from "./signin";
import { AccountStore, type StoredAccount } from "./store";

interface RuntimeStatus {
  status: AccountSummary["status"];
  statusDetail: string | null;
  checkedAt: string | null;
  quota: QuotaGroup[] | null;
}

const UNKNOWN: RuntimeStatus = { status: "unknown", statusDetail: null, checkedAt: null, quota: null };

/** Owns the account list, sign-in state, and change notifications. */
export class AccountService {
  readonly store = new AccountStore();
  readonly signIns = new SignInManager();
  private readonly runtime = new Map<string, RuntimeStatus>();
  private readonly probing = new Map<string, Promise<void>>();
  private readonly listeners = new Set<(revision: number) => void>();
  /** Starts from the clock so it keeps increasing across daemon and plugin restarts. */
  private revision = Date.now();
  private agyPath: string | null = null;
  private agyVersionValue: string | null = null;
  private agyChecked = false;

  private initialized: Promise<void> | null = null;
  private saveTimer: NodeJS.Timeout | null = null;

  /** Loads the account list and the last known statuses, so a restart shows quota at once. */
  init(): Promise<void> {
    this.initialized ??= (async () => {
      await this.store.load();
      try {
        const raw = JSON.parse(await fs.readFile(statusFile(), "utf8")) as Record<string, RuntimeStatus>;
        for (const [id, status] of Object.entries(raw)) {
          if (id === SYSTEM_ACCOUNT_ID || this.store.get(id)) this.runtime.set(id, status);
        }
      } catch {
        // No cache yet.
      }
    })();
    return this.initialized;
  }

  private saveStatuses(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      const file = statusFile();
      const temp = `${file}.${process.pid}.tmp`;
      const body = JSON.stringify(Object.fromEntries(this.runtime), null, 1);
      void fs
        .mkdir(path.dirname(file), { recursive: true })
        .then(() => fs.writeFile(temp, body, { mode: 0o600 }))
        .then(() => fs.rename(temp, file))
        .catch((error: unknown) => console.error("antigravity-accounts: could not save statuses", error));
    }, 1000);
  }

  onChange(listener: (revision: number) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  currentRevision(): number {
    return this.revision;
  }

  private changed(): void {
    this.revision += 1;
    this.saveStatuses();
    for (const listener of this.listeners) {
      try {
        listener(this.revision);
      } catch (error) {
        console.error("antigravity-accounts: change listener failed", error);
      }
    }
  }

  async agy(force = false): Promise<string | null> {
    if (!this.agyChecked || force || !this.agyPath) {
      const previous = this.agyPath;
      this.agyPath = await resolveAgy();
      this.agyChecked = true;
      if (this.agyPath && (this.agyPath !== previous || !this.agyVersionValue)) {
        this.agyVersionValue = await agyVersion(this.agyPath).catch(() => null);
      }
    }
    return this.agyPath;
  }

  async requireAgy(): Promise<string> {
    const agy = await this.agy();
    if (!agy) throw new Error("agy was not found on this host. Install the Antigravity CLI first.");
    return agy;
  }

  /** Throws unless the id names an existing account. */
  requireAccount(accountId: string): StoredAccount | null {
    if (accountId === SYSTEM_ACCOUNT_ID) return null;
    const account = this.store.get(accountId);
    if (!account) throw new Error("That Antigravity account no longer exists.");
    return account;
  }

  requireProfileAccount(accountId: string): StoredAccount {
    const account = this.requireAccount(accountId);
    if (!account) throw new Error("The system sign-in is managed by agy itself.");
    return account;
  }

  labelOf(accountId: string): string {
    if (accountId === SYSTEM_ACCOUNT_ID) return this.store.snapshot().systemLabel;
    return this.store.get(accountId)?.label ?? accountId;
  }

  /** Re-checks sign-in and quota for one account. Concurrent calls share one probe. */
  refreshOne(accountId: string): Promise<void> {
    const running = this.probing.get(accountId);
    if (running) return running;
    const task = (async () => {
      const agy = await this.agy();
      const checkedAt = new Date().toISOString();
      if (!agy) {
        this.runtime.set(accountId, {
          status: "error",
          statusDetail: "agy was not found on this host",
          checkedAt,
          quota: null,
        });
        return;
      }
      if (accountId !== SYSTEM_ACCOUNT_ID) await ensureProfile(accountId);
      const result = await probeAccount(agy, accountId);
      const email = await readAccountEmail(accountId);
      this.runtime.set(accountId, {
        status: result.kind,
        statusDetail: result.kind === "signed-in" ? null : result.detail,
        checkedAt,
        quota: result.kind === "signed-in" ? result.quota : null,
      });
      if (email) {
        await this.store.update((data) => {
          if (accountId === SYSTEM_ACCOUNT_ID) data.systemEmail = email;
          else {
            const account = data.accounts.find((entry) => entry.id === accountId);
            if (account) account.email = email;
          }
        });
      }
    })()
      .catch((error: unknown) => {
        this.runtime.set(accountId, {
          status: "error",
          statusDetail: error instanceof Error ? error.message : String(error),
          checkedAt: new Date().toISOString(),
          quota: null,
        });
      })
      .finally(() => {
        this.probing.delete(accountId);
        this.changed();
      });
    this.probing.set(accountId, task);
    return task;
  }

  async refreshAll(): Promise<void> {
    await this.agy(true);
    const ids = [SYSTEM_ACCOUNT_ID, ...this.store.snapshot().accounts.map((account) => account.id)];
    await Promise.all(ids.map((id) => this.refreshOne(id)));
  }

  /** Last known status without probing. */
  knownStatus(accountId: string): AccountSummary["status"] {
    return this.runtime.get(accountId)?.status ?? "unknown";
  }

  /** Last known quota, probing first when nothing is known yet. */
  async quotaFor(accountId: string, maxAgeMs: number): Promise<RuntimeStatus> {
    const current = this.runtime.get(accountId);
    const age = current?.checkedAt ? Date.now() - Date.parse(current.checkedAt) : Infinity;
    if (!current || age > maxAgeMs) await this.refreshOne(accountId);
    return this.runtime.get(accountId) ?? UNKNOWN;
  }

  async state(): Promise<AccountsState> {
    const agy = await this.agy();
    const data = this.store.snapshot();
    const problems: string[] = [];
    if (!agy) problems.push("agy was not found on this host. Install the Antigravity CLI, then refresh.");
    const defaultExists =
      data.defaultAccountId === SYSTEM_ACCOUNT_ID ||
      data.accounts.some((account) => account.id === data.defaultAccountId);
    const defaultAccountId = defaultExists ? data.defaultAccountId : SYSTEM_ACCOUNT_ID;
    const system = this.runtime.get(SYSTEM_ACCOUNT_ID) ?? UNKNOWN;
    const accounts: AccountSummary[] = [
      {
        id: SYSTEM_ACCOUNT_ID,
        label: data.systemLabel,
        kind: "system",
        isDefaultForNewAgents: defaultAccountId === SYSTEM_ACCOUNT_ID,
        status: system.status,
        email: data.systemEmail,
        statusDetail: system.statusDetail,
        checkedAt: system.checkedAt,
        quota: system.quota,
        createdAt: null,
        usable: true,
      },
      ...data.accounts.map((account): AccountSummary => {
        const status = this.runtime.get(account.id) ?? UNKNOWN;
        return {
          id: account.id,
          label: account.label,
          kind: "profile",
          isDefaultForNewAgents: defaultAccountId === account.id,
          status: status.status,
          email: account.email,
          statusDetail: account.unsafeDetail ?? status.statusDetail,
          checkedAt: status.checkedAt,
          quota: status.quota,
          createdAt: account.createdAt,
          usable: account.unsafeDetail === null,
        };
      }),
    ];
    return {
      accounts,
      defaultAccountId,
      agyPath: agy,
      agyVersion: this.agyVersionValue,
      problems,
      revision: this.revision,
    };
  }

  async create(label: string): Promise<AccountSummary> {
    const id = this.store.newAccountId();
    await this.store.update((data) => {
      data.accounts.push({
        id,
        label,
        createdAt: new Date().toISOString(),
        email: null,
        credentialFiles: [],
        unsafeDetail: null,
      });
    });
    await ensureProfile(id);
    this.runtime.set(id, { ...UNKNOWN, status: "signed-out", statusDetail: "Not signed in yet" });
    this.changed();
    const created = (await this.state()).accounts.find((account) => account.id === id);
    if (!created) throw new Error("The new account could not be read back.");
    return created;
  }

  async rename(accountId: string, label: string): Promise<void> {
    this.requireAccount(accountId);
    await this.store.update((data) => {
      if (accountId === SYSTEM_ACCOUNT_ID) data.systemLabel = label;
      else {
        const account = data.accounts.find((entry) => entry.id === accountId);
        if (account) account.label = label;
      }
    });
    this.changed();
  }

  async setDefault(accountId: string): Promise<void> {
    const account = this.requireAccount(accountId);
    if (account?.unsafeDetail) throw new Error(account.unsafeDetail);
    await this.store.update((data) => {
      data.defaultAccountId = accountId;
    });
    this.changed();
  }

  async remove(accountId: string): Promise<void> {
    this.requireProfileAccount(accountId);
    this.signIns.cancelForAccount(accountId);
    await removeProfile(accountId);
    await this.store.update((data) => {
      data.accounts = data.accounts.filter((account) => account.id !== accountId);
      if (data.defaultAccountId === accountId) data.defaultAccountId = SYSTEM_ACCOUNT_ID;
    });
    this.runtime.delete(accountId);
    this.changed();
  }

  async signOut(accountId: string): Promise<void> {
    const account = this.requireProfileAccount(accountId);
    await deleteSignIn(accountId, account.credentialFiles);
    await this.store.update((data) => {
      const entry = data.accounts.find((candidate) => candidate.id === accountId);
      if (entry) {
        entry.credentialFiles = [];
        entry.email = null;
        entry.unsafeDetail = null;
      }
    });
    this.runtime.set(accountId, { ...UNKNOWN, status: "signed-out", statusDetail: "Signed out" });
    this.changed();
    await this.refreshOne(accountId);
  }

  async startSignIn(accountId: string): Promise<{ loginId: string; url: string; expiresAt: string }> {
    this.requireProfileAccount(accountId);
    const agy = await this.requireAgy();
    await ensureProfile(accountId);
    return this.signIns.start(agy, accountId);
  }

  /** Completes a sign-in, verifies it, and checks that it stayed inside the profile. */
  async submitSignIn(loginId: string, code: string): Promise<void> {
    const accountId = this.signIns.accountOf(loginId);
    if (!accountId) throw new Error("This sign-in expired or was cancelled. Start again.");
    const systemEmailBefore = this.store.snapshot().systemEmail;
    const outcome = await this.signIns.submit(loginId, code);
    const scan = await scanAfterSignIn(accountId, outcome.submittedAt);
    await this.refreshOne(accountId);
    const status = this.runtime.get(accountId);
    let unsafeDetail: string | null = null;
    if (scan.leaked.length > 0) {
      unsafeDetail =
        `agy stored this sign-in outside the account's profile (${scan.leaked.join(", ")}). ` +
        "The plugin will not launch this account so it cannot overwrite the system sign-in.";
      console.error(`antigravity-accounts: sign-in for ${accountId} wrote ${scan.leaked.join(", ")}`);
    }
    await this.store.update((data) => {
      const entry = data.accounts.find((candidate) => candidate.id === accountId);
      if (!entry) return;
      if (scan.own.length > 0) entry.credentialFiles = scan.own;
      entry.unsafeDetail = unsafeDetail;
    });
    // A sign-in that changed the system account's identity means the keyring was written.
    if (status?.status === "signed-in" && systemEmailBefore) {
      await this.refreshOne(SYSTEM_ACCOUNT_ID);
      const systemEmailAfter = this.store.snapshot().systemEmail;
      const accountEmail = this.store.get(accountId)?.email ?? null;
      if (
        accountEmail &&
        systemEmailAfter &&
        systemEmailAfter !== systemEmailBefore &&
        systemEmailAfter === accountEmail
      ) {
        await this.store.update((data) => {
          const entry = data.accounts.find((candidate) => candidate.id === accountId);
          if (entry) {
            entry.unsafeDetail =
              "This sign-in replaced the system sign-in as well. Sign in to the system account again with agy, then remove this account.";
          }
        });
      }
    }
    this.changed();
    if (status?.status !== "signed-in") {
      const detail = status?.statusDetail ?? "agy did not confirm the sign-in";
      throw new Error(
        outcome.exitedCleanly
          ? `agy accepted the code but the account still is not signed in: ${detail}`
          : `agy did not finish the sign-in: ${detail}`,
      );
    }
  }

  cancelSignIn(loginId: string): void {
    this.signIns.cancel(loginId);
  }

  dispose(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.signIns.cancelAll();
    this.listeners.clear();
  }
}
