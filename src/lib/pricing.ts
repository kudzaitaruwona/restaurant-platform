/**
 * Effective prices (spec 00, 2): computed from the stored ones, never stored.
 * Money is a numeric string all the way through and the sums are in BigInt, so
 * "rounds up" means up in exact arithmetic: 1.1 * 10 is 11 here, not the
 * 11.000000000000002 that would round up to 12. No server-only import: the
 * item form calls this in the browser for its live hint.
 */

export type CurrencyMode =
  | "usd_only"
  | "zig_only"
  | "usd_primary"
  | "zig_primary"
  | "both";

export type Pricing = {
  /** ZiG per 1 USD: the latest exchange_rates row, null before the first. */
  rate: string | null;
  zigStep: string;
  usdStep: string;
};

export type ItemPrices = { priceUsd: string | null; priceZig: string | null };

/** int / 10^scale */
type Decimal = { int: bigint; scale: number };

const DECIMAL = /^([0-9]+)(?:\.([0-9]+))?$/;

function decimal(value: string): Decimal {
  const match = DECIMAL.exec(value);
  if (!match) throw new RangeError(`Not a decimal number: ${value}`);
  const fraction = match[2] ?? "";
  return { int: BigInt(match[1] + fraction), scale: fraction.length };
}

// BigInt literals need a newer compile target than this project sets.
const ZERO = BigInt(0);
const ONE = BigInt(1);

const power10 = (scale: number) => BigInt(10) ** BigInt(scale);

const ceilDiv = (numerator: bigint, denominator: bigint) =>
  (numerator + denominator - ONE) / denominator;

/** Trimmed: "210", "8.5". Display adds back what it needs. */
function toText({ int, scale }: Decimal) {
  const digits = int.toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

/** ceil(value * factor / divisor / step) * step, with every part exact. */
function roundedUp(
  value: string,
  factor: string,
  divisor: string,
  stepText: string,
): string | null {
  const v = decimal(value);
  const f = decimal(factor);
  const d = decimal(divisor);
  const step = decimal(stepText);
  if (d.int === ZERO || step.int === ZERO) return null;
  // (v.int/10^vs * f.int/10^fs) / (d.int/10^ds) / (step.int/10^ss)
  const numerator = v.int * f.int * power10(d.scale + step.scale);
  const denominator = d.int * step.int * power10(v.scale + f.scale);
  const multiples = ceilDiv(numerator, denominator);
  return toText({ int: multiples * step.int, scale: step.scale });
}

export type EffectiveZig = { amount: string; source: "fixed" | "calculated" };

export function effectiveZig(
  { priceUsd, priceZig }: ItemPrices,
  { rate, zigStep }: Pricing,
): EffectiveZig | null {
  if (priceZig !== null) return { amount: toText(decimal(priceZig)), source: "fixed" };
  if (priceUsd === null || rate === null) return null;
  const amount = roundedUp(priceUsd, rate, "1", zigStep);
  return amount === null ? null : { amount, source: "calculated" };
}

export function effectiveUsd(
  { priceUsd, priceZig }: ItemPrices,
  { rate, usdStep }: Pricing,
): string | null {
  if (priceUsd !== null) return priceUsd;
  if (priceZig === null || rate === null) return null;
  return roundedUp(priceZig, "1", rate, usdStep);
}

function grouped(whole: string) {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** "$8.00": at least the cents, more if the step is finer. */
export function formatUsd(amount: string) {
  const [whole, fraction = ""] = toText(decimal(amount)).split(".");
  return `$${grouped(whole)}.${fraction.padEnd(2, "0")}`;
}

/** "ZiG 210" */
export function formatZig(amount: string) {
  const [whole, fraction] = toText(decimal(amount)).split(".");
  return `ZiG ${grouped(whole)}${fraction ? `.${fraction}` : ""}`;
}

export type PriceDisplay = { main: string; sub?: string };

/**
 * What a menu shows for an item under `currency_mode`. A currency that can't be
 * worked out yet, because no rate is set, falls back to the other one rather
 * than showing no price.
 */
export function priceDisplay(
  item: ItemPrices,
  mode: CurrencyMode,
  pricing: Pricing,
): PriceDisplay {
  const usd = effectiveUsd(item, pricing);
  const zig = effectiveZig(item, pricing);
  const shown = {
    usd: usd === null ? null : formatUsd(usd),
    zig: zig === null ? null : formatZig(zig.amount),
  };

  const wanted =
    mode === "usd_only"
      ? [shown.usd]
      : mode === "zig_only"
        ? [shown.zig]
        : mode.startsWith("zig")
          ? [shown.zig, shown.usd]
          : [shown.usd, shown.zig];
  let parts = wanted.filter((part) => part !== null);
  if (parts.length === 0) parts = [shown.usd ?? shown.zig].filter((p) => p !== null);

  if (mode === "both") return { main: parts.join(" · ") };
  return parts.length > 1 ? { main: parts[0], sub: parts[1] } : { main: parts[0] };
}

const PRICE_TEXT = /^[0-9]{1,6}(\.[0-9]{1,2})?$/;

/** The item form's hint beside the ZiG field. Null when there's no price to show it for. */
export function calculatedZigNote(usdText: string, pricing: Pricing) {
  const priceUsd = usdText.trim();
  if (!PRICE_TEXT.test(priceUsd)) return null;
  const zig = effectiveZig({ priceUsd, priceZig: null }, pricing);
  if (zig === null) return "Set the exchange rate to calculate the ZiG price.";
  return `Calculated: ${formatZig(zig.amount)} at rate ${toText(decimal(pricing.rate!))}`;
}

const DAY = 24 * 60 * 60 * 1000;
/** Proposed in spec 02: a rate older than this is probably wrong. */
export const STALE_AFTER_DAYS = 7;

export function rateAge(setAt: Date, now: Date) {
  const elapsed = Math.max(0, now.getTime() - setAt.getTime());
  return { days: Math.floor(elapsed / DAY), stale: elapsed > STALE_AFTER_DAYS * DAY };
}

export const rateAgeLabel = (days: number) =>
  days === 0 ? "today" : days === 1 ? "1 day ago" : `${days} days ago`;
