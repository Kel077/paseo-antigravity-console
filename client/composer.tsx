import { useComposer, useTranslation, type PluginComposer } from "@getpaseo/plugin/client";
import { Select } from "@getpaseo/plugin/client/ui";
import { ACCOUNT_METADATA_KEY, isAntigravityProvider } from "../shared/contracts";
import { messages } from "./messages";
import { useAccounts } from "./useAccounts";

function DraftAccount({ composer }: { composer: PluginComposer }) {
  const { data } = useAccounts();
  const { t } = useTranslation(messages);
  if (!data) return null;
  const selected = composer.agent.metadata[ACCOUNT_METADATA_KEY];
  return <Select title={t("account")} icon="UserRound"
    value={typeof selected === "string" ? selected : data.defaultAccountId}
    options={data.accounts.map(a => ({ value: a.id, label: a.label, description: a.email || t(a.status) }))}
    onValueChange={({ value }) => composer.setMetadata({ [ACCOUNT_METADATA_KEY]: value })} />;
}

export function ComposerAccount() {
  const composer = useComposer();
  if (composer.context === "agent" || !isAntigravityProvider(composer.agent.provider)) return null;
  return <DraftAccount composer={composer} />;
}
