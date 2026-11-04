import Link from "next/link";
import { Button } from "@/components/ui/button";
import { getBookingSettings } from "@/lib/booking-settings";
import { listTables } from "@/lib/tables";
import { getTenantContext, requireOwner } from "@/lib/tenant";
import { ActionForm } from "../action-form";
import { Field, inputClassName } from "../field";

/** The table manager: owner only (S-26). Add, edit, reorder, archive and regenerate a table's code. */
export async function TablesScreen() {
  const tenant = await getTenantContext();
  requireOwner(tenant);
  const [tables, bookingSettings] = await Promise.all([
    listTables(tenant),
    getBookingSettings(tenant),
  ]);
  const onlyBookableTable =
    bookingSettings.enabled && tables.filter((table) => table.bookable).length === 1;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/dashboard" className="text-sm text-muted-foreground underline">
          Back to dashboard
        </Link>
        <h1 className="font-heading text-3xl font-semibold tracking-tight">Tables</h1>
        {tables.length > 0 && (
          <Link href="/dashboard/tables/print" className="text-sm underline">
            Print QR codes
          </Link>
        )}
      </div>

      {tables.length === 0 ? (
        <p className="text-sm text-muted-foreground">No tables yet.</p>
      ) : (
        <ul className="flex flex-col divide-y">
          {tables.map((table, index) => (
            <li key={table.id} className="flex flex-col gap-2 py-3">
              <ActionForm
                action={`/api/tables/${table.id}`}
                savedMessage="Saved. Capacity changes apply to bookings made from now on. If you made the last bookable table walk-ins only, online booking has switched off."
                className="flex flex-wrap items-end gap-3"
              >
                <span className="w-6 pb-2 text-sm text-muted-foreground" title="Position in the list">
                  {index + 1}
                </span>
                <Field label="Label">
                  <input
                    name="label"
                    defaultValue={table.label}
                    required
                    maxLength={50}
                    className={inputClassName}
                  />
                </Field>
                <Field label="Seats">
                  <input
                    name="capacity"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={100}
                    defaultValue={table.capacity}
                    required
                    className={inputClassName}
                  />
                </Field>
                <input type="hidden" name="bookable" value="false" />
                <label className="flex items-center gap-2 pb-2 text-sm font-medium">
                  <input
                    type="checkbox"
                    name="bookable"
                    value="true"
                    defaultChecked={table.bookable}
                  />
                  Bookable online
                </label>
                <Button type="submit" size="sm">
                  Save
                </Button>
              </ActionForm>
              <div className="flex gap-2">
                {(["up", "down"] as const).map((direction) => (
                  <ActionForm key={direction} action={`/api/tables/${table.id}/move`}>
                    <input type="hidden" name="direction" value={direction} />
                    <Button
                      type="submit"
                      size="sm"
                      variant="outline"
                      disabled={direction === "up" ? index === 0 : index === tables.length - 1}
                    >
                      Move {direction}
                    </Button>
                  </ActionForm>
                ))}
                <ActionForm
                  action={`/api/tables/${table.id}/archive`}
                  confirmation={
                    `Archive table ${table.label}? Its printed QR code will stop working.` +
                    (onlyBookableTable && table.bookable
                      ? " It's the last table guests can book, so online booking will switch off."
                      : "")
                  }
                >
                  <Button type="submit" size="sm" variant="outline">
                    Archive
                  </Button>
                </ActionForm>
                <ActionForm
                  action={`/api/tables/${table.id}/regenerate`}
                  confirmation={`The printed code on Table ${table.label} will stop working. Make a new one?`}
                  savedMessage={`New code made for Table ${table.label}. The old one has stopped working: reprint it from the print sheet.`}
                >
                  <Button type="submit" size="sm" variant="outline">
                    Regenerate QR
                  </Button>
                </ActionForm>
              </div>
            </li>
          ))}
        </ul>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="font-heading text-xl font-semibold">Add a table</h2>
        <ActionForm
          action="/api/tables"
          savedMessage="Table added. Its QR code is on the print sheet."
          resetOnSuccess
          className="flex flex-col gap-4"
        >
          <Field label="Label" hint="What staff call it, like 7, B2 or Patio 1.">
            <input name="label" required maxLength={50} className={inputClassName} />
          </Field>
          <Field label="Seats">
            <input
              name="capacity"
              type="number"
              inputMode="numeric"
              min={1}
              max={100}
              required
              className={inputClassName}
            />
          </Field>
          <Button type="submit" className="self-start">
            Add table
          </Button>
        </ActionForm>
      </section>
    </div>
  );
}
