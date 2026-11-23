import { useRpc, useTranslation } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import {
  usageStatsRpc,
  type AccountSummary,
  type StatsRange,
  type StatsScope,
  type UsageStats,
  type UsageTotals,
} from "../shared/contracts";
import { clockTime, integer, monthDay, percent, tokens, usd, usdShort } from "./format";
import { displayLabel } from "./labels";
import { messages } from "./messages";
import { PricingDialog } from "./pricing";
import { font, radius, space, tabular, tint, type Colors } from "./theme";
import { Bar, Button, Card, Muted } from "./ui";

type PressState = { pressed: boolean; hovered?: boolean };
type ChartMetric = "requests" | "cost" | "tokens" | "tps" | "cache" | "firstToken";

/** Derived figures; null where the sums cannot support them. */
function derive(totals: UsageTotals) {
  const prompt = totals.input + totals.cached;
  return {
    requests: totals.requests,
    cost: totals.pricedRequests > 0 ? totals.cost : null,
    costPerRequest: totals.pricedRequests > 0 ? totals.cost / totals.pricedRequests : null,
    totalTokens: prompt + totals.output,
    tps: totals.generationSeconds > 0 ? totals.output / totals.generationSeconds : null,
    cacheRate: prompt > 0 ? totals.cached / prompt : null,
    firstToken: totals.requests > 0 ? totals.firstTokenSeconds / totals.requests : null,
    context: totals.requests > 0 ? prompt / totals.requests : null,
    output: totals.requests > 0 ? totals.output / totals.requests : null,
  };
}

