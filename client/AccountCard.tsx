import { useTranslation } from "@getpaseo/plugin/client";
import { Text, View } from "react-native";
import type { ReactNode } from "react";
import type { AccountSummary } from "../shared/contracts";
import { messages } from "./messages";
import { actions, type Colors } from "./controls";

export function AccountCard({ account, colors, count, now, children, compact }: {
  account: AccountSummary; colors: Colors; count?: number; now: number; children: ReactNode; compact: boolean;
}) {
  const { t, locale } = useTranslation(messages);
  const chip = { paddingVertical: 3, paddingHorizontal: 8, borderRadius: 12, backgroundColor: colors.surface2 };
  const statusColor = account.status === "signed-in" ? colors.statusSuccess :
    account.status === "error" ? colors.statusDanger : colors.foregroundMuted;
  function resetLabel(timestamp: string) {
    const minutes = Math.ceil((Date.parse(timestamp) - now) / 60000);
    if (!Number.isFinite(minutes)) return timestamp;
    if (minutes <= 0) return t("resetDue");
    if (typeof Intl.RelativeTimeFormat !== "function") {
      return t("resetAt", { time: new Date(timestamp).toLocaleString(locale) });
    }
    const unit = minutes < 60 ? "minute" : minutes < 1440 ? "hour" : "day";
    const value = minutes / (unit === "minute" ? 1 : unit === "hour" ? 60 : 1440);
    return t("reset", { time: new Intl.RelativeTimeFormat(locale).format(Math.ceil(value), unit) });
  }
  return <View style={{ padding: compact ? 12 : 18, gap: 10, borderWidth: 1, borderRadius: 10,
    borderColor: account.usable ? colors.border : colors.statusWarning, backgroundColor: colors.surface1 }}>
    <Text accessibilityRole="header" style={{ color: colors.foreground, fontWeight: "600", fontSize: 18 }}>{account.label}</Text>
    <View style={actions}>
      <Text style={{ ...chip, color: colors.foregroundMuted }}>{t(account.kind)}</Text>
      <Text style={{ ...chip, color: statusColor }}>{t(account.status)}</Text>
    </View>
    {!!account.email && <Text selectable style={{ color: colors.foreground }}>{account.email}</Text>}
    {!account.usable && <Text style={{ color: colors.statusWarning, fontWeight: "700" }}>{t("unusable")}</Text>}
    {!!account.statusDetail && <Text selectable style={{ color: account.usable ? colors.foregroundMuted : colors.statusWarning }}>{account.statusDetail}</Text>}
    {account.quota?.map((group, i) => <View key={i} style={{ gap: 8 }}>
      <Text style={{ color: colors.foreground, fontWeight: "600" }}>{group.name}</Text>
      {group.buckets.map(bucket => {
        const fraction = bucket.remainingFraction;
        const remaining = fraction === null ? t("noQuota") : t("quota", {
          value: new Intl.NumberFormat(locale, { style: "percent" }).format(fraction),
        });
        const details = [bucket.name, bucket.window, remaining, bucket.disabled && t("disabled"),
          bucket.resetTime && resetLabel(bucket.resetTime)].filter(Boolean).join(" · ");
        return <View key={bucket.id} style={{ gap: 4 }}>
          <Text style={{ color: bucket.disabled ? colors.foregroundMuted : colors.foreground }}>{details}</Text>
          {fraction !== null && <View style={{ backgroundColor: colors.surface2, height: 5, borderRadius: 3 }}>
            <View style={{ height: 5, borderRadius: 3, width: `${fraction * 100}%`,
              backgroundColor: bucket.disabled ? colors.foregroundMuted : colors.accent }} />
          </View>}
        </View>;
      })}
    </View>)}
    <Text style={{ color: colors.foregroundMuted }}>
      {[account.checkedAt ? t("checked", { time: new Date(account.checkedAt).toLocaleString(locale) }) : t("never"),
        count === undefined ? t("countPending") : t("agents", { count })].join(" · ")}
    </Text>
    <View style={actions}>{children}</View>
  </View>;
}
