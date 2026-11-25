/**
 * What is wrong with a typed price or rate, in words (spec 02, issue #112). One
 * message for every bad price left people guessing, so each kind of mistake has
 * its own. Checked in order, and a refused value is never echoed back. No
 * server-only import: the CSV preview and the forms share it.
 */

export type PriceShape = {
  /** "USD price", "special ZiG price": the sentence starts "The {label} ...". */
  label: string;
  /** Digits before the point. */
  whole: number;
  /** Digits after it. */
  decimals: number;
  /** A valid one, for "like 8.50". */
  example: string;
  /** A rate has to be above zero; a price may be zero (it asks first). */
  positive?: boolean;
};

const largest = ({ whole, decimals }: PriceShape) => {
  const nines = "9".repeat(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return decimals > 0 ? `${nines}.${"9".repeat(decimals)}` : nines;
};

/** Null when `value` (already trimmed, not blank) is fine, else the reason. */
export function priceProblem(value: string, shape: PriceShape): string | null {
  const The = `The ${shape.label}`;
  const like = `like ${shape.example}`;
  if (/^[0-9]+,[0-9]+$/.test(value)) {
    return `${The} uses a comma. Write a point for the decimal, ${like}.`;
  }
  if (/^[-−–]/.test(value)) return `${The} can't be negative. Enter it ${like}.`;
  const match = /^([0-9]+)(?:\.([0-9]+))?$/.exec(value);
  if (!match) {
    return `${The} must be digits only, ${like}: no currency sign, letters or spaces.`;
  }
  const [, whole, fraction = ""] = match;
  if (fraction.length > shape.decimals) {
    return shape.decimals === 0
      ? `${The} must be a whole number, ${like}.`
      : `${The} can have at most ${shape.decimals} decimal places, ${like}.`;
  }
  if (whole.length > shape.whole) {
    return `${The} is too large. The most is ${largest(shape)}.`;
  }
  if (shape.positive && Number(value) <= 0) return `${The} must be above 0, ${like}.`;
  return null;
}

export const usdShape = (label = "USD price", example = "8.50"): PriceShape => ({
  label,
  whole: 6,
  decimals: 2,
  example,
});

export const zigShape = (label = "ZiG price", example = "210"): PriceShape => ({
  label,
  whole: 9,
  decimals: 2,
  example,
});

export const rateShape: PriceShape = {
  label: "rate",
  whole: 6,
  decimals: 6,
  example: "26.2",
  positive: true,
};
