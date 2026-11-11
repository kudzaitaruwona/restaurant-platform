import { Notice } from "@/components/ui/notice";
import { rateAge, rateAgeLabel } from "@/lib/pricing";

/**
 * The current rate and how old it is, with the warning spec 02 proposes once it
 * is more than 7 days old: every calculated ZiG price follows it. With none set
 * there are no calculated prices at all, which is worse. Either warning is
 * amber (S-41): a person needs to act.
 */
export function ExchangeRateStatus({
  rate,
  setAt,
}: {
  rate: string | null;
  setAt: Date | null;
}) {
  if (rate === null || setAt === null) {
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
