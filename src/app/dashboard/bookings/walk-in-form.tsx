import { Button } from "@/components/ui/button";
import { ActionForm } from "../action-form";

/**
 * Seat walk-in (spec 04): a table and a party size, posted to
 * /api/bookings/walk-in. A refusal (a booking within 30 minutes, a table in use)
 * shows in place. Plain post without JavaScript, and nothing personal in it.
 */
export function WalkInForm({
  tables,
}: {
  tables: { id: string; label: string; capacity: number }[];
}) {
  if (tables.length === 0) return null;
  return (
    <section className="flex flex-col gap-2">
      <h2 className="font-heading text-xl font-semibold">Seat a walk-in</h2>
      <ActionForm action="/api/bookings/walk-in" resetOnSuccess savedMessage="Walk-in seated." className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm font-medium">
          Table
          <select name="tableId" required className="rounded-md border bg-background px-2 py-1.5">
            {tables.map((table) => (
              <option key={table.id} value={table.id}>
                {table.label} (seats {table.capacity})
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          Party size
          <input
            type="number"
            name="party"
            min={1}
            max={100}
            required
            inputMode="numeric"
            className="w-24 rounded-md border bg-background px-2 py-1.5"
          />
        </label>
        <Button type="submit" size="sm">
          Seat walk-in
        </Button>
      </ActionForm>
    </section>
  );
}
