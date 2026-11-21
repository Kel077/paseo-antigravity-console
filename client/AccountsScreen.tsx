import { useRpc, useTranslation, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Modal, ScrollView, SettingsSelect, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import { createAccountRpc, refreshAccountsRpc, removeAccountRpc, renameAccountRpc, setDefaultAccountRpc,
  signOutAccountRpc, type AccountSummary } from "../shared/contracts";
import { AccountCard } from "./AccountCard";
import type { AgentObservation } from "./agents";
import { actions, Button, fieldStyle } from "./controls";
import { messages, errorMessage } from "./messages";
import { SignIn } from "./signIn";
import { useAccounts } from "./useAccounts";

type Dialog = { kind: "add" } | { kind: "rename" | "remove" | "login"; account: AccountSummary };

export function AccountsScreen({ theme, layout, observation }: PluginSurfaceProps & { observation: AgentObservation }) {
  const { colors } = theme;
  const { t } = useTranslation(messages);
  const toast = useToast();
  const { data, error, accept, watch, refetch } = useAccounts();
  const counts = useSyncExternalStore(observation.subscribe, observation.counts);
  const create = useRpc(createAccountRpc);
  const refresh = useRpc(refreshAccountsRpc);
  const rename = useRpc(renameAccountRpc);
  const remove = useRpc(removeAccountRpc);
  const setDefault = useRpc(setDefaultAccountRpc);
  const signOut = useRpc(signOutAccountRpc);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [name, setName] = useState("");
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [now, setNow] = useState(Date.now);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const timer = setInterval(() => setNow(Date.now()), 60000);
    return () => { mounted.current = false; clearInterval(timer); };
  }, []);
  function open(next: Dialog) {
    setActionError("");
    setName(next.kind === "rename" ? next.account.label : "");
    setDialog(next);
  }
  async function run<Result>(task: () => Promise<Result>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setActionError("");
    try { await task(); }
    catch (reason) {
      if (mounted.current) {
        setActionError(errorMessage(reason));
        if (!dialog) toast.error(errorMessage(reason));
      }
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function save() {
    if (!dialog || dialog.kind === "login") return;
    if (dialog.kind === "add") {
      const result = await create({ label: name.trim() });
      accept(result.state);
      if (mounted.current) open({ kind: "login", account: result.account });
    } else {
      const accountId = dialog.account.id;
      accept(dialog.kind === "remove" ? await remove({ accountId }) : await rename({ accountId, label: name.trim() }));
      if (mounted.current) setDialog(null);
    }
  }
  const gap = layout.compact ? 12 : 18;
  return <View style={{ flex: 1, backgroundColor: colors.surface0 }}>
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: gap, gap }}>
      {data?.agyVersion && <Text style={{ color: colors.foregroundMuted }}>{t("version", { version: data.agyVersion })}</Text>}
      {!!data?.problems.length && <View style={{ gap: 6, borderLeftWidth: 3, borderColor: colors.statusWarning, paddingLeft: 12 }}>
        <Text style={{ color: colors.statusWarning, fontWeight: "600" }}>{t("hostProblems")}</Text>
        {data.problems.map((p, i) => <Text key={i} selectable style={{ color: colors.foreground }}>{p}</Text>)}
      </View>}
      {watch.status === "error" && <Text style={{ color: colors.statusWarning }}>{watch.error.message}</Text>}
      {error && <View style={{ gap: 8 }}>
        <Text selectable style={{ color: colors.statusDanger }}>{error.message}</Text>
        <Button colors={colors} label={t("retry")} onPress={() => { void refetch(); }} />
      </View>}
      {!data && !error && <Text style={{ color: colors.foregroundMuted }}>{t("working")}</Text>}
      {data && <>
        <SettingsSelect label={t("defaultFor")} disabled={busy} value={data.defaultAccountId}
          options={data.accounts.map(a => ({ value: a.id, label: a.label }))}
          onValueChange={accountId => { void run(async () => accept(await setDefault({ accountId }))); }} />
        <View style={actions}>
          <Button colors={colors} disabled={busy} label={t("add")} onPress={() => open({ kind: "add" })} />
          <Button colors={colors} disabled={busy} label={t("refreshAll")} onPress={() => run(async () => accept(await refresh({})))} />
        </View>
        {busy && !dialog && <Text style={{ color: colors.foregroundMuted }}>{t("working")}</Text>}
        {data.accounts.map(account => {
          const input = { accountId: account.id };
          return <AccountCard key={account.id} account={account} colors={colors} now={now} compact={layout.compact}
            count={counts ? counts.get(account.id) ?? 0 : undefined}>
            <Button colors={colors} label={t("refresh")} disabled={busy} onPress={() => run(async () => accept(await refresh(input)))} />
            <Button colors={colors} label={t("rename")} disabled={busy} onPress={() => open({ kind: "rename", account })} />
            {!account.isDefaultForNewAgents && <Button colors={colors} label={t("makeDefault")} disabled={busy}
              onPress={() => run(async () => accept(await setDefault(input)))} />}
            {account.kind === "profile" && <>
              <Button colors={colors} label={t(account.status === "signed-in" ? "again" : "signIn")} disabled={busy}
                onPress={() => open({ kind: "login", account })} />
              <Button colors={colors} label={t("signOut")} disabled={busy || account.status === "signed-out"}
                onPress={() => run(async () => accept(await signOut(input)))} />
              <Button colors={colors} label={t("remove")} danger disabled={busy} onPress={() => open({ kind: "remove", account })} />
            </>}
          </AccountCard>;
        })}
        <Text accessibilityRole="header" style={{ color: colors.foreground, fontWeight: "600" }}>{t("notes")}</Text>
        <Text style={{ color: colors.foregroundMuted }}>{t("limits")}</Text>
      </>}
    </ScrollView>
    {dialog?.kind === "login" && <SignIn key={dialog.account.id} account={dialog.account} colors={colors} accept={accept} close={() => setDialog(null)} />}
    {dialog && dialog.kind !== "login" && <Modal open title={t(dialog.kind)} onOpenChange={open => { if (!open && !lock.current) setDialog(null); }}>
      <Modal.Content>
        {dialog.kind === "remove" ? <Text style={{ color: colors.foreground }}>{t("removeBody", { label: dialog.account.label })}</Text>
        : <>
          <Text style={{ color: colors.foreground }}>{t("name")}</Text>
          <TextInput accessibilityLabel={t("name")} autoFocus maxLength={40} value={name} onChangeText={setName}
            editable={!busy} style={fieldStyle(colors)} onSubmitEditing={() => { if (name.trim()) void run(save); }} />
        </>}
        {!!actionError && <Text selectable style={{ color: colors.statusDanger }}>{actionError}</Text>}
        <View style={actions}>
          <Button colors={colors} danger={dialog.kind === "remove"} label={t(busy ? "working" : dialog.kind === "remove" ? "remove" : "save")}
            disabled={busy || (dialog.kind !== "remove" && !name.trim())} onPress={() => run(save)} />
          <Button colors={colors} label={t("cancel")} disabled={busy} onPress={() => setDialog(null)} />
        </View>
      </Modal.Content>
    </Modal>}
  </View>;
}
