import { useRpc, useTranslation } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { usageStatsRpc, type StatsRange, type UsageStats, type UsageTotals } from "../shared/contracts";
import { integer, percent, tokens } from "./format";
import { messages } from "./messages";
import { font, radius, space, tabular, tint, type Colors } from "./theme";
import { Bar, Card, Muted } from "./ui";

type PressState = { pressed: boolean; hovered?: boolean };

/** Derived figures; null where the sums cannot support them. */
function derive(totals: UsageTotals) {
  const prompt = totals.input + totals.cached;
  return {
    requests: totals.requests,
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

/** The smallest clean step (1, 1.5, 2, 2.5, 3, 4, 5, 6, 8 × 10^n) at or above the value; halves stay round. */
function niceCeiling(value: number): number {
  if (value <= 2) return 2;
  const exponent = Math.floor(Math.log10(value));
  const base = 10 ** exponent;
  for (const step of [1, 1.2, 1.6, 2, 2.4, 3, 4, 5, 6, 8, 10]) {
    const candidate = step * base;
    // Keep the middle gridline on a whole number.
    if (candidate >= value && Number.isInteger(candidate / 2)) return candidate;
  }
  return 10 * base;
}

function RangeControl({ colors, value, onChange }: { colors: Colors; value: StatsRange; onChange(range: StatsRange): void }) {
  const { t } = useTranslation(messages);
  const ranges: StatsRange[] = ["24h", "7d", "30d"];
  return (
    <View
      accessibilityRole="tablist"
      style={{ flexDirection: "row", padding: 2, borderRadius: radius.md, backgroundColor: tint(colors.foreground, 0.06) }}
    >
      {ranges.map((range) => {
        const selected = range === value;
        return (
          <Pressable
            key={range}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            onPress={() => onChange(range)}
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
              {t(`stats.range.${range}`)}
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
        <Text numberOfLines={1} style={{ fontSize: 28, lineHeight: 34, fontWeight: "600", color: colors.foreground }}>
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

function binLabel(start: number, binMs: number, locale: string): string {
  const date = new Date(start);
  const time = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
  const day = new Intl.DateTimeFormat(locale, { month: "numeric", day: "numeric" }).format(date);
  if (binMs >= 86_400_000) return day;
  const end = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(start + binMs));
  return `${day} ${time}–${end}`;
}

function tickLabel(start: number, binMs: number, locale: string): string {
  const date = new Date(start);
  if (binMs >= 86_400_000 || binMs >= 6 * 3_600_000) {
    return new Intl.DateTimeFormat(locale, { month: "numeric", day: "numeric" }).format(date);
  }
  return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

function showsTick(start: number, binMs: number, index: number): boolean {
  const date = new Date(start);
  if (binMs >= 86_400_000) return index % 5 === 0;
  if (binMs >= 6 * 3_600_000) return date.getHours() === 0;
  return date.getHours() % 6 === 0;
}

function RequestsChart({ colors, stats, locale, compact }: { colors: Colors; stats: UsageStats; locale: string; compact: boolean }) {
  const { t } = useTranslation(messages);
  const [hovered, setHovered] = useState<number | null>(null);
  const bins = stats.bins;
  const lastActive = useMemo(() => {
    for (let index = bins.length - 1; index >= 0; index -= 1) if (bins[index]!.requests > 0) return index;
    return bins.length - 1;
  }, [bins]);
  const selected = hovered ?? lastActive;
  const peak = niceCeiling(Math.max(...bins.map((bin) => bin.requests)));
  const chartHeight = 132;
  const plotTop = 8;
  const plotHeight = chartHeight - plotTop - 4;
  const axisWidth = Math.max(16, String(peak).length * 8);
  const bin = bins[selected];
  const figures = bin ? derive(bin) : null;
  const readout = !bin
    ? ""
    : bin.requests === 0
      ? t("stats.noRequests")
      : [
          t("stats.readoutRequests", { count: bin.requests }),
          figures?.tps !== null && figures?.tps !== undefined ? t("stats.readoutTps", { value: tpsLabel(figures.tps) }) : null,
          figures?.cacheRate !== null && figures?.cacheRate !== undefined ? t("stats.readoutCache", { value: percent(figures.cacheRate, locale) }) : null,
          figures?.firstToken !== null && figures?.firstToken !== undefined ? t("stats.readoutFirstToken", { value: secondsLabel(figures.firstToken) }) : null,
        ]
          .filter(Boolean)
          .join(" · ");
  const titleKey = stats.binMs >= 86_400_000 ? "stats.perDay" : stats.binMs >= 6 * 3_600_000 ? "stats.perSixHours" : "stats.perHour";
  return (
    <Card colors={colors} style={{ padding: space.lg, gap: space.md }}>
      <View style={{ flexDirection: compact ? "column" : "row", alignItems: compact ? "flex-start" : "baseline", gap: compact ? space.xs : space.sm }}>
        <Text style={{ ...font.heading, color: colors.foreground, flex: compact ? undefined : 1 }}>{t(titleKey)}</Text>
        <Text numberOfLines={compact ? 2 : 1} style={{ ...font.small, color: colors.foregroundMuted, flexShrink: 1 }}>
          {bin ? `${binLabel(bin.start, stats.binMs, locale)}  ` : ""}
          <Text style={{ color: colors.foreground, ...tabular }}>{readout}</Text>
        </Text>
      </View>
      <View style={{ flexDirection: "row", gap: space.sm }}>
        {/* Y axis: labels sit exactly on the plot's top, middle and baseline. */}
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
              {integer(tick, locale)}
            </Text>
          ))}
        </View>
        <View style={{ flex: 1 }}>
          <View style={{ height: chartHeight }}>
            {/* Hairline grid at the top and middle; the baseline is a step stronger. */}
            <View style={{ position: "absolute", left: 0, right: 0, top: plotTop, height: 1, backgroundColor: tint(colors.foreground, 0.07) }} />
            <View style={{ position: "absolute", left: 0, right: 0, top: plotTop + plotHeight / 2, height: 1, backgroundColor: tint(colors.foreground, 0.07) }} />
            <View style={{ position: "absolute", left: 0, right: 0, top: plotTop + plotHeight, height: 1, backgroundColor: tint(colors.foreground, 0.18) }} />
            <View style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: chartHeight - plotTop - plotHeight, flexDirection: "row" }}>
              {bins.map((entry, index) => {
                const active = index === selected;
                const height = entry.requests > 0 ? Math.max(3, (entry.requests / peak) * plotHeight) : 0;
                return (
                  <Pressable
                    key={entry.start}
                    accessibilityRole="button"
                    accessibilityLabel={`${binLabel(entry.start, stats.binMs, locale)}: ${t("stats.readoutRequests", { count: entry.requests })}`}
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
                {showsTick(entry.start, stats.binMs, index) ? (
                  // A wider box than the slot, so the label is centered on its column and never clipped.
                  <View pointerEvents="none" style={{ position: "absolute", width: 80, alignItems: "center" }}>
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

function ModelTable({ colors, stats, locale, wide }: { colors: Colors; stats: UsageStats; locale: string; wide: boolean }) {
  const { t } = useTranslation(messages);
  const top = Math.max(1, ...stats.models.map((model) => model.requests));
  const columns = [
    { key: "requests", label: t("stats.col.requests") },
    { key: "context", label: t("stats.col.context") },
    { key: "output", label: t("stats.col.output") },
    { key: "speed", label: t("stats.col.speed") },
    { key: "cache", label: t("stats.col.cache") },
    { key: "firstToken", label: t("stats.col.firstToken") },
  ] as const;
  const cell = { ...font.small, ...tabular, color: colors.foreground, width: 92, textAlign: "right" as const };
  return (
    <Card colors={colors} style={{ padding: space.lg, gap: space.md }}>
      <Text style={{ ...font.heading, color: colors.foreground }}>{t("stats.models")}</Text>
      {wide ? (
        <View style={{ flexDirection: "row", alignItems: "center", paddingBottom: space.sm, borderBottomWidth: 1, borderBottomColor: colors.border }}>
          <Text style={{ ...font.caption, color: colors.foregroundMuted, flex: 1 }}>{t("stats.col.model")}</Text>
          {columns.map((column) => (
            <Text key={column.key} style={{ ...font.caption, color: colors.foregroundMuted, width: 92, textAlign: "right" }}>
              {column.label}
            </Text>
          ))}
        </View>
      ) : null}
      {stats.models.map((model, index) => {
        const figures = derive(model);
        const share = stats.totals.requests > 0 ? model.requests / stats.totals.requests : 0;
        const values = {
          requests: integer(model.requests, locale),
          context: figures.context === null ? "—" : tokens(Math.round(figures.context)),
          output: figures.output === null ? "—" : tokens(Math.round(figures.output)),
          speed: figures.tps === null ? "—" : t("stats.tps", { value: tpsLabel(figures.tps) }),
          cache: figures.cacheRate === null ? "—" : percent(figures.cacheRate, locale),
          firstToken: secondsLabel(figures.firstToken),
        };
        const name = (
          <View style={{ flex: 1, minWidth: 0, gap: 6, paddingRight: space.md }}>
            <View style={{ flexDirection: "row", alignItems: "baseline", gap: space.sm }}>
              <Text numberOfLines={1} style={{ ...font.small, fontWeight: "600", color: colors.foreground, flexShrink: 1 }}>
                {model.label}
              </Text>
              <Text style={{ ...font.caption, ...tabular, color: colors.foregroundMuted }}>{percent(share, locale)}</Text>
            </View>
            {/* Ranked bars: one hue, largest first, against the busiest model. */}
            <Bar colors={colors} fraction={model.requests / top} tone="accent" height={4} />
          </View>
        );
        return (
          <View
            key={model.label}
            style={{
              paddingVertical: space.sm,
              borderTopWidth: index === 0 || wide ? 0 : 1,
              borderTopColor: colors.border,
              gap: space.sm,
            }}
          >
            {wide ? (
              <View style={{ flexDirection: "row", alignItems: "center" }}>
                {name}
                {columns.map((column) => (
                  <Text key={column.key} numberOfLines={1} style={cell}>
                    {values[column.key]}
                  </Text>
                ))}
              </View>
            ) : (
              <>
                <View style={{ flexDirection: "row", alignItems: "center" }}>
                  {name}
                  <Text style={{ ...font.small, ...tabular, color: colors.foreground }}>
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
          </View>
        );
      })}
    </Card>
  );
}

export function UsageSection({ colors, width, compact }: { colors: Colors; width: number; compact: boolean }) {
  const { t, locale } = useTranslation(messages);
  const [range, setRange] = useState<StatsRange>("24h");
  const read = useRpc(usageStatsRpc);
  const query = useQuery({
    queryKey: ["antigravity-accounts", "stats", range],
    queryFn: () => read({ range }),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const stats = query.data;
  const gap = compact ? space.md : space.lg;
  const columns = width >= 760 ? 4 : width >= 340 ? 2 : 1;
  const tileWidth = columns === 1 ? "100%" : (width - gap * (columns - 1)) / columns;
  const totals = stats ? derive(stats.totals) : null;
  const series = (pick: (bin: UsageTotals) => number | null) => (stats ? stats.bins.map((bin) => pick(bin)) : []);

  return (
    <View style={{ gap: space.md }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <Text style={{ ...font.heading, color: colors.foreground, flex: 1 }}>{t("stats.title")}</Text>
        <RangeControl colors={colors} value={range} onChange={setRange} />
      </View>
      {query.error ? <Muted colors={colors}>{(query.error as Error).message}</Muted> : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap }}>
        <StatTile
          colors={colors}
          width={tileWidth}
          label={t("stats.requests")}
          value={totals ? integer(totals.requests, locale) : "—"}
          foot={stats ? t("stats.conversations", { count: stats.conversations }) : " "}
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
          <RequestsChart colors={colors} stats={stats} locale={locale} compact={compact || width < 640} />
          <ModelTable colors={colors} stats={stats} locale={locale} wide={width >= 720} />
        </>
      ) : null}
    </View>
  );
}
