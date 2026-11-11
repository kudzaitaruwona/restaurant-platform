import { Check, Clock, Pause, Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { formatUsd, formatZig } from "@/lib/pricing";
import type { listSpecials, SpecialStatus } from "@/lib/specials";
import { ActionForm } from "../action-form";
import { Field, inputClassName } from "../field";
import { Disclosure } from "./disclosure";
import { Pill } from "./pill";

type Item = { id: string; name: string };

const statusPill: Record<SpecialStatus, { label: string; tone: "positive" | "neutral" | "muted"; icon: ReactNode }> = {
  live: { label: "On now", tone: "positive", icon: <Check aria-hidden /> },
  scheduled: { label: "Starts later", tone: "neutral", icon: <Clock aria-hidden /> },
  ended: { label: "Over", tone: "muted", icon: null },
  off: { label: "Turned off", tone: "muted", icon: <Pause aria-hidden /> },
};

/** "2026-11-30" as the owner typed it: they read it back the same way. */
function windowLabel({ startDate, endDate }: { startDate: string | null; endDate: string | null }) {
  if (startDate && endDate) return startDate === endDate ? startDate : `${startDate} to ${endDate}`;
  if (startDate) return `From ${startDate}, until turned off`;
  if (endDate) return `Until ${endDate}`;
  return "Until turned off";
}

function price(special: { priceUsd: string | null; priceZig: string | null }) {
  const parts = [
    special.priceUsd !== null && formatUsd(special.priceUsd),
    special.priceZig !== null && formatZig(special.priceZig),
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "Normal price";
}

/**
 * Promotions (spec 02 › Specials): the list with an on/off switch, and the form
 * to add one, folded away until it's wanted. Owners only (S-26): the caller
 * renders this for no one else, and both routes behind it refuse staff.
 */
export function SpecialsSection({
  specials,
  items,
  timezone,
}: {
  specials: Awaited<ReturnType<typeof listSpecials>>;
  items: Item[];
  timezone: string;
}) {
  return (
    <Card as="section" className="flex flex-col">
      <div className="flex items-center gap-2 px-4 pt-4 sm:px-5 sm:pt-5">
        <Sparkles aria-hidden className="size-5 text-ink-2" />
        <h2 className="text-lead font-semibold">Specials</h2>
      </div>
      {specials.length === 0 ? (
        <p className="px-4 pt-2 pb-1 text-ink-2 sm:px-5">No specials yet.</p>
      ) : (
        <ul className="mt-2 divide-y divide-line border-y border-line">
          {specials.map((special) => {
            const status = statusPill[special.status];
            return (
              <li key={special.id} className="flex items-start gap-3 px-4 py-3 sm:px-5">
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-semibold">
                      {special.itemName}
                      {special.itemVisibility === "special_only" && " (bundle)"}
                    </span>
                    {special.title && <Pill>{special.title}</Pill>}
                  </p>
                  <p className="text-body tabular-nums">{price(special)}</p>
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-ink-2 tabular-nums">
                    <Pill tone={status.tone} icon={status.icon}>
                      {status.label}
                    </Pill>
                    {windowLabel(special)}
                  </p>
                </div>
                <ActionForm
                  action={`/api/menu/specials/${special.id}/active`}
                  className="flex flex-col items-end gap-1"
                >
                  <input type="hidden" name="active" value={special.active ? "false" : "true"} />
                  <Button type="submit" variant="secondary" size="compact">
                    {special.active ? "Turn off" : "Turn on"}
                  </Button>
                </ActionForm>
              </li>
            );
          })}
        </ul>
      )}

      <div className="px-4 py-1 sm:px-5">
        <Disclosure title="Add a special">
          {items.length === 0 ? (
            <p className="text-ink-2">Add an item first.</p>
          ) : (
            <ActionForm
              action="/api/menu/specials"
              savedMessage="Special added."
              resetOnSuccess
              className="@container flex flex-col gap-4"
            >
              <Field label="Item">
                <select name="menuItemId" className={inputClassName}>
                  {items.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Badge" hint="Optional, like Taco Tuesday.">
                <input name="title" maxLength={80} className={inputClassName} />
              </Field>
              <p className="text-caption text-ink-2">
                Leave both prices blank for a badge alone. A price in one currency discounts both.
              </p>
              <div className="grid gap-4 @md:grid-cols-2">
                <Field label="Special price (USD)" hint="Optional.">
                  <input name="priceUsd" inputMode="decimal" className={`${inputClassName} tabular-nums`} />
                </Field>
                <Field label="Special price (ZiG)" hint="Optional.">
                  <input name="priceZig" inputMode="decimal" className={`${inputClassName} tabular-nums`} />
                </Field>
              </div>
              <Field label="First day" hint={`Optional. Dates are in ${timezone} time.`}>
                <input name="startDate" type="date" className={inputClassName} />
              </Field>
              <Field
                label="Last day"
                hint="Optional, and included. Leave blank to keep it on until you turn it off."
              >
                <input name="endDate" type="date" className={inputClassName} />
              </Field>
              <Button type="submit" size="staff" className="self-start">
                Add special
              </Button>
            </ActionForm>
          )}
        </Disclosure>
      </div>
    </Card>
  );
}
