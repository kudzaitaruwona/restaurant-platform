import { Button } from "@/components/ui/button";
import { cardClassName } from "@/components/ui/card";
import { Field, Select } from "@/components/ui/input";
import { Stepper } from "@/components/ui/stepper";
import { cn } from "@/lib/utils";
import { ActionForm } from "../action-form";

/**
 * Seat walk-in (spec 04): a table and a party size, posted to
 * /api/bookings/walk-in. A refusal (a booking within 30 minutes, a table in use)
 * shows in place. Plain post without JavaScript, and nothing personal in it.
 * The party size's minus and plus buttons are an enhancement on a number input.
 */
export function WalkInForm({
  tables,
}: {
  tables: { id: string; label: string; capacity: number }[];
}) {
  if (tables.length === 0) return null;
  return (
    <section aria-labelledby="walk-in" className={cn(cardClassName, "px-4 py-4 md:px-5")}>
      <ActionForm
        action="/api/bookings/walk-in"
        resetOnSuccess
        savedMessage="Walk-in seated."
        className="flex flex-wrap items-end gap-3 md:gap-4 [&>[role=alert]]:basis-full [&>[role=status]]:basis-full"
      >
        <h2 id="walk-in" className="basis-full text-lead font-semibold md:mr-auto md:basis-auto md:self-center">
          Seat a walk-in
        </h2>
        <Field label="Table" className="min-w-0 flex-1 md:w-48 md:flex-none">
          <Select name="tableId" required>
            {tables.map((table) => (
              <option key={table.id} value={table.id}>
                {table.label} (seats {table.capacity})
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
