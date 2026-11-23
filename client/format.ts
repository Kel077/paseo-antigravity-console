/** "11.8K", "456K", "1M", "1.05M" — compact token counts. */
export function tokens(value: number): string {
  if (value >= 1_000_000) {
    // Context windows are binary sizes: 1,048,576 reads as "1M".
    const millions = value % 1_048_576 === 0 ? value / 1_048_576 : value / 1_000_000;
    return `${trim(millions, millions >= 10 ? 0 : 2)}M`;
  }
  if (value >= 1000) return `${trim(value / 1000, value >= 100_000 ? 0 : 1)}K`;
  return String(value);
}

/** Fixed digits without trailing fraction zeros: 1.50 → "1.5", 300 → "300". */
function trim(value: number, digits: number): string {
  const text = value.toFixed(digits);
  return text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
}

export function percent(fraction: number, locale: string): string {
  const digits = fraction > 0 && fraction < 0.01 ? 1 : 0;
  return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: digits }).format(fraction);
}

export function integer(value: number, locale: string): string {
  return new Intl.NumberFormat(locale).format(value);
}

/** "$0.00", "$0.0042", "$1.28", "$124.50", "$1,234" — readable USD cost formatting. */
export function usd(value: number, locale = "en-US"): string {
  if (!Number.isFinite(value) || value <= 0) return "$0.00";
  if (value < 0.0001) return "<$0.0001";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 1) return `$${value.toFixed(3)}`;
  if (value >= 1000) {
    return `$${new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(Math.round(value))}`;
  }
  return `$${new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)}`;
}

/** Compact USD formatter for chart Y-axis ticks. */
export function usdShort(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "$0";
  if (value < 0.01) return `$${trim(value, 4)}`;
  if (value < 1) return `$${trim(value, 3)}`;
  if (value < 100) return `$${trim(value, 2)}`;
  return `$${Math.round(value)}`;
}

/** "in 3 hours" / "5 minutes ago" in the app language. */
export function relative(timestamp: string | number, now: number, locale: string): string {
  const time = typeof timestamp === "number" ? timestamp : Date.parse(timestamp);
  if (!Number.isFinite(time)) return "";
  const seconds = Math.round((time - now) / 1000);
  const absolute = Math.abs(seconds);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (absolute < 45) return format.format(0, "second");
  if (absolute < 3600) return format.format(Math.round(seconds / 60), "minute");
  if (absolute < 86_400) return format.format(Math.round(seconds / 3600), "hour");
  return format.format(Math.round(seconds / 86_400), "day");
}
