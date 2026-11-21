import { useRpc, useTranslation, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Icon, ScrollView, SettingsCard, SettingsRow, SettingsSelect, useToast } from "@getpaseo/plugin/client/ui";
import { useEffect, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import {
  createAccountRpc,
  refreshAccountsRpc,
  removeAccountRpc,
  renameAccountRpc,
  setDefaultAccountRpc,
  signOutAccountRpc,
  type AccountSummary,
} from "../shared/contracts";
import { AccountCard, type CardAction } from "./AccountCard";
import type { AgentObservation } from "./agents";
import { ConfirmRemove, NameDialog } from "./dialogs";
import { displayLabel } from "./labels";
import { errorMessage, messages } from "./messages";
import { SignIn } from "./signIn";
import { font, radius, space, tint, type Colors } from "./theme";
import { Button, Callout, Card, Muted } from "./ui";
import { useAccounts } from "./useAccounts";

type Dialog =
  | { kind: "add" }
  | { kind: "rename"; account: AccountSummary }
  | { kind: "remove"; account: AccountSummary }
  | { kind: "signIn"; account: AccountSummary };

function EmptyState({ colors, onAdd }: { colors: Colors; onAdd(): void }) {
  const { t } = useTranslation(messages);
  return (
    <View
      style={{
        borderWidth: 1,
        borderStyle: "dashed",
        borderColor: colors.border,
        borderRadius: radius.lg,
        padding: space.xxl,
        alignItems: "center",
        gap: space.md,
      }}
    >
      <View
        style={{
          width: 48,
          height: 48,
          borderRadius: 24,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: tint(colors.accent, 0.14),
        }}
      >
        <Icon name="UserPlus" size={22} color={colors.accent} />
      </View>
      <Text style={{ ...font.heading, color: colors.foreground, textAlign: "center" }}>{t("empty.title")}</Text>
      <Text style={{ ...font.small, color: colors.foregroundMuted, textAlign: "center", maxWidth: 440 }}>{t("empty.body")}</Text>
      <Button colors={colors} variant="primary" icon="Plus" label={t("add")} onPress={onAdd} />
    </View>
  );
}

function HowItWorks({ colors }: { colors: Colors }) {
  const { t } = useTranslation(messages);
  const [open, setOpen] = useState(false);
  const points = [
    { icon: "ArrowLeftRight", title: t("how.switchTitle"), body: t("how.switchBody") },
    { icon: "ListFilter", title: t("how.modelsTitle"), body: t("how.modelsBody") },
    { icon: "ShieldCheck", title: t("how.safetyTitle"), body: t("how.safetyBody") },
  ];
  return (
    <View style={{ gap: space.md }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((value) => !value)}
        style={{ flexDirection: "row", alignItems: "center", gap: space.sm, alignSelf: "flex-start", paddingVertical: space.xs }}
      >
        <Icon name={open ? "ChevronDown" : "ChevronRight"} size={16} color={colors.foregroundMuted} />
        <Text style={{ ...font.small, fontWeight: "600", color: colors.foregroundMuted }}>{t("how.title")}</Text>
      </Pressable>
      {open ? (
        <View style={{ gap: space.lg, paddingLeft: space.xs }}>
          {points.map((point) => (
            <View key={point.icon} style={{ flexDirection: "row", gap: space.md }}>
              <View
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: radius.md,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: tint(colors.foreground, 0.06),
                }}
              >
                <Icon name={point.icon} size={15} color={colors.foreground} />
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={{ ...font.small, fontWeight: "600", color: colors.foreground }}>{point.title}</Text>
                <Muted colors={colors}>{point.body}</Muted>
              </View>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

export function AccountsScreen({ theme, layout, observation }: PluginSurfaceProps & { observation: AgentObservation }) {
  const { colors } = theme;
  const { t } = useTranslation(messages);
  const toast = useToast();
  const { data, error, accept, refetch } = useAccounts();
  const counts = useSyncExternalStore(observation.subscribe, observation.counts);
  const create = useRpc(createAccountRpc);
  const refresh = useRpc(refreshAccountsRpc);
  const rename = useRpc(renameAccountRpc);
  const remove = useRpc(removeAccountRpc);
  const setDefault = useRpc(setDefaultAccountRpc);
  const signOut = useRpc(signOutAccountRpc);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [busy, setBusy] = useState<Record<string, CardAction | null>>({});
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [now, setNow] = useState(Date.now);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  async function track(accountId: string, action: CardAction, task: () => Promise<void>) {
    setBusy((current) => ({ ...current, [accountId]: action }));
    try {
      await task();
    } catch (reason) {
      toast.error(errorMessage(reason));
    } finally {
      setBusy((current) => ({ ...current, [accountId]: null }));
    }
  }

  function onAction(account: AccountSummary, action: CardAction) {
    const input = { accountId: account.id };
    switch (action) {
      case "refresh":
        return void track(account.id, action, async () => { accept(await refresh(input)); });
      case "makeDefault":
        return void track(account.id, action, async () => { accept(await setDefault(input)); });
      case "signOut":
        return void track(account.id, action, async () => { accept(await signOut(input)); });
      case "rename":
        return setDialog({ kind: "rename", account });
      case "remove":
        return setDialog({ kind: "remove", account });
      case "signIn":
        return setDialog({ kind: "signIn", account });
    }
  }

  const compact = layout.compact || (width > 0 && width < 560);
  const columns = width >= 820 ? 2 : 1;
  const gap = compact ? space.md : space.lg;
  const padding = compact ? space.lg : space.xxl;
  const contentWidth = Math.min(Math.max(width - padding * 2, 0), 980);
  const cardWidth = columns === 2 ? (contentWidth - gap) / 2 : contentWidth;
  const profiles = data?.accounts.filter((account) => account.kind === "profile") ?? [];

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface0 }} onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding, alignItems: "center" }}>
        <View style={{ width: contentWidth || "100%", maxWidth: 980, gap: space.xxl }}>
          <View style={{ flexDirection: compact ? "column" : "row", alignItems: compact ? "stretch" : "flex-end", gap: space.lg }}>
            <View style={{ flex: compact ? undefined : 1, gap: space.xs }}>
              <Text accessibilityRole="header" style={{ ...font.title, color: colors.foreground }}>
                {t("title")}
              </Text>
              <Text style={{ ...font.body, color: colors.foregroundMuted }}>{t("subtitle")}</Text>
            </View>
            <View style={{ flexDirection: "row", gap: space.sm }}>
              <Button
                colors={colors}
                variant="secondary"
                icon="RefreshCw"
                label={t("refreshAll")}
                loading={refreshingAll}
                onPress={() => {
                  setRefreshingAll(true);
                  void refresh({})
                    .then(accept)
                    .catch((reason: unknown) => toast.error(errorMessage(reason)))
                    .finally(() => setRefreshingAll(false));
                }}
              />
              <Button colors={colors} variant="primary" icon="Plus" label={t("add")} onPress={() => setDialog({ kind: "add" })} />
            </View>
          </View>

          {error ? (
            <Callout
              colors={colors}
              tone="danger"
              icon="CircleAlert"
              title={error.message}
              action={<Button colors={colors} size="sm" label={t("retry")} onPress={() => void refetch()} />}
            />
          ) : null}

          {!data && !error ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: space.xxl, alignSelf: "center" }}>
              <ActivityIndicator color={colors.accent} />
              <Muted colors={colors}>{t("loading")}</Muted>
            </View>
          ) : null}

          {data ? (
            <>
              {data.problems.length > 0 ? (
                <Callout colors={colors} tone="warning" icon="TriangleAlert" title={t("hostProblems")}>
                  {data.problems.map((problem) => (
                    <Muted key={problem} colors={colors}>
                      {problem}
                    </Muted>
                  ))}
                </Callout>
              ) : null}

              <SettingsCard>
                <SettingsSelect
                  label={t("overview.default")}
                  hint={t("overview.defaultHint")}
                  value={data.defaultAccountId}
                  options={data.accounts.filter((account) => account.usable).map((account) => ({ value: account.id, label: displayLabel(account.label, t) }))}
                  onValueChange={(accountId) => {
                    void setDefault({ accountId })
                      .then(accept)
                      .catch((reason: unknown) => toast.error(errorMessage(reason)));
                  }}
                />
                <SettingsRow label={t("overview.cli")} hint={data.agyPath ?? undefined}>
                  <Text style={{ ...font.small, color: data.agyPath ? colors.foreground : colors.statusWarning }}>
                    {data.agyPath ? t("overview.cliValue", { version: data.agyVersion ?? "?" }) : t("overview.cliMissing")}
                  </Text>
                </SettingsRow>
              </SettingsCard>

              {(() => {
                const fallback = data.accounts.find((account) => account.id === data.defaultAccountId);
                if (!fallback || fallback.kind === "system" || (fallback.usable && fallback.status !== "signed-out")) return null;
                return (
                  <Callout colors={colors} tone="warning" icon="TriangleAlert" title={t("overview.defaultUnavailable", { label: displayLabel(fallback.label, t) })}>
                    <Muted colors={colors}>{t("overview.defaultUnavailableBody")}</Muted>
                  </Callout>
                );
              })()}

              <View style={{ gap: space.md }}>
                <View style={{ flexDirection: "row", alignItems: "baseline", gap: space.sm }}>
                  <Text style={{ ...font.heading, color: colors.foreground }}>{t("accountsHeading")}</Text>
                  <Text style={{ ...font.small, color: colors.foregroundMuted }}>{data.accounts.length}</Text>
                </View>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap }}>
                  {data.accounts.map((account, index) => (
                    <View key={account.id} style={{ width: cardWidth || "100%", zIndex: data.accounts.length - index }}>
                      <AccountCard
                        account={account}
                        colors={colors}
                        count={counts ? (counts.get(account.id) ?? 0) : undefined}
                        now={now}
                        busy={busy[account.id] ?? null}
                        onAction={(action) => onAction(account, action)}
                      />
                    </View>
                  ))}
                </View>
                {profiles.length === 0 ? <EmptyState colors={colors} onAdd={() => setDialog({ kind: "add" })} /> : null}
              </View>

              <Card colors={colors} style={{ padding: space.lg, backgroundColor: "transparent" }}>
                <HowItWorks colors={colors} />
              </Card>
            </>
          ) : null}
        </View>
      </ScrollView>

      {dialog?.kind === "add" ? (
        <NameDialog
          colors={colors}
          title={t("dialog.addTitle")}
          body={t("dialog.addBody")}
          initial=""
          confirmLabel={t("dialog.continue")}
          onClose={() => setDialog(null)}
          onSubmit={async (label) => {
            const result = await create({ label });
            accept(result.state);
            setDialog({ kind: "signIn", account: result.account });
          }}
        />
      ) : null}
      {dialog?.kind === "rename" ? (
        <NameDialog
          colors={colors}
          title={t("dialog.renameTitle")}
          initial={displayLabel(dialog.account.label, t)}
          confirmLabel={t("dialog.save")}
          onClose={() => setDialog(null)}
          onSubmit={async (label) => {
            accept(await rename({ accountId: dialog.account.id, label }));
            setDialog(null);
          }}
        />
      ) : null}
      {dialog?.kind === "remove" ? (
        <ConfirmRemove
          colors={colors}
          label={displayLabel(dialog.account.label, t)}
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            accept(await remove({ accountId: dialog.account.id }));
            setDialog(null);
          }}
        />
      ) : null}
      {dialog?.kind === "signIn" ? (
        <SignIn key={dialog.account.id} account={dialog.account} colors={colors} accept={accept} close={() => setDialog(null)} />
      ) : null}
    </View>
  );
}
