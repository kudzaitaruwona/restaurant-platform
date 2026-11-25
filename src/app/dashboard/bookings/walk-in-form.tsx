import { Button } from "@/components/ui/button";
import { cardClassName } from "@/components/ui/card";
import { Field, Select } from "@/components/ui/input";
import { Stepper } from "@/components/ui/stepper";
import type { WalkInTable } from "@/lib/walk-in";
import { cn } from "@/lib/utils";
import { ActionForm } from "../action-form";

/**
 * What the table's option says: free (and for how long, when a booking would cut a
 * sitting short), or why it is not. A reset buffer is not a party.
 */
const availability = ({ state, until }: WalkInTable) =>
  ({
    free: until ? `free until ${until}` : "free",
    in_use: `in use until ${until}`,
    resetting: `being reset until ${until}`,
    booking_soon: `booking at ${until}, too soon`,
  })[state];

/**
 * Seat walk-in (spec 04): a table and a party size, posted to
 * /api/bookings/walk-in. A refusal (a booking within 30 minutes, a table in use)
 * shows in place. Plain post without JavaScript, and nothing personal in it.
 * No table is ever disabled: the list is as old as the page, so the server answers
 * for the table (with a link to the booking in its way). A disabled option would
 * also post no table at all once a refresh disabled the chosen one.
 * The party size's minus and plus buttons are an enhancement on a number input.
 */
export function WalkInForm({ tables }: { tables: WalkInTable[] }) {
  if (tables.length === 0) return null;
  return (
    <section aria-labelledby="walk-in" className={cn(cardClassName, "px-4 py-4 md:px-5")}>
      <ActionForm
        action="/api/bookings/walk-in"
        resetOnSuccess
        refreshOnRefusal
        savedMessage="Walk-in seated."
        className="flex flex-wrap items-end gap-3 md:gap-4 [&>[role=alert]]:basis-full [&>[role=status]]:basis-full"
      >
        <h2 id="walk-in" className="basis-full text-lead font-semibold md:mr-auto md:basis-auto md:self-center">
          Seat a walk-in
        </h2>
        <Field label="Table" className="min-w-0 flex-1 md:w-48 md:flex-none">
          {/* No table is chosen for them: a default could be one that is in use. The
              placeholder isn't disabled, so it is what's left when a refresh drops the
              chosen table (archived), not the first table; `required` refuses it. */}
          <Select name="tableId" required defaultValue="">
            <option value="">Choose a table</option>
            {tables.map((table) => (
              <option key={table.id} value={table.id}>
                {table.label} (seats {table.capacity}), {availability(table)}
              </option>
            ))}
          </Select>
        </Field>
        <div className="flex flex-col gap-1.5">
          <span id="walk-in-party" className="text-caption font-medium text-ink-2">
            Party size
          </span>
          <Stepper
            name="party"
            min={1}
            max={100}
            required
            aria-labelledby="walk-in-party"
            decreaseLabel="One fewer guest"
            increaseLabel="One more guest"
          />
        </div>
        <Button type="submit" size="staff" className="w-full md:w-auto">
          Seat walk-in
        </Button>
      </ActionForm>
    </section>
  );
}
