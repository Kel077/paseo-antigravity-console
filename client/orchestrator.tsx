import { useRpc, useTranslation } from "@getpaseo/plugin/client";
import { SettingsSelect, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getOrchestratorRpc,
  setOrchestratorRpc,
  type AccountSummary,
  type ModelFamily,
  type OrchestratorState,
} from "../shared/contracts";
import { displayLabel } from "./labels";
import { errorMessage, messages } from "./messages";

const DEFAULT_VALUE = "__default__";
const QUERY_KEY = ["antigravity-accounts", "orchestrator"] as const;

/** "Gemini 4 Carbon (High)" → "Carbon High". */
export function shortModelLabel(label: string): string {
  return label
    .replace(/^Gemini\s+4\s+/i, "")
    .replace(/^Gemini\s+/i, "")
    .replace(/^Claude\s+/i, "")
    .replace(/\s*\(([^()]+)\)\s*$/, " $1")
    .trim();
}

function options(families: readonly ModelFamily[], defaultLabel: string) {
  return [
    { value: DEFAULT_VALUE, label: defaultLabel },
    ...families.flatMap((family) => family.variants.map((variant) => ({ value: variant.label, label: variant.label }))),
  ];
}

/** Accounts among `accounts` that cannot run the family of `label`. */
function missingOn(label: string | null, families: readonly ModelFamily[], accounts: readonly AccountSummary[], t: (key: "systemName") => string): string[] {
  if (!label) return [];
  const family = families.find((entry) => entry.variants.some((variant) => variant.label === label));
  if (!family) return [];
  return accounts
    .filter((account) => account.usable && account.status === "signed-in" && !family.accounts.includes(account.id))
    .map((account) => displayLabel(account.label, t));
}

/** Planner and executor rows for the console's settings card. */
export function OrchestratorRows({
  accounts,
  onChange,
}: {
  accounts: readonly AccountSummary[];
  onChange(state: OrchestratorState): void;
}) {
  const { t } = useTranslation(messages);
  const toast = useToast();
  const cache = useQueryClient();
  const read = useRpc(getOrchestratorRpc);
  const save = useRpc(setOrchestratorRpc);
  const query = useQuery({ queryKey: QUERY_KEY, queryFn: () => read({}), staleTime: 60_000 });
  const state = query.data;
  if (!state || (!state.planners.length && !state.executors.length)) return null;

  const change = (patch: { planner?: string | null; executor?: string | null }) => {
    void save(patch)
      .then(({ state: next }) => {
        cache.setQueryData(QUERY_KEY, next);
        onChange(next);
        toast.show(t("orchestrator.applied.none"), { durationMs: 2500 });
      })
      .catch((reason: unknown) => toast.error(errorMessage(reason)));
  };
  const plannerMissing = missingOn(state.planner, state.planners, accounts, t);
  const executorMissing = missingOn(state.executor, state.executors, accounts, t);

  return (
    <>
      {state.planners.length ? (
        <SettingsSelect
          label={t("orchestrator.settingsPlanner")}
          hint={plannerMissing.length ? t("orchestrator.missingOn", { accounts: plannerMissing.join("、") }) : undefined}
          value={state.planner ?? DEFAULT_VALUE}
          options={options(state.planners, t("orchestrator.default"))}
          onValueChange={(value) => change({ planner: value === DEFAULT_VALUE ? null : value })}
        />
      ) : null}
      {state.executors.length ? (
        <SettingsSelect
          label={t("orchestrator.settingsExecutor")}
          hint={executorMissing.length ? t("orchestrator.missingOn", { accounts: executorMissing.join("、") }) : undefined}
          value={state.executor ?? DEFAULT_VALUE}
          options={options(state.executors, t("orchestrator.default"))}
          onValueChange={(value) => change({ executor: value === DEFAULT_VALUE ? null : value })}
        />
      ) : null}
    </>
  );
}
