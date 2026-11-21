import { useTranslation } from "@getpaseo/plugin/client";
import { Modal, TextInput } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Text, View } from "react-native";
import { messages } from "./messages";
import { font, radius, space, tint, type Colors } from "./theme";
import { Button, Callout, Muted } from "./ui";

export function NameDialog({
  colors,
  title,
  body,
  initial,
  confirmLabel,
  onSubmit,
  onClose,
}: {
  colors: Colors;
  title: string;
  body?: string;
  initial: string;
  confirmLabel: string;
  onSubmit(name: string): Promise<void>;
  onClose(): void;
}) {
  const { t } = useTranslation(messages);
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const valid = name.trim().length > 0 && name.trim() !== initial.trim();

  async function save() {
    if (!valid || busy) return;
    setBusy(true);
    setError("");
    try {
      await onSubmit(name.trim());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setBusy(false);
    }
  }

  return (
    <Modal open title={title} onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <Modal.Content>
        {body ? <Muted colors={colors}>{body}</Muted> : null}
        <View style={{ gap: space.xs + 2 }}>
          <Text style={{ ...font.small, fontWeight: "500", color: colors.foreground }}>{t("dialog.name")}</Text>
          <TextInput
            accessibilityLabel={t("dialog.name")}
            autoFocus
            maxLength={40}
            value={name}
            editable={!busy}
            onChangeText={setName}
            onSubmitEditing={() => void save()}
            placeholder={t("dialog.namePlaceholder")}
            placeholderTextColor={tint(colors.foregroundMuted, 0.7)}
            style={{
              ...font.body,
              color: colors.foreground,
              backgroundColor: colors.surface0,
              borderColor: colors.border,
              borderWidth: 1,
              borderRadius: radius.md,
              paddingHorizontal: space.md,
              paddingVertical: space.sm + 2,
            }}
          />
        </View>
        {error ? <Callout colors={colors} tone="danger" icon="CircleAlert" title={error} /> : null}
        <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: space.sm }}>
          <Button colors={colors} variant="ghost" label={t("dialog.cancel")} disabled={busy} onPress={onClose} />
          <Button colors={colors} variant="primary" label={confirmLabel} loading={busy} disabled={!valid} onPress={() => void save()} />
        </View>
      </Modal.Content>
    </Modal>
  );
}

export function ConfirmRemove({
  colors,
  label,
  onConfirm,
  onClose,
}: {
  colors: Colors;
  label: string;
  onConfirm(): Promise<void>;
  onClose(): void;
}) {
  const { t } = useTranslation(messages);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal open title={t("dialog.removeTitle", { label })} onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <Modal.Content>
        <Muted colors={colors}>{t("dialog.removeBody")}</Muted>
        {error ? <Callout colors={colors} tone="danger" icon="CircleAlert" title={error} /> : null}
        <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: space.sm }}>
          <Button colors={colors} variant="ghost" label={t("dialog.cancel")} disabled={busy} onPress={onClose} />
          <Button
            colors={colors}
            variant="danger"
            icon="Trash2"
            label={t("dialog.removeConfirm")}
            loading={busy}
            onPress={() => {
              setBusy(true);
              setError("");
              void onConfirm().catch((reason: unknown) => {
                setError(reason instanceof Error ? reason.message : String(reason));
                setBusy(false);
              });
            }}
          />
        </View>
      </Modal.Content>
    </Modal>
  );
}
