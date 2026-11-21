import { useTranslation } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { AccountSummary, QuotaBucket, QuotaGroup } from "../shared/contracts";
import { percent, relative } from "./format";
import { displayLabel } from "./labels";
import { messages } from "./messages";
import { font, radius, remainingTone, space, tabular, tint, type Colors, type Tone } from "./theme";
import { Avatar, Badge, Bar, Button, Callout, Card, Divider, IconButton, Muted } from "./ui";

export type CardAction = "refresh" | "rename" | "makeDefault" | "signIn" | "signOut" | "remove";

function statusTone(account: AccountSummary): Tone {
  if (!account.usable) return "warning";
  switch (account.status) {
    case "signed-in":
      return "success";
    case "error":
      return "danger";
    default:
      return "neutral";
  }
}

function QuotaRows({ colors, group, now, locale }: { colors: Colors; group: QuotaGroup; now: number; locale: string }) {
  const { t } = useTranslation(messages);
  const windows = group.buckets.map((bucket) => bucket.window.trim().toLowerCase());
  const label = (bucket: QuotaBucket, index: number) => {
    const key = windows[index];
    const known = key === "weekly" || key === "5h" || key === "daily" || key === "monthly";
    const base = known ? t(`window.${key}`) : bucket.window;
    // Two buckets with the same period in one group (rare): tell them apart by name.
    return windows.indexOf(key!) !== windows.lastIndexOf(key!) ? `${base} · ${bucket.name}` : base;
  };
  return (
    <View style={{ gap: space.sm }}>
      <Text style={{ ...font.overline, color: colors.foregroundMuted }}>{group.name.toLocaleUpperCase(locale)}</Text>
      {group.buckets.map((bucket, index) => {
        const fraction = bucket.remainingFraction;
        const tone = bucket.disabled ? "neutral" : remainingTone(fraction);
        return (
          <View key={bucket.id} style={{ gap: 4 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
              <Text numberOfLines={1} style={{ ...font.small, color: colors.foreground, width: 76 }}>
                {label(bucket, index)}
              </Text>
              <View style={{ flex: 1 }}>
                <Bar colors={colors} fraction={bucket.disabled ? 0 : (fraction ?? 0)} tone={tone} />
              </View>
              <Text
                style={{
                  ...font.small,
                  ...tabular,
                  width: 52,
                  textAlign: "right",
                  fontWeight: "600",
                  color: bucket.disabled ? colors.foregroundMuted : colors.foreground,
                }}
              >
                {bucket.disabled ? t("off") : fraction === null ? "—" : percent(fraction, locale)}
              </Text>
            </View>
            {bucket.resetTime && !bucket.disabled ? (
              <Text style={{ ...font.caption, color: colors.foregroundMuted, marginLeft: 76 + space.md }}>
                {t("resets", { time: relative(bucket.resetTime, now, locale) })}
              </Text>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

function Menu({
  colors,
  items,
  onSelect,
}: {
  colors: Colors;
  items: Array<{ id: CardAction; label: string; icon: string; danger?: boolean }>;
  onSelect(action: CardAction): void;
}) {
  return (
    <Card
      colors={colors}
      elevated
      style={{ position: "absolute", top: 44, right: space.md, minWidth: 200, padding: space.xs, zIndex: 20, backgroundColor: colors.surface0 }}
    >
      {items.map((item) => (
        <Pressable
          key={item.id}
          accessibilityRole="menuitem"
          onPress={() => onSelect(item.id)}
          style={(state) => ({
            flexDirection: "row",
            alignItems: "center",
            gap: space.sm + 2,
            paddingHorizontal: space.md,
            height: 34,
            borderRadius: radius.sm,
            backgroundColor:
              state.pressed || (state as { hovered?: boolean }).hovered ? tint(colors.foreground, 0.07) : "transparent",
          })}
        >
          <Icon name={item.icon} size={15} color={item.danger ? colors.statusDanger : colors.foregroundMuted} />
          <Text style={{ ...font.small, color: item.danger ? colors.statusDanger : colors.foreground }}>{item.label}</Text>
        </Pressable>
      ))}
    </Card>
  );
}

export function AccountCard({
  account,
  colors,
  count,
  now,
  busy,
  onAction,
}: {
  account: AccountSummary;
  colors: Colors;
  count: number | undefined;
  now: number;
  busy: CardAction | null;
  onAction(action: CardAction): void;
}) {
  const { t, locale } = useTranslation(messages);
  const [menuOpen, setMenuOpen] = useState(false);
  const isProfile = account.kind === "profile";
  const signedIn = account.status === "signed-in";
  const tone = statusTone(account);
  const statusLabel = account.usable ? t(`status.${account.status}`) : t("callout.unusableTitle");
  const name = displayLabel(account.label, t);
  const justChecked = account.checkedAt !== null && now - Date.parse(account.checkedAt) < 45_000;

  const menuItems: Array<{ id: CardAction; label: string; icon: string; danger?: boolean }> = [
    { id: "rename", label: t("action.rename"), icon: "PenLine" },
  ];
  if (!account.isDefaultForNewAgents && account.usable) {
    menuItems.push({ id: "makeDefault", label: t("action.makeDefault"), icon: "Star" });
  }
  if (isProfile) {
    if (signedIn) menuItems.push({ id: "signIn", label: t("action.signInAgain"), icon: "LogIn" });
    if (account.status !== "signed-out") menuItems.push({ id: "signOut", label: t("action.signOut"), icon: "LogOut" });
    menuItems.push({ id: "remove", label: t("action.remove"), icon: "Trash2", danger: true });
  }

  const select = (action: CardAction) => {
    setMenuOpen(false);
    onAction(action);
  };

  return (
    <Card colors={colors} style={{ zIndex: menuOpen ? 10 : 0, overflow: "visible" }}>
      <View style={{ padding: space.lg, gap: space.md }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
          <Avatar colors={colors} label={name} icon={isProfile ? undefined : "KeyRound"} />
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
              <Text numberOfLines={1} style={{ ...font.heading, color: colors.foreground, flexShrink: 1 }}>
                {name}
              </Text>
              {account.isDefaultForNewAgents ? (
                <Badge colors={colors} label={t("badgeDefault")} tone="accent" icon="Star" />
              ) : null}
            </View>
            <Text numberOfLines={1} selectable style={{ ...font.small, color: colors.foregroundMuted }}>
              {(isProfile && account.status === "signed-out" ? null : account.email) ?? t(`kind.${account.kind}`)}
            </Text>
          </View>
          <IconButton colors={colors} icon="Ellipsis" label={t("action.more")} active={menuOpen} onPress={() => setMenuOpen((open) => !open)} />
        </View>

        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs + 2 }}>
          <Badge colors={colors} label={statusLabel} tone={tone} dot />
          <Badge colors={colors} label={t(`kind.${account.kind}`)} icon={isProfile ? "UserRound" : "KeyRound"} />
          {count !== undefined ? <Badge colors={colors} label={t("agents", { count })} icon="Bot" /> : null}
        </View>

        {!account.usable ? (
          <Callout colors={colors} tone="warning" icon="ShieldAlert" title={t("callout.unusableTitle")}>
            {account.statusDetail ? <Muted colors={colors}>{account.statusDetail}</Muted> : null}
          </Callout>
        ) : account.status === "signed-out" ? (
          <Callout
            colors={colors}
            tone="neutral"
            icon="LogIn"
            title={t("callout.signedOutTitle")}
            action={
              isProfile ? (
                <Button colors={colors} variant="primary" size="sm" icon="LogIn" label={t("action.signIn")} onPress={() => onAction("signIn")} />
              ) : undefined
            }
          >
            <Muted colors={colors}>{isProfile ? t("callout.signedOutBody") : t("callout.systemSignedOutBody")}</Muted>
          </Callout>
        ) : account.status === "error" ? (
          <Callout colors={colors} tone="danger" icon="CircleAlert" title={t("callout.errorTitle")}>
            {account.statusDetail ? <Muted colors={colors}>{account.statusDetail}</Muted> : null}
          </Callout>
        ) : null}

        {signedIn && account.quota ? (
          <>
            <Divider colors={colors} />
            {account.quota.length === 0 ? (
              <Muted colors={colors}>{t("noQuota")}</Muted>
            ) : (
              <View style={{ gap: space.lg }}>
                {account.quota.map((group) => (
                  <QuotaRows key={group.name} colors={colors} group={group} now={now} locale={locale} />
                ))}
              </View>
            )}
          </>
        ) : null}

        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, marginTop: space.xs }}>
          <View style={{ flex: 1 }}>
            <Muted colors={colors} small>
              {justChecked
                ? t("checkedJustNow")
                : account.checkedAt
                  ? t("checked", { time: relative(account.checkedAt, now, locale) })
                  : t("neverChecked")}
            </Muted>
          </View>
          <IconButton
            colors={colors}
            icon="RefreshCw"
            label={t("action.refresh")}
            loading={busy === "refresh"}
            disabled={busy !== null}
            onPress={() => onAction("refresh")}
          />
        </View>
      </View>
      {menuOpen ? <Menu colors={colors} items={menuItems} onSelect={select} /> : null}
    </Card>
  );
}
