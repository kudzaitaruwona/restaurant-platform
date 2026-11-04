import { Button } from "@/components/ui/button";
import { formatUsd, formatZig } from "@/lib/pricing";
import type { listSpecials, SpecialStatus } from "@/lib/specials";
import { ActionForm } from "../action-form";
import { Field, inputClassName } from "../field";

type Item = { id: string; name: string };

const statusLabel: Record<SpecialStatus, string> = {
  live: "On now",
  scheduled: "Starts later",
  ended: "Over",
  off: "Turned off",
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
 * to add one. Owners only (S-26): the caller renders this for no one else, and
 * both routes behind it refuse staff.
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
    <section className="flex flex-col gap-3">
      <h2 className="font-heading text-xl font-semibold">Specials</h2>
      {specials.length === 0 ? (
        <p className="text-sm text-muted-foreground">No specials yet.</p>
      ) : (
        <ul className="flex flex-col divide-y">
          {specials.map((special) => (
            <li
              key={special.id}
              className="flex flex-col gap-2 py-2 sm:flex-row sm:items-start sm:justify-between"
            >
              <div className="flex flex-col text-sm">
                <span className="font-medium">
                  {special.itemName}
                  {special.itemVisibility === "special_only" && " (bundle)"}
                  {special.title && ` · ${special.title}`}
                </span>
                <span>{price(special)}</span>
                <span className="text-muted-foreground">
                  {windowLabel(special)} · {statusLabel[special.status]}
                </span>
              </div>
              <ActionForm
                action={`/api/menu/specials/${special.id}/active`}
                className="self-start"
              >
                <input type="hidden" name="active" value={special.active ? "false" : "true"} />
                <Button type="submit" variant="outline" size="sm">
                  {special.active ? "Turn off" : "Turn on"}
                </Button>
              </ActionForm>
            </li>
          ))}
        </ul>
      )}

      <h3 className="font-heading text-lg font-semibold">Add a special</h3>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">Add an item first.</p>
      ) : (
        <ActionForm
          action="/api/menu/specials"
          savedMessage="Special added."
          resetOnSuccess
          className="flex flex-col gap-4"
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
          <Field
            label="Special price (USD)"
            hint="Optional. Leave both prices blank for a badge alone. A price in one currency discounts both."
          >
            <input name="priceUsd" inputMode="decimal" className={inputClassName} />
          </Field>
          <Field label="Special price (ZiG)" hint="Optional.">
            <input name="priceZig" inputMode="decimal" className={inputClassName} />
          </Field>
          <Field label="First day" hint={`Optional. Dates are in ${timezone} time.`}>
            <input name="startDate" type="date" className={inputClassName} />
          </Field>
          <Field
            label="Last day"
            hint="Optional, and included. Leave blank to keep it on until you turn it off."
          >
            <input name="endDate" type="date" className={inputClassName} />
          </Field>
          <Button type="submit" className="self-start">
            Add special
          </Button>
        </ActionForm>
      )}
    </section>
  );
}
