import { defineRpc, defineSubscription } from "@getpaseo/plugin";
import { z } from "zod";

/** The built-in provider this plugin works with. */
export const ANTIGRAVITY_PROVIDER_ID = "antigravity";

/**
 * Agent metadata key that names the account an Antigravity agent runs on.
 * Absent (or "default") means the system sign-in that `agy` uses on its own.
 */
export const ACCOUNT_METADATA_KEY = "antigravity-accounts.account";

/** Id of the system sign-in (the keychain login `agy` uses without this plugin). */
export const SYSTEM_ACCOUNT_ID = "default";

/** True when a provider string (`antigravity` or `antigravity/<model>`) is Antigravity. */
export function isAntigravityProvider(provider: string | null | undefined): boolean {
  if (!provider) return false;
  return provider.split("/")[0] === ANTIGRAVITY_PROVIDER_ID;
}

/** Reads the account id stored on an agent; returns SYSTEM_ACCOUNT_ID when none is stored. */
export function accountIdFromMetadata(metadata: Readonly<Record<string, unknown>> | null | undefined): string {
  const value = metadata?.[ACCOUNT_METADATA_KEY];
  return typeof value === "string" && value.length > 0 ? value : SYSTEM_ACCOUNT_ID;
}

export const accountIdSchema = z
  .string()
  .regex(/^(default|a[0-9a-f]{8})$/, "Unknown account id");

export const accountLabelSchema = z
  .string()
  .trim()
  .min(1, "Enter a name")
  .max(40, "Use at most 40 characters");

export const quotaBucketSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Provider period name, for example "weekly" or "5h". */
  window: z.string(),
  /** 0..1 of quota left; null when agy reports none. */
  remainingFraction: z.number().min(0).max(1).nullable(),
  /** ISO timestamp of the next reset, when reported. */
  resetTime: z.string().nullable(),
  disabled: z.boolean(),
});

export const quotaGroupSchema = z.object({
  name: z.string(),
  buckets: z.array(quotaBucketSchema),
});

export const accountStatusSchema = z.enum([
  /** agy answered with this account's quota. */
  "signed-in",
  /** agy asked to sign in. */
  "signed-out",
  /** Never checked yet. */
  "unknown",
  /** The last check failed for another reason; see statusDetail. */
  "error",
]);

export const accountSummarySchema = z.object({
  id: accountIdSchema,
  label: z.string(),
  /** "system": agy's own keychain login. "profile": a login this plugin keeps in its own profile. */
  kind: z.enum(["system", "profile"]),
  /** New Antigravity agents get this account unless the composer picks another. */
  isDefaultForNewAgents: z.boolean(),
  status: accountStatusSchema,
  /** Google account email from agy's log, when known. */
  email: z.string().nullable(),
  /** Human-readable reason for status "error" or "signed-out", or a safety warning. */
  statusDetail: z.string().nullable(),
  /** ISO timestamp of the last status check. */
  checkedAt: z.string().nullable(),
  quota: z.array(quotaGroupSchema).nullable(),
  /** ISO timestamp; null for the system account. */
  createdAt: z.string().nullable(),
  /** False when the plugin found credentials stored outside the profile and refuses to launch it. */
  usable: z.boolean(),
});

export type AccountSummary = z.infer<typeof accountSummarySchema>;
export type QuotaGroup = z.infer<typeof quotaGroupSchema>;
export type QuotaBucket = z.infer<typeof quotaBucketSchema>;

export const accountsStateSchema = z.object({
  /** System account first, then profile accounts in creation order. */
  accounts: z.array(accountSummarySchema),
  defaultAccountId: accountIdSchema,
  /** Resolved agy executable, or null when it was not found. */
  agyPath: z.string().nullable(),
  agyVersion: z.string().nullable(),
  /** Host-level problems to show above the list, for example "agy was not found". */
  problems: z.array(z.string()),
  /** Increases on every change; clients can compare it with the watch event. */
  revision: z.number().int().nonnegative(),
});

export type AccountsState = z.infer<typeof accountsStateSchema>;

const empty = z.object({}).strict();

/** Lists accounts. `refresh: true` re-checks every account's sign-in and quota first (a few seconds). */
export const listAccountsRpc = defineRpc({
  name: "accounts.list",
  input: z.object({ refresh: z.boolean().optional() }).strict(),
  output: accountsStateSchema,
});

/** Re-checks one account (or all when accountId is omitted) and returns the new state. */
export const refreshAccountsRpc = defineRpc({
  name: "accounts.refresh",
  input: z.object({ accountId: accountIdSchema.optional() }).strict(),
  output: accountsStateSchema,
});