function secondsLabel(value: number | null): string {
  if (value === null) return "—";
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} s`;
}

function tpsLabel(value: number | null): string {
  return value === null ? "—" : String(Math.round(value));
}

/** The smallest clean step at or above `value`; halves stay round. */
function niceCeiling(value: number, allowFraction = false): number {
  if (value <= 0) return allowFraction ? 1 : 2;
  if (allowFraction && value < 0.01) {
    const exp = Math.floor(Math.log10(value));
    const base = 10 ** exp;
    for (const step of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
      if (step * base >= value) return step * base;
    }
    return 10 * base;
  }
  if (!allowFraction && value <= 2) return 2;
  const exponent = Math.floor(Math.log10(value));
  const base = 10 ** exponent;
  for (const step of [1, 1.2, 1.6, 2, 2.4, 3, 4, 5, 6, 8, 10]) {
    const candidate = step * base;
    if (candidate >= value && (allowFraction || Number.isInteger(candidate / 2))) return candidate;
  }
  return 10 * base;
}

function metricValue(bin: UsageTotals, metric: ChartMetric): number {
  const figures = derive(bin);
  switch (metric) {
    case "requests":
      return bin.requests;
    case "cost":
      return bin.cost;
    case "tokens":
      return figures.totalTokens;
    case "tps":
      return figures.tps ?? 0;
    case "cache":
      return figures.cacheRate ?? 0;
    case "firstToken":
      return figures.firstToken ?? 0;
  }
}

function formatAxisTick(value: number, metric: ChartMetric, locale: string): string {
  switch (metric) {
    case "requests":
      return integer(Math.round(value), locale);
    case "cost":
      return usdShort(value);
    case "tokens":
      return tokens(Math.round(value));
    case "tps":
      return String(Math.round(value));
    case "cache":
      return percent(value, locale);
    case "firstToken":
      return value === 0 ? "0" : `${value < 10 ? value.toFixed(1) : Math.round(value)}s`;
  }
}

function SegmentedControl<T extends string>({
  colors,
  value,
  options,
  onChange,
}: {
  colors: Colors;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange(next: T): void;
}) {
  return (
    <View
      accessibilityRole="tablist"
      style={{ flexDirection: "row", flexWrap: "wrap", padding: 2, borderRadius: radius.md, backgroundColor: tint(colors.foreground, 0.06) }}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            onPress={() => onChange(option.value)}
            style={(state) => ({
              paddingHorizontal: space.md,
              height: 28,
              justifyContent: "center",
              borderRadius: radius.sm,
              backgroundColor: selected
                ? colors.surface0
                : (state as PressState).hovered
                  ? tint(colors.foreground, 0.05)
                  : "transparent",
              borderWidth: selected ? 1 : 0,
              borderColor: colors.border,
            })}
          >
            <Text style={{ ...font.small, fontWeight: selected ? "600" : "400", color: selected ? colors.foreground : colors.foregroundMuted }}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Columns in the de-emphasis gray with the current bin in the accent. Zero draws nothing. */
function MiniColumns({ colors, values }: { colors: Colors; values: ReadonlyArray<number | null> }) {
  const peak = Math.max(0, ...values.map((value) => value ?? 0));
  const last = values.length - 1;
  return (
    <View style={{ height: 28, flexDirection: "row", alignItems: "flex-end", gap: 2, borderBottomWidth: 1, borderBottomColor: tint(colors.foreground, 0.1) }}>
      {values.map((value, index) => (
        <View key={index} style={{ flex: 1, height: "100%", justifyContent: "flex-end" }}>
          {value && peak > 0 ? (
            <View
              style={{
                height: Math.max(2, (value / peak) * 26),
                borderTopLeftRadius: 2,
                borderTopRightRadius: 2,
                backgroundColor: index === last ? colors.accent : tint(colors.foreground, 0.2),
              }}
            />
          ) : null}
        </View>
      ))}
    </View>
  );
}

function StatTile({
  colors,
  label,
  value,
  unit,
  foot,
  width,
  children,
}: {
  colors: Colors;
  label: string;
  value: string;
  unit?: string;
  foot: string;
  width: number | "100%";
  children: ReactNode;
}) {
  return (
    <Card colors={colors} style={{ width, padding: space.lg, gap: space.sm }}>
      <Text numberOfLines={1} style={{ ...font.small, color: colors.foregroundMuted }}>
        {label}
      </Text>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: space.xs }}>
        <Text numberOfLines={1} style={{ fontSize: 26, lineHeight: 32, fontWeight: "600", ...tabular, color: colors.foreground }}>
          {value}
        </Text>
        {unit ? <Text style={{ ...font.small, color: colors.foregroundMuted }}>{unit}</Text> : null}
      </View>
      <Text numberOfLines={1} style={{ ...font.caption, color: colors.foregroundMuted }}>
        {foot}
      </Text>
      <View style={{ height: 28, justifyContent: "flex-end", marginTop: space.xs }}>{children}</View>
    </Card>
  );
}

function binLabel(start: number, end: number, binMs: number, locale: string): string {
  const day = monthDay(start, locale);
  if (binMs >= 86_400_000) return day;
  const time = clockTime(start, locale);
  const endText = clockTime(end, locale);
  return `${day} ${time}–${endText}`;
}

function tickLabel(start: number, binMs: number, locale: string): string {
  if (binMs >= 86_400_000 || binMs >= 6 * 3_600_000) {
    return monthDay(start, locale);
  }
  return clockTime(start, locale);
}

function showsTick(start: number, binMs: number, index: number, total: number): boolean {
  if (index === 0 || index === total - 1) return false;
  const date = new Date(start);
  if (binMs >= 86_400_000) return index % 5 === 0;
  if (binMs >= 6 * 3_600_000) return date.getHours() === 0;
  return date.getHours() % 6 === 0;
}

function MetricChart({
  colors,
  stats,
  metric,
  onMetricChange,
  locale,
  compact,
}: {
  colors: Colors;
  stats: UsageStats;
  metric: ChartMetric;
  onMetricChange(metric: ChartMetric): void;
  locale: string;
  compact: boolean;
}) {
  const { t } = useTranslation(messages);
  const [hovered, setHovered] = useState<number | null>(null);
  const bins = stats.bins;

  useEffect(() => {
    setHovered(null);
  }, [stats.range, bins.length]);

  const lastActive = useMemo(() => {
    for (let index = bins.length - 1; index >= 0; index -= 1) if (bins[index]!.requests > 0) return index;
    return Math.max(0, bins.length - 1);
  }, [bins]);
  const selected = hovered !== null && hovered < bins.length ? hovered : lastActive;
  const rawValues = bins.map((entry) => metricValue(entry, metric));
  const maxVal = Math.max(0, ...rawValues);
  const peak = metric === "cache" ? 1 : niceCeiling(maxVal, metric === "firstToken" || metric === "cost");
  const chartHeight = 132;
  const plotTop = 8;
  const plotHeight = chartHeight - plotTop - 4;
  const topLabel = formatAxisTick(peak, metric, locale);
  const axisWidth = Math.max(28, topLabel.length * 7.5);
  const bin = bins[selected];
  const figures = bin ? derive(bin) : null;
  const readout = !bin
    ? ""
    : bin.requests === 0
      ? t("stats.noRequests")
      : [
          t("stats.readoutRequests", { count: bin.requests }),
          figures?.cost !== null && figures?.cost !== undefined ? usd(figures.cost, locale) : null,
          figures ? t("stats.readoutTokens", { value: tokens(figures.totalTokens) }) : null,
          figures?.tps !== null && figures?.tps !== undefined ? t("stats.readoutTps", { value: tpsLabel(figures.tps) }) : null,
          figures?.cacheRate !== null && figures?.cacheRate !== undefined ? t("stats.readoutCache", { value: percent(figures.cacheRate, locale) }) : null,
          figures?.firstToken !== null && figures?.firstToken !== undefined ? t("stats.readoutFirstToken", { value: secondsLabel(figures.firstToken) }) : null,
        ]
          .filter(Boolean)
          .join(" · ");
  const periodKey = stats.binMs >= 86_400_000 ? "stats.perDay" : stats.binMs >= 6 * 3_600_000 ? "stats.perSixHours" : "stats.perHour";
  const metricOptions: Array<{ value: ChartMetric; label: string }> = [
    { value: "requests", label: t("stats.metric.requests") },
    { value: "cost", label: t("stats.metric.cost") },
    { value: "tokens", label: t("stats.metric.tokens") },
    { value: "tps", label: t("stats.metric.tps") },
    { value: "cache", label: t("stats.metric.cache") },
    { value: "firstToken", label: t("stats.metric.firstToken") },
  ];

  return (
    <Card colors={colors} style={{ padding: space.lg, gap: space.md }}>
      <View style={{ flexDirection: compact ? "column" : "row", alignItems: compact ? "flex-start" : "center", gap: space.sm }}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "baseline",
            gap: space.sm,
            flex: compact ? undefined : 1,
            alignSelf: compact ? "stretch" : undefined,
            minWidth: 0,
          }}
        >
          <Text style={{ ...font.heading, color: colors.foreground }}>{t(periodKey)}</Text>
          <Text numberOfLines={compact ? 2 : 1} style={{ ...font.small, color: colors.foregroundMuted, flexShrink: 1 }}>
            {bin ? `${binLabel(bin.start, bin.end, stats.binMs, locale)}  ` : ""}
            <Text style={{ color: colors.foreground, ...tabular }}>{readout}</Text>
          </Text>
        </View>
        <SegmentedControl colors={colors} value={metric} options={metricOptions} onChange={onMetricChange} />
      </View>

      <View style={{ flexDirection: "row", gap: space.sm }}>
        <View style={{ width: axisWidth, height: chartHeight }}>
          {[peak, peak / 2, 0].map((tick, index) => (
            <Text
              key={index}
              style={{
                ...font.caption,
                ...tabular,
                color: colors.foregroundMuted,
                position: "absolute",
                right: 0,
                top: plotTop + (index * plotHeight) / 2 - 8,
                lineHeight: 16,
              }}
            >
              {formatAxisTick(tick, metric, locale)}
            </Text>
          ))}
        </View>
        <View style={{ flex: 1 }}>
          <View style={{ height: chartHeight }}>
            <View style={{ position: "absolute", left: 0, right: 0, top: plotTop, height: 1, backgroundColor: tint(colors.foreground, 0.07) }} />
            <View style={{ position: "absolute", left: 0, right: 0, top: plotTop + plotHeight / 2, height: 1, backgroundColor: tint(colors.foreground, 0.07) }} />
            <View style={{ position: "absolute", left: 0, right: 0, top: plotTop + plotHeight, height: 1, backgroundColor: tint(colors.foreground, 0.18) }} />
            <View style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: chartHeight - plotTop - plotHeight, flexDirection: "row" }}>
              {bins.map((entry, index) => {
                const active = index === selected;
                const val = rawValues[index] ?? 0;
                const height = val > 0 && peak > 0 ? Math.max(3, Math.min(1, val / peak) * plotHeight) : 0;
                return (
                  <Pressable
                    key={entry.start}
                    accessibilityRole="button"
                    accessibilityLabel={`${binLabel(entry.start, entry.end, stats.binMs, locale)}: ${t("stats.readoutRequests", { count: entry.requests })}`}
                    onHoverIn={() => setHovered(index)}
                    onHoverOut={() => setHovered((current) => (current === index ? null : current))}
                    onPressIn={() => setHovered(index)}
                    style={(state) => ({
                      flex: 1,
                      height: "100%",
                      alignItems: "center",
                      justifyContent: "flex-end",
                      backgroundColor: (state as PressState).hovered ? tint(colors.foreground, 0.03) : "transparent",
                    })}
                  >
                    {height > 0 ? (
                      <View
                        style={{
                          width: "62%",
                          maxWidth: 24,
                          height,
                          borderTopLeftRadius: 4,
                          borderTopRightRadius: 4,
                          backgroundColor: active ? colors.accent : tint(colors.accent, 0.35),
                        }}
                      />
                    ) : null}
                  </Pressable>
                );
              })}
            </View>
          </View>
          <View style={{ flexDirection: "row", marginTop: space.xs, height: 16 }}>
            {bins.map((entry, index) => (
              <View key={entry.start} style={{ flex: 1, alignItems: "center" }}>
                {showsTick(entry.start, stats.binMs, index, bins.length) ? (
                  <View pointerEvents="none" style={{ position: "absolute", width: 72, alignItems: "center" }}>
                    <Text style={{ ...font.caption, ...tabular, color: colors.foregroundMuted }}>
                      {tickLabel(entry.start, stats.binMs, locale)}
                    </Text>
                  </View>
                ) : null}
              </View>
            ))}
          </View>
        </View>
      </View>
    </Card>
  );
}

function ModelTable({
  colors,
  stats,
  locale,
  wide,
  selectedModel,
  onSelectModel,
  onEditPricing,
}: {
  colors: Colors;
  stats: UsageStats;
  locale: string;
  wide: boolean;
  selectedModel: string | null;
  onSelectModel(model: string | null): void;
  onEditPricing(pricingKey: string): void;
}) {
  const { t } = useTranslation(messages);
  const top = Math.max(1, ...stats.models.map((model) => model.requests));
  const totalAllModels = stats.models.reduce((sum, item) => sum + item.requests, 0);
  const columns = [
    { key: "requests", label: t("stats.col.requests"), width: 68 },
    { key: "cost", label: t("stats.col.cost"), width: 82 },
    { key: "context", label: t("stats.col.context"), width: 78 },
    { key: "output", label: t("stats.col.output"), width: 74 },
    { key: "speed", label: t("stats.col.speed"), width: 82 },
    { key: "cache", label: t("stats.col.cache"), width: 64 },
    { key: "firstToken", label: t("stats.col.firstToken"), width: 68 },
  ] as const;

  return (
    <Card colors={colors} style={{ padding: space.lg, gap: space.md }}>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: space.sm }}>
        <Text style={{ ...font.heading, color: colors.foreground, flex: 1 }}>{t("stats.models")}</Text>
        <Text style={{ ...font.caption, color: colors.foregroundMuted }}>{t("stats.modelsHint")}</Text>
      </View>
      {wide ? (
        <View style={{ flexDirection: "row", alignItems: "center", paddingBottom: space.sm, borderBottomWidth: 1, borderBottomColor: colors.border }}>
          <Text style={{ ...font.caption, color: colors.foregroundMuted, flex: 1 }}>{t("stats.col.model")}</Text>
          {columns.map((column) => (
            <Text key={column.key} style={{ ...font.caption, color: colors.foregroundMuted, width: column.width, textAlign: "right" }}>
              {column.label}
            </Text>
          ))}
        </View>
      ) : null}
      {stats.models.map((model, index) => {
        const figures = derive(model);
        const share = totalAllModels > 0 ? model.requests / totalAllModels : 0;
        const active = selectedModel === model.label;
        const dimmed = selectedModel !== null && !active;
        const costText = figures.cost === null ? "—" : usd(figures.cost, locale);
        const values = {
          requests: integer(model.requests, locale),
          cost: costText,
          context: figures.context === null ? "—" : tokens(Math.round(figures.context)),
          output: figures.output === null ? "—" : tokens(Math.round(figures.output)),
          speed: figures.tps === null ? "—" : t("stats.tps", { value: tpsLabel(figures.tps) }),
          cache: figures.cacheRate === null ? "—" : percent(figures.cacheRate, locale),
          firstToken: secondsLabel(figures.firstToken),
        };
        const name = (
          <View style={{ flex: 1, minWidth: 0, gap: 6, paddingRight: space.md }}>
            <View style={{ flexDirection: "row", alignItems: "baseline", gap: space.sm }}>
              <Text numberOfLines={1} style={{ ...font.small, fontWeight: "600", color: active ? colors.accent : colors.foreground, flexShrink: 1 }}>
                {model.label}
              </Text>
              <Text style={{ ...font.caption, ...tabular, color: colors.foregroundMuted }}>{percent(share, locale)}</Text>
            </View>
            <Bar colors={colors} fraction={model.requests / top} tone="accent" height={4} />
          </View>
        );
        return (
          <Pressable
            key={model.label}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            onPress={() => onSelectModel(active ? null : model.label)}
            style={(state) => ({
              paddingVertical: space.sm,
              paddingHorizontal: space.sm,
              marginHorizontal: -space.sm,
              borderRadius: radius.md,
              borderTopWidth: index === 0 || wide ? 0 : 1,
              borderTopColor: colors.border,
              gap: space.sm,
              opacity: dimmed ? 0.55 : 1,
              backgroundColor: active
                ? tint(colors.accent, 0.08)
                : (state as PressState).hovered
                  ? tint(colors.foreground, 0.04)
                  : "transparent",
            })}
          >
            {wide ? (
              <View style={{ flexDirection: "row", alignItems: "center" }}>
                {name}
                {columns.map((column) =>
                  column.key === "cost" ? (
                    <Pressable
                      key={column.key}
                      accessibilityRole="button"
                      accessibilityLabel={t("pricing.editFor", { model: model.label })}
                      onPress={(event) => {
                        event.stopPropagation?.();
                        onEditPricing(model.pricingKey);
                      }}
                      style={{ width: column.width, alignItems: "flex-end" }}
                    >
                      <Text
                        numberOfLines={1}
                        style={{
                          ...font.small,
                          ...tabular,
                          color: figures.cost === null ? colors.statusWarning : colors.foreground,
                          fontWeight: "500",
                        }}
                      >
                        {values.cost}
                      </Text>
                    </Pressable>
                  ) : (
                    <Text
                      key={column.key}
                      numberOfLines={1}
                      style={{ ...font.small, ...tabular, color: colors.foreground, width: column.width, textAlign: "right" }}
                    >
                      {values[column.key]}
                    </Text>
                  ),
                )}
              </View>
            ) : (
              <>
                <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
                  {name}
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t("pricing.editFor", { model: model.label })}
                    hitSlop={8}
                    onPress={(event) => {
                      event.stopPropagation?.();
                      onEditPricing(model.pricingKey);
                    }}
                    style={{ minHeight: 28, justifyContent: "center", paddingHorizontal: 6 }}
                  >
                    <Text
                      style={{
                        ...font.small,
                        ...tabular,
                        fontWeight: "600",
                        color: figures.cost === null ? colors.statusWarning : colors.foreground,
                      }}
                    >
                      {values.cost}
                    </Text>
                  </Pressable>
                  <Text style={{ ...font.caption, ...tabular, color: colors.foregroundMuted }}>
                    {t("stats.readoutRequests", { count: model.requests })}
                  </Text>
                </View>
                <Muted colors={colors} small>
                  {[
                    `${t("stats.col.context")} ${values.context}`,
                    `${t("stats.col.output")} ${values.output}`,
                    values.speed,
                    `${t("stats.col.cache")} ${values.cache}`,
                    `${t("stats.col.firstToken")} ${values.firstToken}`,
                  ].join(" · ")}
                </Muted>
              </>
            )}
          </Pressable>
        );
      })}
    </Card>
  );
}

export function UsageSection({
  colors,
  width,
  compact,
  accounts,
}: {
  colors: Colors;
  width: number;
  compact: boolean;
  accounts: readonly AccountSummary[];
}) {
  const { t, locale } = useTranslation(messages);
  const [range, setRange] = useState<StatsRange>("24h");
  const [scope, setScope] = useState<StatsScope>("all");
  const [accountId, setAccountId] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [metric, setMetric] = useState<ChartMetric>("requests");
  const [pricingOpen, setPricingOpen] = useState<{ open: boolean; focusKey?: string | null }>({ open: false });
  const read = useRpc(usageStatsRpc);
  const query = useQuery({
    queryKey: ["antigravity-accounts", "stats", range, scope, accountId ?? "", selectedModel ?? ""],
    queryFn: () =>
      read({
        range,
        scope,
        ...(accountId ? { accountId } : {}),
        ...(selectedModel ? { model: selectedModel } : {}),
      }),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const stats = query.data;
  const gap = compact ? space.md : space.lg;
  const columns = width >= 880 ? 5 : width >= 420 ? 2 : 1;
  const tileWidth = columns === 1 ? "100%" : (width - gap * (columns - 1)) / columns;
  const totals = stats ? derive(stats.totals) : null;
  const series = (pick: (bin: UsageTotals) => number | null) => (stats ? stats.bins.map((bin) => pick(bin)) : []);
  const hasSubagents = (stats?.breakdown.subagent.requests ?? 0) > 0;
  const accountChips = stats?.accounts ?? [];
  const accountKindById = useMemo(() => new Map(accounts.map((a) => [a.id, a.kind])), [accounts]);
  const unpriced = stats ? stats.totals.requests - stats.totals.pricedRequests : 0;

  return (
    <View style={{ gap: space.md }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm }}>
        <Text style={{ ...font.heading, color: colors.foreground, flex: 1, minWidth: 80 }}>{t("stats.title")}</Text>
        <Button
          colors={colors}
          size="sm"
          variant="secondary"
          icon="DollarSign"
          label={compact ? "" : t("pricing.button")}
          accessibilityLabel={t("pricing.button")}
          onPress={() => setPricingOpen({ open: true, focusKey: null })}
        />
        {hasSubagents || scope !== "all" ? (
          <SegmentedControl<StatsScope>
            colors={colors}
            value={scope}
            options={[
              { value: "all", label: t("stats.scope.all") },
              { value: "main", label: t("stats.scope.main") },
              { value: "subagent", label: t("stats.scope.subagent") },
            ]}
            onChange={(next) => {
              setScope(next);
              setSelectedModel(null);
            }}
          />
        ) : null}
        <SegmentedControl<StatsRange>
          colors={colors}
          value={range}
          options={[
            { value: "24h", label: t("stats.range.24h") },
            { value: "7d", label: t("stats.range.7d") },
            { value: "30d", label: t("stats.range.30d") },
          ]}
          onChange={setRange}
        />
      </View>

      {accountChips.length > 1 || accountId !== null || selectedModel ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.xs }}>
          {accountChips.length > 1 ? (
            <>
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  setAccountId(null);
                  setSelectedModel(null);
                }}
                style={{
                  paddingHorizontal: space.sm + 2,
                  height: 26,
                  borderRadius: radius.pill,
                  justifyContent: "center",
                  backgroundColor: accountId === null ? tint(colors.accent, 0.16) : tint(colors.foreground, 0.06),
                }}
              >
                <Text style={{ ...font.caption, fontWeight: "500", color: accountId === null ? colors.accent : colors.foregroundMuted }}>
                  {t("stats.accountAll")}
                </Text>
              </Pressable>
              {accountChips.map((chip) => {
                const active = accountId === chip.accountId;
                const label = displayLabel(chip.label, t, accountKindById.get(chip.accountId));
                const costSuffix = chip.pricedRequests > 0 ? ` · ${usd(chip.cost, locale)}` : "";
                return (
                  <Pressable
                    key={chip.accountId}
                    accessibilityRole="button"
                    onPress={() => {
                      setAccountId(active ? null : chip.accountId);
                      setSelectedModel(null);
                    }}
                    style={{
                      paddingHorizontal: space.sm + 2,
                      height: 26,
                      borderRadius: radius.pill,
                      justifyContent: "center",
                      backgroundColor: active ? tint(colors.accent, 0.16) : tint(colors.foreground, 0.06),
                    }}
                  >
                    <Text style={{ ...font.caption, ...tabular, fontWeight: "500", color: active ? colors.accent : colors.foregroundMuted }}>
                      {`${label} · ${integer(chip.requests, locale)}${costSuffix}`}
                    </Text>
                  </Pressable>
                );
              })}
            </>
          ) : accountId !== null ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                setAccountId(null);
                setSelectedModel(null);
              }}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 4,
                paddingHorizontal: space.sm + 2,
                height: 26,
                borderRadius: radius.pill,
                backgroundColor: tint(colors.accent, 0.16),
              }}
            >
              <Text style={{ ...font.caption, fontWeight: "500", color: colors.accent }}>
                {(() => {
                  const matched = accounts.find((entry) => entry.id === accountId);
                  return matched ? displayLabel(matched.label, t, matched.kind) : accountId;
                })()}
              </Text>
              <Icon name="X" size={12} color={colors.accent} />
            </Pressable>
          ) : null}

          {selectedModel ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => setSelectedModel(null)}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 4,
                paddingHorizontal: space.sm + 2,
                height: 26,
                borderRadius: radius.pill,
                backgroundColor: tint(colors.accent, 0.16),
              }}
            >
              <Text style={{ ...font.caption, fontWeight: "500", color: colors.accent }}>
                {t("stats.filterModel", { model: selectedModel })}
              </Text>
              <Icon name="X" size={12} color={colors.accent} />
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {query.error ? <Muted colors={colors}>{(query.error as Error).message}</Muted> : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap }}>
        <StatTile
          colors={colors}
          width={tileWidth}
          label={t("stats.estimatedCost")}
          value={totals?.cost !== null && totals?.cost !== undefined ? usd(totals.cost, locale) : "—"}
          foot={
            totals?.costPerRequest !== null && totals?.costPerRequest !== undefined
              ? unpriced > 0
                ? t("stats.costWithUnpriced", { avg: usd(totals.costPerRequest, locale), unpriced })
                : stats?.hasCustomPricing
                  ? t("stats.costAvgCustom", { avg: usd(totals.costPerRequest, locale) })
                  : t("stats.costAvg", { avg: usd(totals.costPerRequest, locale) })
              : " "
          }
        >
          <MiniColumns colors={colors} values={series((bin) => bin.cost)} />
        </StatTile>
        <StatTile
          colors={colors}
          width={tileWidth}
          label={t("stats.requests")}
          value={totals ? integer(totals.requests, locale) : "—"}
          foot={
            stats
              ? hasSubagents && scope === "all" && !selectedModel
                ? t("stats.splitSummary", {
                    main: integer(stats.breakdown.main.requests, locale),
                    subagent: integer(stats.breakdown.subagent.requests, locale),
                  })
                : t("stats.conversations", { count: stats.conversations })
              : " "
          }
        >
          <MiniColumns colors={colors} values={series((bin) => bin.requests)} />
        </StatTile>
        <StatTile
          colors={colors}
          width={tileWidth}
          label={t("stats.speed")}
          value={tpsLabel(totals?.tps ?? null)}
          unit="tok/s"
          foot={stats ? t("stats.outputTokens", { value: tokens(stats.totals.output) }) : " "}
        >
          <MiniColumns colors={colors} values={series((bin) => derive(bin).tps)} />
        </StatTile>
        <StatTile
          colors={colors}
          width={tileWidth}
          label={t("stats.cache")}
          value={totals?.cacheRate !== null && totals?.cacheRate !== undefined ? percent(totals.cacheRate, locale) : "—"}
          foot={stats ? t("stats.cachedTokens", { value: tokens(stats.totals.cached) }) : " "}
        >
          <View style={{ paddingBottom: 4 }}>
            <Bar colors={colors} fraction={totals?.cacheRate ?? 0} tone={totals?.cacheRate === null ? "neutral" : "accent"} height={8} />
          </View>
        </StatTile>
        <StatTile
          colors={colors}
          width={tileWidth}
          label={t("stats.firstToken")}
          value={totals?.firstToken !== null && totals?.firstToken !== undefined ? secondsLabel(totals.firstToken).replace(" s", "") : "—"}
          unit="s"
          foot={totals?.context !== null && totals?.context !== undefined ? t("stats.avgContext", { value: tokens(Math.round(totals.context)) }) : " "}
        >
          <MiniColumns colors={colors} values={series((bin) => derive(bin).firstToken)} />
        </StatTile>
      </View>
      {stats && stats.totals.requests === 0 ? (
        <Card colors={colors} style={{ padding: space.xl, alignItems: "center" }}>
          <Muted colors={colors}>{t("stats.empty")}</Muted>
        </Card>
      ) : null}
      {stats && stats.totals.requests > 0 ? (
        <>
          <MetricChart
            colors={colors}
            stats={stats}
            metric={metric}
            onMetricChange={setMetric}
            locale={locale}
            compact={compact || width < 640}
          />
          {stats.models.length > 0 ? (
            <ModelTable
              colors={colors}
              stats={stats}
              locale={locale}
              wide={width >= 760}
              selectedModel={selectedModel}
              onSelectModel={setSelectedModel}
              onEditPricing={(pricingKey) => setPricingOpen({ open: true, focusKey: pricingKey })}
            />
          ) : null}
        </>
      ) : null}

      {pricingOpen.open ? (
        <PricingDialog
          colors={colors}
          focusKey={pricingOpen.focusKey}
          onClose={() => setPricingOpen({ open: false })}
        />
      ) : null}
    </View>
  );
}
