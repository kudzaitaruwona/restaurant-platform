import { formatUsd, formatZig } from "@/lib/pricing";

/**
 * What to tell the owner when Postgres refuses a write that would leave a special
 * above its item's normal price (S-45, issue #129). The rule and the race are the
 * `specials_not_above_normal` triggers' (migration 0053): no app check runs first,
 * so there is nothing to go stale between a check and the save.
 */

/** One special the write would leave above, in the first currency it is above in. */
export type SpecialAbove = {
  item: string;
  title: string | null;
  currency: "usd" | "zig";
  special: string;
  normal: string;
  calculated: boolean;
};

/** The specials the refusal names, or null if `error` isn't that refusal. */
export function specialsAbove(error: unknown): SpecialAbove[] | null {
  const { constraint, detail } =
    (error as { cause?: { constraint?: string; detail?: string } }).cause ?? {};
  return constraint === "specials_not_above_normal" && detail ? JSON.parse(detail) : null;
}

const NAMED = 5;

const label = ({ currency }: SpecialAbove) => (currency === "usd" ? "USD" : "ZiG");
const money = ({ currency }: SpecialAbove, amount: string) =>
  currency === "usd" ? formatUsd(amount) : formatZig(amount);

function named(above: SpecialAbove) {
  const what = above.title === null ? above.item : `"${above.title}" on ${above.item}`;
  const now = `${money(above, above.special)}${above.calculated ? " calculated" : ""}`;
  return `${what} (${now}, normally ${money(above, above.normal)})`;
}

/** An edit of an item, the rate or the currency mode that would lift specials. */
export function liftedMessage(above: SpecialAbove[]) {
  const one = above.length === 1;
  const more = above.length > NAMED ? ` and ${above.length - NAMED} more` : "";
  const list = above.slice(0, NAMED).map(named).join(", ");
  return `This would leave ${one ? "a special" : `${above.length} specials`} above the normal price: ${list}${more}. Turn ${one ? "it" : "them"} off under Specials on the Menu page first.`;
}

/** A new special's price. */
export function newSpecialMessage([above]: SpecialAbove[]) {
  const currency = label(above);
  const [price, normal] = [money(above, above.special), money(above, above.normal)];
  return above.calculated
    ? `At the current rate this special's ${currency} price is calculated as ${price}, above the normal price (${normal}). Enter a special ${currency} price too, or lower the special ${currency === "USD" ? "ZiG" : "USD"} price.`
    : `The special ${currency} price (${price}) is above the normal price (${normal}). A special can't be above it. Change the price, or leave it blank for a badge alone.`;
}

/** A special turned on again after its item's price, or the rate, moved. */
export function turnOnMessage([above]: SpecialAbove[]) {
  const currency = label(above);
  const [price, normal] = [money(above, above.special), money(above, above.normal)];
  const is = above.calculated
    ? `At the current rate this special's ${currency} price is calculated as ${price}, above the normal price (${normal}),`
    : `The special ${currency} price (${price}) is above the normal price (${normal}) now,`;
  return `${is} so it can't be turned on. Change the item's price, or add another special.`;
}
