import type { UsageSourceRegistration, UsageWindow } from "@getpaseo/plugin/server";
import {
  hashAccountKey,
  toneFromUsedPct,
  unavailable,
  windowFromUsedPct,
  type UsageScope,
} from "@getpaseo/plugin/server/usage";
import { z } from "zod";
import {
  SYSTEM_ACCOUNT_ID,
  accountIdSchema,
  isAntigravityProvider,
  type QuotaGroup,
} from "../shared/contracts";
import type { AccountService } from "./accounts";
import { ACCOUNT_ENV } from "./agy";
import { REAL_CLI_DIR, profileCliDir } from "./paths";

const input = z.object({ accountId: accountIdSchema }).strict();

/**
 * Same identity Paseo's own Antigravity usage reader derives (a hash of the account's
 * antigravity-cli directory), so the two never show one account as two cards.
 */
function accountKey(accountId: string): string {
  return hashAccountKey(accountId === SYSTEM_ACCOUNT_ID ? REAL_CLI_DIR : profileCliDir(accountId));
}

function shortWindow(window: string): string {
  const normalized = window.trim().toLowerCase();
  if (normalized === "weekly") return "wk";
  if (normalized === "monthly") return "mo";
  return window.trim();
}

function shortGroup(name: string): string {
  return name.trim().replace(/\s+models$/i, "").trim();
}

export function quotaWindows(groups: readonly QuotaGroup[]): UsageWindow[] {
  const includeGroup = groups.length > 1;
  return groups.flatMap((group) =>
    group.buckets.flatMap((bucket) => {
      if (!bucket.disabled && bucket.remainingFraction === null) return [];
      const used = bucket.disabled || bucket.remainingFraction === null ? null : (1 - bucket.remainingFraction) * 100;
      const period = shortWindow(bucket.window);
      return [
        windowFromUsedPct({
          id: bucket.id,
          label: `${group.name} · ${bucket.name}${bucket.disabled ? " · Disabled" : ""}`,
          shortLabel: includeGroup ? `${shortGroup(group.name)} ${period}`.trim() : period,
          summary: !bucket.disabled && bucket.window.trim().toLowerCase() === "weekly",
          utilizationPct: used,
          resetsAt: bucket.disabled ? null : bucket.resetTime,
          tone: used === null ? "default" : toneFromUsedPct(used),
        }),
      ];
    }),
  );
}

/**
 * Global discovery lists the plugin's own accounts (another source already covers the system
 * sign-in on the host-wide Usage screen). Session discovery returns the account an Antigravity
 * agent runs on, including the system sign-in, read from the session's environment marker.
 */
export function createUsageSource(service: AccountService): UsageSourceRegistration {
  const entry = (accountId: string) => {
    const label = service.labelOf(accountId);
    return { key: accountKey(accountId), label, harness: "Antigravity", input: { accountId } };
  };
  return {
    id: "antigravity-accounts",
    label: "Antigravity accounts",
    icon: "icon.svg",
    input,
    async discover(scope: UsageScope) {
      await service.init();
      if (scope.kind === "global") {
        return service.store.snapshot().accounts.map((account) => entry(account.id));
      }
      if (!isAntigravityProvider(scope.provider)) return [];
      const marked = scope.env[ACCOUNT_ENV];
      if (!marked) return [];
      if (marked !== SYSTEM_ACCOUNT_ID && !service.store.get(marked)) return [];
      return [entry(marked)];
    },
    async fetch(value: unknown) {
      const { accountId } = input.parse(value);
      if (accountId !== SYSTEM_ACCOUNT_ID && !service.store.get(accountId)) {
        throw new Error("This Antigravity account was removed.");
      }
      const status = await service.quotaFor(accountId, 60_000);
      if (status.status === "signed-in" && status.quota) {
        const windows = quotaWindows(status.quota);
        if (windows.length === 0) {
          return unavailable({ kind: "no_quota", detail: "agy reported no quota for this account" });
        }
        return { status: "available", windows };
      }
      if (status.status === "signed-out") {
        return unavailable({
          kind: "no_quota",
          detail: "Not signed in. Open Antigravity accounts to sign in.",
        });
      }
      return { status: "error", error: status.statusDetail ?? "Could not read Antigravity quota" };
    },
  };
}
