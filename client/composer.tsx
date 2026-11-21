import { useComposer, useTranslation, type PluginComposer } from "@getpaseo/plugin/client";
import { Select } from "@getpaseo/plugin/client/ui";
import { ACCOUNT_METADATA_KEY, isAntigravityProvider } from "../shared/contracts";
import { displayLabel } from "./labels";
import { messages } from "./messages";
import { useAccounts } from "./useAccounts";

function DraftAccount({ composer }: { composer: PluginComposer }) {
  const { data } = useAccounts();
  const { t } = useTranslation(messages);
  if (!data) return null;
  const selected = composer.agent.metadata[ACCOUNT_METADATA_KEY];
  const options = data.accounts
    .filter((account) => account.usable)
    .map((account) => ({
      value: account.id,
      label: displayLabel(account.label, t),
      description: t("composerDescription", {
        detail: account.email ?? t(`kind.${account.kind}`),
        status: t(`status.${account.status}`),
      }),
    }));
  return (
    <Select
      title={t("account")}
      icon="UserRound"
      value={typeof selected === "string" ? selected : data.defaultAccountId}
      options={options}
      // An explicit "default" keeps the system sign-in even when another account is the default.
      onValueChange={({ value }) => composer.setMetadata({ [ACCOUNT_METADATA_KEY]: value })}
    />
  );
}

/** Account picker for drafts and the New workspace composer; running agents use the pill. */
export function ComposerAccount() {
  const composer = useComposer();
  if (composer.context === "agent" || !isAntigravityProvider(composer.agent.provider)) return null;
  return <DraftAccount composer={composer} />;
}
