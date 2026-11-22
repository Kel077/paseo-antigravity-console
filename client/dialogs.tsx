import { useRpc, useTranslation } from "@getpaseo/plugin/client";
import { Modal, TextInput } from "@getpaseo/plugin/client/ui";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { RECOVERY_FOLDER_NAME, savedFilesRpc, type SavedFiles } from "../shared/contracts";
import { messages } from "./messages";
import { font, mono, radius, space, tint, type Colors } from "./theme";
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

/** Names shown in the Remove dialog before "and N more". */
const SHOWN_FILES = 4;

function SavedList({ colors, items }: { colors: Colors; items: string[] }) {
  const { t } = useTranslation(messages);
  // "and 1 more" takes the same line the last name would.
  const shown = items.length > SHOWN_FILES + 1 ? items.slice(0, SHOWN_FILES) : items;
  const rest = items.length - shown.length;
  return (
    <View style={{ gap: space.xxs }}>
      {shown.map((item) => (
        <Text key={item} numberOfLines={1} style={{ ...font.caption, fontFamily: mono, color: colors.foregroundMuted }}>
          {item}
        </Text>
      ))}
      {rest > 0 ? <Muted colors={colors} small>{t("dialog.removeMore", { count: rest })}</Muted> : null}
    </View>
  );
}

export function ConfirmRemove({
  colors,
  accountId,
  label,
  onConfirm,
  onClose,
}: {
  colors: Colors;
  accountId: string;
  label: string;
  onConfirm(): Promise<void>;
  onClose(): void;
}) {
  const { t } = useTranslation(messages);
  const listSaved = useRpc(savedFilesRpc);
  // null while checking; "unknown" when the check failed (removal still moves the files).
  const [saved, setSaved] = useState<SavedFiles | "unknown" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    listSaved({ accountId }).then(
      (result) => live && setSaved(result),
      () => live && setSaved("unknown"),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId]);

  return (
    <Modal open title={t("dialog.removeTitle", { label })} onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <Modal.Content>
        <Muted colors={colors}>{t("dialog.removeBody")}</Muted>
        {/* The folder goes on a line of its own, so its spaces never split it. */}
        {saved === "unknown" ? (
          <Callout
            colors={colors}
            tone="neutral"
            icon="FolderInput"
            title={`${t("dialog.removeFilesUnknown")}\n~/${RECOVERY_FOLDER_NAME}`}
          />
        ) : saved && saved.items.length > 0 ? (
          <Callout
            colors={colors}
            tone="neutral"
            icon="FolderInput"
            title={`${t("dialog.removeFiles", { count: saved.items.length })}\n${saved.folder}`}
          >
            <SavedList colors={colors} items={saved.items} />
          </Callout>
        ) : null}
        {error ? <Callout colors={colors} tone="danger" icon="CircleAlert" title={error} /> : null}
        <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: space.sm }}>
          <Button colors={colors} variant="ghost" label={t("dialog.cancel")} disabled={busy} onPress={onClose} />
          <Button
            colors={colors}
            variant="danger"
            icon="Trash2"
            label={t("dialog.removeConfirm")}
            loading={busy}
            disabled={saved === null}
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
