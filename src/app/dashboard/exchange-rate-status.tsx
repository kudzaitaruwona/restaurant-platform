import { Notice } from "@/components/ui/notice";
import type { currencyMode } from "@/db/schema";
import { rateAge, rateAgeLabel } from "@/lib/pricing";

type CurrencyMode = (typeof currencyMode.enumValues)[number];

/**
 * The current rate and how old it is, with the warning spec 02 proposes once it
 * is more than 7 days old: every calculated ZiG price follows it. With none set
 * there are no calculated prices at all, which is worse. Either warning is
 * amber (S-41): a person needs to act. A USD-only restaurant with no rate
 * rarely needs one, so it gets a plain note instead of the warning.
 */
export function ExchangeRateStatus({
  rate,
  setAt,
  currencyMode,
}: {
  rate: string | null;
  setAt: Date | null;
  currencyMode: CurrencyMode;
}) {
  if (rate === null || setAt === null) {
    // Only a dish priced in ZiG alone would use a rate, so it isn't worth a warning.
    if (currencyMode === "usd_only") {
      return (
        <p className="text-body text-ink-2">
          You show prices in USD. You only need a rate if a dish is priced in ZiG alone, or if you
          start showing ZiG.
        </p>
      );
    }
    return (
      <Notice tone="attention" role="alert">
        No exchange rate is set. ZiG prices can&apos;t be calculated until you set one.
      </Notice>
    );
  }
  const { days, stale } = rateAge(setAt, new Date());
  return (
    <div className="flex flex-col gap-3">
      {/* One sentence, as tests and screen readers read it. */}
      <p className="text-lead font-semibold text-ink tabular-nums">
        1 USD = ZiG {rate}, last updated {rateAgeLabel(days)}
      </p>
      {stale && (
        <Notice tone="attention" role="alert">
          This rate is more than 7 days old. Calculated ZiG prices may be wrong.
        </Notice>
      )}
    </div>
  );
}
