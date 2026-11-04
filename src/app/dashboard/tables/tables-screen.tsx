import Link from "next/link";
import { Button } from "@/components/ui/button";
import { listTables } from "@/lib/tables";
import { getTenantContext, requireOwner } from "@/lib/tenant";
import { ActionForm } from "../action-form";
import { Field, inputClassName } from "../field";

/** The table manager: owner only (S-26). Adding, so far; the rest of spec 03 follows. */
export async function TablesScreen() {
  const tenant = await getTenantContext();
  requireOwner(tenant);
  const tables = await listTables(tenant);

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
          {tables.map((table) => (
            <li key={table.id} className="flex justify-between gap-4 py-2">
              <span className="font-medium">{table.label}</span>
              <span className="text-sm text-muted-foreground">
                Seats {table.capacity}
                {!table.bookable && ", walk-ins only"}
              </span>
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
