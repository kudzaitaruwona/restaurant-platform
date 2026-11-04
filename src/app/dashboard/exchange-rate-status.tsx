import { rateAge, rateAgeLabel } from "@/lib/pricing";

/**
 * The current rate and how old it is, with the warning spec 02 proposes once it
 * is more than 7 days old: every calculated ZiG price follows it. With none set
 * there are no calculated prices at all, which is worse.
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
      <p role="alert" className="text-sm text-destructive">
        No exchange rate is set. ZiG prices can&apos;t be calculated until you set one.
      </p>
    );
  }
  const { days, stale } = rateAge(setAt, new Date());
  return (
    <div className="flex flex-col gap-1 text-sm">
      <p>
        1 USD = ZiG {rate}, last updated {rateAgeLabel(days)}
      </p>
      {stale && (
        <p role="alert" className="text-destructive">
          This rate is more than 7 days old. Calculated ZiG prices may be wrong.
        </p>
      )}
    </div>
  );
}