/** Creates a profile account. It starts signed out; call signIn.start next. */
export const createAccountRpc = defineRpc({
  name: "accounts.create",
  input: z.object({ label: accountLabelSchema }).strict(),
  output: z.object({ account: accountSummarySchema, state: accountsStateSchema }),
});

/** Renames an account. The system account can be renamed too (display only). */
export const renameAccountRpc = defineRpc({
  name: "accounts.rename",
  input: z.object({ accountId: accountIdSchema, label: accountLabelSchema }).strict(),
  output: accountsStateSchema,
});

/** Chooses the account new Antigravity agents get. */
export const setDefaultAccountRpc = defineRpc({
  name: "accounts.set-default",
  input: z.object({ accountId: accountIdSchema }).strict(),
  output: accountsStateSchema,
});

/**
 * Deletes a profile account and its stored sign-in. Shared conversations are kept.
 * Fails for the system account. Agents still pointing at it fail to open until switched.
 */
export const removeAccountRpc = defineRpc({
  name: "accounts.remove",
  input: z.object({ accountId: accountIdSchema }).strict(),
  output: accountsStateSchema,
});

/** Deletes a profile account's stored sign-in but keeps the account. Fails for the system account. */
export const signOutAccountRpc = defineRpc({
  name: "accounts.sign-out",
  input: z.object({ accountId: accountIdSchema }).strict(),
  output: accountsStateSchema,
});

/**
 * Starts Google sign-in for a profile account. Returns the Google URL to open in a browser.
 * Google then shows a code (or lands on a page whose URL can be pasted); pass it to signIn.submit.
 * A pending sign-in expires after 10 minutes. Starting again cancels the previous one for that account.
 */
export const startSignInRpc = defineRpc({
  name: "sign-in.start",
  input: z.object({ accountId: accountIdSchema }).strict(),
  output: z.object({
    loginId: z.string(),
    url: z.string().url(),
    expiresAt: z.string(),
  }),
});

/** Sends the pasted code or landing-page URL. Resolves with the refreshed state once agy confirms. */
export const submitSignInRpc = defineRpc({
  name: "sign-in.submit",
  input: z
    .object({
      loginId: z.string().min(1),
      code: z.string().trim().min(1, "Paste the code").max(16384),
    })
    .strict(),
  output: accountsStateSchema,
});

export const cancelSignInRpc = defineRpc({
  name: "sign-in.cancel",
  input: z.object({ loginId: z.string().min(1) }).strict(),
  output: empty,
});

/**
 * Moves an Antigravity agent to another account and keeps its conversation.
 * "now" reloads the session immediately (interrupts a running turn).
 * "after-turn" stores the choice and reloads when the current turn ends; when the agent is idle it
 * behaves like "now".
 */
export const switchAgentAccountRpc = defineRpc({
  name: "agents.switch-account",
  input: z
    .object({
      agentId: z.string().min(1),
      accountId: accountIdSchema,
      when: z.enum(["now", "after-turn"]).default("now"),
    })
    .strict(),
  output: z.object({
    result: z.enum(["switched", "scheduled", "unchanged"]),
    accountLabel: z.string(),
  }),
});

/** Pushes `{ revision }` whenever the account list, a status, or a default changes. */
export const watchAccountsSubscription = defineSubscription({
  name: "accounts.watch",
  input: empty,
  event: z.object({ revision: z.number().int().nonnegative() }),
});

export const contextUsageSchema = z.object({
  /** Tokens in the context window after the latest model call (new input + cache reads + output). */
  used: z.number().int().nonnegative(),
  /** Context window size; null when neither agy nor the model name tells it. */
  size: z.number().int().positive().nullable(),
  input: z.number().int().nonnegative(),
  cached: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  /** "agy": the window agy recorded for the call. "model": inferred from the model name. */
  sizeSource: z.enum(["agy", "model"]).nullable(),
  /** ISO time of the latest model call's record. */
  updatedAt: z.string().nullable(),
  model: z.string().nullable(),
});

export type ContextUsage = z.infer<typeof contextUsageSchema>;

/**
 * Context window usage of Antigravity agents, read from agy's own conversation records.
 * `native` lists agents whose provider already reports context usage to Paseo (newer Paseo
 * versions), so the client can leave those to Paseo's built-in meter.
 */
export const contextUsageRpc = defineRpc({
  name: "context.usage",
  input: z.object({ agentIds: z.array(z.string().min(1)).max(200) }).strict(),
  output: z.object({
    usage: z.record(z.string(), contextUsageSchema.nullable()),
    native: z.array(z.string()),
  }),
});
