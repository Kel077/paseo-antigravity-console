import type { RpcOutput } from "@getpaseo/plugin";
import { useRpc, useTranslation } from "@getpaseo/plugin/client";
import { copyText, ExternalLink, Modal, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { cancelSignInRpc, startSignInRpc, submitSignInRpc, type AccountSummary, type AccountsState } from "../shared/contracts";
import { actions, Button, fieldStyle, type Colors } from "./controls";
import { errorMessage, messages } from "./messages";

type StartSignIn = typeof startSignInRpc;
type Session = RpcOutput<StartSignIn>;

export function SignIn({ account, colors, accept, close }: {
  account: AccountSummary; colors: Colors; accept(state: AccountsState): void; close(): void;
}) {
  const start = useRpc(startSignInRpc);
  const submit = useRpc(submitSignInRpc);
  const cancel = useRpc(cancelSignInRpc);
  const toast = useToast();
  const { t, locale } = useTranslation(messages);
  const [session, setSession] = useState<Session | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const active = useRef(false);
  const login = useRef<Session["loginId"] | null>(null);
  const submitting = useRef(false);
  const closing = useRef(false);
  useEffect(() => {
    let disposed = false;
    active.current = true;
    setError("");
    setSession(null);
    void start({ accountId: account.id }).then(result => {
      if (disposed) return cancel({ loginId: result.loginId }).then(() => {});
      login.current = result.loginId;
      setSession(result);
    }).catch(reason => { if (!disposed) setError(errorMessage(reason)); });
    return () => {
      disposed = true;
      active.current = false;
      const loginId = login.current;
      login.current = null;
      if (loginId) void cancel({ loginId }).catch(() => {});
    };
  }, [account.id, attempt, start, cancel]);

  async function dismiss() {
    if (closing.current) return;
    closing.current = true;
    try {
      if (login.current) await cancel({ loginId: login.current });
      login.current = null;
      if (active.current) close();
    } catch (reason) {
      closing.current = false;
      if (active.current) setError(errorMessage(reason));
    }
  }
  async function finish() {
    if (!login.current || closing.current || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      const state = await submit({ loginId: login.current, code: code.trim() });
      login.current = null;
      accept(state);
      if (active.current && !closing.current) {
        toast.show(t("signedIn", { label: account.label }), { variant: "success" });
        close();
      }
    } catch (reason) {
      if (active.current && !closing.current) setError(errorMessage(reason));
    } finally {
      submitting.current = false;
      if (active.current) setBusy(false);
    }
  }
  return <Modal open title={t("loginTitle", { label: account.label })} onOpenChange={open => { if (!open) void dismiss(); }}>
    <Modal.Content>
      {session ? <>
        <ExternalLink href={session.url} onError={reason => setError(errorMessage(reason))}>{t("open")}</ExternalLink>
        <Button colors={colors} label={t("copy")} onPress={() => {
          void copyText(session.url).then(() => toast.show(t("copied"))).catch(reason => setError(errorMessage(reason)));
        }} />
        <Text style={{ color: colors.foregroundMuted }}>{t("expires", { time: new Date(session.expiresAt).toLocaleString(locale) })}</Text>
        <Text style={{ color: colors.foreground }}>{t("code")}</Text>
        <TextInput accessibilityLabel={t("code")} autoCapitalize="none" autoCorrect={false} maxLength={16384}
          editable={!busy} value={code} onChangeText={setCode} style={fieldStyle(colors)} />
      </> : !error && <Text style={{ color: colors.foregroundMuted }}>{t("working")}</Text>}
      {busy && <Text accessibilityLiveRegion="polite" style={{ color: colors.foreground }}>{t("waiting")}</Text>}
      {!!error && <Text selectable style={{ color: colors.statusDanger }}>{error}</Text>}
      <View style={actions}>
        {session && <Button label={t("submit")} colors={colors} disabled={busy || !code.trim()} onPress={finish} />}
        {!!error && !busy && <Button label={t("again")} colors={colors} onPress={() => { setCode(""); setAttempt(n => n + 1); }} />}
        <Button label={t("cancel")} colors={colors} onPress={dismiss} />
      </View>
    </Modal.Content>
  </Modal>;
}
