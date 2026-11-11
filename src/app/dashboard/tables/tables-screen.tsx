import { Archive, ArrowDown, ArrowUp, Plus, Printer, QrCode, RefreshCw } from "lucide-react";
import Link from "next/link";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { IconButton } from "@/components/ui/icon-button";
import { PageHeader } from "@/components/ui/page-header";
import { RowMenu, RowMenuItem, RowMenuSeparator } from "@/components/ui/row-menu";
import { Stepper } from "@/components/ui/stepper";
import { getBookingSettings } from "@/lib/booking-settings";
import { listTables } from "@/lib/tables";
import { getTenantContext, requireOwner } from "@/lib/tenant";
import { cn } from "@/lib/utils";
import { ActionForm } from "../action-form";
import { StaffTopBarAction } from "../shell/top-bar-action";
import { Field, inputClassName } from "../field";

/** A form with no controls of its own: it takes room only once it has an answer to show. */
const answerOnly = "has-[[role]]:pt-2";

/**
 * The table manager: owner only (S-26). Add, edit, reorder, archive and regenerate a table's code.
 *
 * Layout (S-41): one row per table, edited in place. The row's controls all sit
 * inside its edit form; Move up, Move down, Regenerate QR and Archive submit
 * forms of their own (by `form=`), which show their answers under the row.
 * The rare, destructive two sit behind More and confirm in a dialog.
 */
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
    <div className="flex max-w-4xl flex-col gap-6">
      <PageHeader
        title="Tables"
        subtitle="Each table has its own QR code. Guests scan it to see the menu and order."
        actions={
          <>
            {tables.length > 0 && (
              <Link
                href="/dashboard/tables/print"
                className={cn(buttonVariants({ variant: "secondary", size: "staff" }))}
              >
                <Printer aria-hidden />
                Print QR codes
              </Link>
            )}
            {tables.length > 0 && (
              <a
                href="#add-table"
                className={cn(buttonVariants({ variant: "primary", size: "staff" }), "hidden md:inline-flex")}
              >
                <Plus aria-hidden />
                Add table
              </a>
            )}
          </>
        }
      />
      {tables.length > 0 && (
        <StaffTopBarAction>
          <IconButton label="Add table" icon={<Plus />} href="#add-table" variant="ghost" />
        </StaffTopBarAction>
      )}

      {tables.length === 0 ? (
        <FirstTable />
      ) : (
        <Card className="overflow-hidden">
          <div
            aria-hidden
            className="hidden items-center gap-3 border-b border-line px-4 py-2.5 text-caption font-medium text-ink-2 md:flex"
          >
            <span className="w-7">#</span>
            <span className="flex-1">Label</span>
            <span className="w-24">Seats</span>
            <span className="w-[333px]">Online booking</span>
          </div>
          <ul className="divide-y divide-line">
            {tables.map((table, index) => {
              const formId = (what: string) => `table-${table.id}-${what}`;
              return (
                <li key={table.id} className="flex flex-col px-4 py-3">
                  <ActionForm
                    action={`/api/tables/${table.id}`}
                    savedMessage="Saved. Capacity changes apply to bookings made from now on. If you made the last bookable table walk-ins only, online booking has switched off."
                    className="flex flex-col gap-1"
                  >
                    <div className="flex flex-wrap items-end gap-x-3 gap-y-1 md:flex-nowrap md:items-center">
                      <div className="flex min-w-0 flex-1 basis-full items-end gap-3 md:basis-auto md:items-center">
                        <span
                          className="flex h-12 w-7 shrink-0 items-center text-lead font-semibold text-ink-2 tabular-nums"
                          title="Position in the list"
                        >
                          {index + 1}
                        </span>
                        <Field
                          label={<span className="md:sr-only">Label</span>}
                          className="min-w-0 flex-1"
                        >
                          <input
                            name="label"
                            defaultValue={table.label}
                            required
                            maxLength={50}
                            className={cn(inputClassName, "font-semibold")}
                          />
                        </Field>
                        <Field
                          label={<span className="md:sr-only">Seats</span>}
                          className="w-20 shrink-0 md:w-24"
                        >
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
                      </div>
                      <div className="flex w-full min-w-0 items-center gap-1 sm:pl-10 md:w-auto md:pl-0">
                        <input type="hidden" name="bookable" value="false" />
                        <label className="flex min-h-12 min-w-0 flex-1 cursor-pointer items-center gap-2.5 pr-2 leading-tight font-medium md:flex-none md:pr-3">
                          <input
                            type="checkbox"
                            name="bookable"
                            value="true"
                            defaultChecked={table.bookable}
                            className="size-5 shrink-0 cursor-pointer accent-brand"
                          />
                          Bookable online
                        </label>
                        <Button type="submit" variant="secondary" size="compact" className="mr-1 md:mr-2">
                          Save
                        </Button>
                        <IconButton
                          type="submit"
                          form={formId("up")}
                          label={`Move table ${table.label} up`}
                          icon={<ArrowUp />}
                          variant="ghost"
                          size="compact"
                          disabled={index === 0}
                        />
                        <IconButton
                          type="submit"
                          form={formId("down")}
                          label={`Move table ${table.label} down`}
                          icon={<ArrowDown />}
                          variant="ghost"
                          size="compact"
                          disabled={index === tables.length - 1}
                        />
                        <RowMenu
                          label={`More for table ${table.label}`}
                          className="size-10 border-transparent bg-transparent"
                        >
                          <RowMenuItem icon={<RefreshCw />} form={formId("regenerate")}>
                            Regenerate QR
                          </RowMenuItem>
                          <RowMenuSeparator />
                          <RowMenuItem icon={<Archive />} tone="danger" form={formId("archive")}>
                            Archive table
                          </RowMenuItem>
                        </RowMenu>
                      </div>
                    </div>
                  </ActionForm>
                  {/* The forms the row's buttons submit; only their answers show. */}
                  {(["up", "down"] as const).map((direction) => (
                    <ActionForm
                      key={direction}
                      id={formId(direction)}
                      action={`/api/tables/${table.id}/move`}
                      className={answerOnly}
                    >
                      <input type="hidden" name="direction" value={direction} />
                    </ActionForm>
                  ))}
                  <ActionForm
                    id={formId("archive")}
                    action={`/api/tables/${table.id}/archive`}
                    className={answerOnly}
                    confirmation={
                      `Archive table ${table.label}? Its printed QR code will stop working.` +
                      (onlyBookableTable && table.bookable
                        ? " It's the last table guests can book, so online booking will switch off."
                        : "")
                    }
                  >
                    {null}
                  </ActionForm>
                  <ActionForm
                    id={formId("regenerate")}
                    action={`/api/tables/${table.id}/regenerate`}
                    className={answerOnly}
                    confirmation={`The printed code on Table ${table.label} will stop working. Make a new one?`}
                    savedMessage={`New code made for Table ${table.label}. The old one has stopped working: reprint it from the print sheet.`}
                  >
                    {null}
                  </ActionForm>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {tables.length > 0 && (
        <Card as="section" id="add-table" className="flex scroll-mt-20 flex-col gap-3 p-4 sm:p-5">
          <h2 className="text-lead font-semibold">Add a table</h2>
          <ActionForm
            action="/api/tables"
            savedMessage="Table added. Its QR code is on the print sheet."
            resetOnSuccess
            className="flex flex-col gap-2"
          >
            <div className="flex flex-wrap items-start gap-3">
              <Field
                label="Label"
                hint="What staff call it, like 7, B2 or Patio 1."
                className="min-w-48 flex-1"
              >
                <input name="label" required maxLength={50} className={inputClassName} />
              </Field>
              <Field label="Seats" className="w-24">
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
              <Button type="submit" size="staff" className="mt-[26px]">
                Add table
              </Button>
            </div>
          </ActionForm>
        </Card>
      )}
    </div>
  );
}

/**
 * No tables yet: the add form is the empty state, with the first label already
 * suggested. Once a table exists, the list and the usual add form take over.
 */
function FirstTable() {
  return (
    <Card
      as="section"
      id="add-table"
      aria-labelledby="first-table-title"
      className="flex scroll-mt-20 flex-col gap-4 p-5 sm:p-8"
    >
      <div className="flex flex-col items-start gap-4 sm:flex-row">
        <span aria-hidden className="grid size-12 shrink-0 place-items-center rounded-card bg-surface-2 text-ink [&_svg]:size-6">
          <QrCode strokeWidth={1.75} />
        </span>
        <div className="flex flex-col gap-1">
          <h2 id="first-table-title" className="text-title font-semibold">
            Add your first table
          </h2>
          <p className="max-w-[56ch] text-ink-2">
            Each table gets its own QR code. Guests scan it to open the menu and order from their seat.
          </p>
        </div>
      </div>
      <ActionForm
        action="/api/tables"
        savedMessage="Table added. Its QR code is on the print sheet."
        resetOnSuccess
        className="flex w-full flex-col gap-2"
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
          <Field label="Label" className="sm:w-52">
            <input name="label" required maxLength={50} defaultValue="T1" className={inputClassName} />
          </Field>
          <div className="flex flex-col gap-1.5 text-caption font-medium text-ink-2">
            <span id="first-table-seats">Seats</span>
            <Stepper
              name="capacity"
              aria-labelledby="first-table-seats"
              min={1}
              max={100}
              required
              defaultValue={2}
              decreaseLabel="Fewer seats"
              increaseLabel="More seats"
              className="self-start"
            />
          </div>
          <Button type="submit" size="staff" className="w-full sm:w-auto">
            Add table
          </Button>
        </div>
      </ActionForm>
      <p className="text-caption text-ink-2">The label is what staff call it, like 7, B2 or Patio 1.</p>
    </Card>
  );
}
