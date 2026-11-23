import { useTranslation, type PluginButtonContentProps } from "@getpaseo/plugin/client";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import type { ContextUsage } from "../shared/contracts";
import { integer, percent, relative, tokens, upper } from "./format";
import { messages } from "./messages";
import { font, space, tabular, tint, toneColor, usedTone } from "./theme";
import { Bar } from "./ui";

/** Latest context usage per agent, shared by pills and popovers. */
class ContextStore {
  private readonly values = new Map<string, ContextUsage | null>();
  private readonly listeners = new Set<() => void>();
  private version = 0;

  get(agentId: string): ContextUsage | null | undefined {
    return this.values.get(agentId);
  }

  set(agentId: string, usage: ContextUsage | null): void {
    const previous = this.values.get(agentId);
    if (previous !== undefined && JSON.stringify(previous) === JSON.stringify(usage)) return;
    this.values.set(agentId, usage);
    this.emit();
  }

  delete(agentId: string): void {
    if (this.values.delete(agentId)) this.emit();
  }

  clear(): void {
    this.values.clear();
    this.emit();
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  snapshot = () => this.version;

  private emit(): void {
    this.version += 1;
    this.listeners.forEach((listener) => listener());
  }
}

export const contextStore = new ContextStore();

function Row({
  label,
  value,
  share,
  colors,
}: {
  label: string;
  value: string;
  share?: string;
  colors: PluginButtonContentProps["theme"]["colors"];
}) {
  return (
    <View style={{ flexDirection: "row", alignItems: "baseline", gap: space.md }}>
      <Text style={{ ...font.small, color: colors.foregroundMuted, flex: 1 }}>{label}</Text>
      {share ? <Text style={{ ...font.caption, ...tabular, color: colors.foregroundMuted }}>{share}</Text> : null}
      <Text style={{ ...font.small, ...tabular, color: colors.foreground, fontWeight: "500", minWidth: 84, textAlign: "right" }}>
        {value}
      </Text>
    </View>
  );
}

export function ContextPopover(props: PluginButtonContentProps) {
  const { theme } = props;
  const { colors } = theme;
  const agentId = props.context === "agent" ? props.agentId : null;
  const { t, locale } = useTranslation(messages);
  useSyncExternalStore(contextStore.subscribe, contextStore.snapshot);
  const usage = agentId ? contextStore.get(agentId) : null;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(timer);
  }, []);

  if (!usage) {
    return (
      <View style={{ width: props.layout.compact ? "100%" : 300, gap: space.sm }}>
        <Text style={{ ...font.heading, color: colors.foreground }}>{t("context.title")}</Text>
        <Text style={{ ...font.small, color: colors.foregroundMuted }}>{t("context.none")}</Text>
      </View>
    );
  }

  const fraction = usage.size ? usage.used / usage.size : null;
  const tone = usedTone(fraction);
  const share = (value: number) => (usage.used > 0 && value > 0 ? percent(value / usage.used, locale) : undefined);
  return (
    <View style={{ width: props.layout.compact ? "100%" : 320, gap: space.lg }}>
      <View style={{ gap: space.xs }}>
        <Text style={{ ...font.overline, color: colors.foregroundMuted }}>{upper(t("context.title"), locale)}</Text>
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: space.sm }}>
          <Text style={{ fontSize: 26, lineHeight: 32, fontWeight: "600", ...tabular, color: colors.foreground }}>
            {tokens(usage.used)}
          </Text>
          {usage.size ? (
            <Text style={{ ...font.body, color: colors.foregroundMuted }}>{t("context.of", { size: tokens(usage.size) })}</Text>
          ) : null}
          <View style={{ flex: 1 }} />
          {fraction !== null ? (
            <Text style={{ ...font.heading, ...tabular, color: toneColor(colors, tone) }}>{percent(fraction, locale)}</Text>
          ) : null}
        </View>
        {fraction !== null ? <Bar colors={colors} fraction={fraction} tone={tone} height={8} /> : null}
      </View>

      <View style={{ gap: space.sm, paddingTop: space.md, borderTopWidth: 1, borderTopColor: tint(colors.foreground, 0.08) }}>
        <Row colors={colors} label={t("context.cached")} value={integer(usage.cached, locale)} share={share(usage.cached)} />
        <Row colors={colors} label={t("context.input")} value={integer(usage.input, locale)} share={share(usage.input)} />
        <Row colors={colors} label={t("context.output")} value={integer(usage.output, locale)} share={share(usage.output)} />
        {usage.size ? (
          <Row
            colors={colors}
            label={t("context.window")}
            value={integer(usage.size, locale)}
            share={usage.sizeSource === "agy" ? t("context.sourceAgy") : t("context.sourceModel")}
          />
        ) : null}
      </View>

      <Text style={{ ...font.caption, color: colors.foregroundMuted }}>
        {t("context.note")}
        {usage.updatedAt
          ? ` ${now - Date.parse(usage.updatedAt) < 45_000 ? t("context.updatedJustNow") : t("context.updated", { time: relative(usage.updatedAt, now, locale) })}`
          : ""}
      </Text>
    </View>
  );
}
