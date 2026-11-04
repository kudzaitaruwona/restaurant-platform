import Link from "next/link";
import { getEnv } from "@/lib/env";
import { parsePrintOptions, type RawSearchParams } from "@/lib/print-options";
import { menuCodeUrl, qrSvg, tableCodeUrl } from "@/lib/qr-code";
import { getPrintHeader, listTables } from "@/lib/tables";
import { getTenantContext, requireOwner } from "@/lib/tenant";

/**
 * The print sheet (spec 03): one card per table, printed with the browser's own
 * print function. A4, two cards across and three down, and a card never splits
 * over a page. Owner only (S-26): the codes are the tables' keys.
 *
 * What to print comes from the query string (a plain GET form, so no client
 * code): all tables or chosen ones, the generic menu card, and whether the Wi-Fi
 * password goes on the cards. Chosen ids are matched against the session
 * restaurant's own live tables, so an id from anywhere else matches nothing.
 */

// A4 with a 6mm page margin leaves 198mm x 285mm: two 99mm columns, and three
// rows that must sum to no more than 285mm. 94mm cards leave 3mm to spare. What
// goes on a card is boxed to fit that: padding 2.5mm + name 9.5 + label 14 + QR
// 50 + instruction 4.5 + Wi-Fi 6.5 + four 1mm gaps = 91mm.
const PAGE_CSS = "@page{size:A4;margin:6mm}";

type Card = { key: string; heading: string; svg: string; label: string; instruction: string };

/** A long label steps down in size so it stays on its card; the box never grows. */
const labelSize = (label: string) =>
  label.length <= 6 ? "text-5xl" : label.length <= 13 ? "text-3xl" : "text-lg";

export async function PrintSheet({
  searchParams,
}: {
  searchParams?: Promise<RawSearchParams>;
} = {}) {
  const tenant = await getTenantContext();
  requireOwner(tenant);
  const options = parsePrintOptions(await searchParams);
  const [tables, restaurant] = await Promise.all([
    listTables(tenant),
    getPrintHeader(tenant),
  ]);
  const appUrl = getEnv().NEXT_PUBLIC_APP_URL;

  const chosen = new Set(options.tableIds);
  const printed =
    options.scope === "all" ? tables : tables.filter((table) => chosen.has(table.id));

  const cards: Card[] = await Promise.all(
    printed.map(async (table) => ({
      key: table.id,
      heading: restaurant.name,
      label: table.label,
      svg: await qrSvg(tableCodeUrl(appUrl, table.qrToken)),
      instruction: "Scan to see the menu",
    })),
  );
  if (options.menuCard) {
    cards.unshift({
      key: "menu",
      heading: restaurant.name,
      label: "View our menu",
      svg: await qrSvg(menuCodeUrl(appUrl, restaurant.menuToken)),
      instruction: "Scan to see the menu",
    });
  }

  const wifi = restaurant.wifiName
    ? `Wi-Fi: ${restaurant.wifiName}${
        restaurant.wifiPassword && options.wifiPassword
          ? `, password ${restaurant.wifiPassword}`
          : ""
      }`
    : undefined;

  return (
    <>
      <style>{PAGE_CSS}</style>
      <div className="flex flex-col gap-1 print:hidden">
        <Link href="/dashboard/tables" className="text-sm text-muted-foreground underline">
          Back to tables
        </Link>
        <h1 className="font-heading text-3xl font-semibold tracking-tight">Print QR codes</h1>
        <p className="text-sm text-muted-foreground">
          Use your browser&apos;s print function, on A4. Each card is cut out and put on its table.
        </p>
      </div>

      {tables.length === 0 ? (
        <p className="text-sm text-muted-foreground print:hidden">
          Add a table first, and its code will be here.
        </p>
      ) : (
        <>
          <form
            method="get"
            action="/dashboard/tables/print"
            className="flex flex-col gap-3 text-sm print:hidden"
          >
            <fieldset className="flex flex-col gap-2">
              <legend className="font-medium">Tables</legend>
              <label className="flex items-center gap-2">
                <input type="radio" name="scope" value="all" defaultChecked={options.scope === "all"} />
                All tables
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="scope"
                  value="selected"
                  defaultChecked={options.scope === "selected"}
                />
                Only the tables ticked here
              </label>
              <ul className="flex flex-wrap gap-x-4 gap-y-1 pl-6">
                {tables.map((table) => (
                  <li key={table.id}>
                    <label className="flex items-center gap-1">
                      <input
                        type="checkbox"
                        name="table"
                        value={table.id}
                        defaultChecked={chosen.has(table.id)}
                      />
                      {table.label}
                    </label>
                  </li>
                ))}
              </ul>
            </fieldset>
            <label className="flex items-center gap-2">
              <input type="checkbox" name="menu" value="1" defaultChecked={options.menuCard} />
              Add a &quot;View our menu&quot; card, for the door or counter
            </label>
            {restaurant.wifiName && restaurant.wifiPassword && (
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  name="nopassword"
                  value="1"
                  defaultChecked={!options.wifiPassword}
                />
                Leave the Wi-Fi password off the cards (customers see it when it&apos;s printed)
              </label>
            )}
            <button type="submit" className="w-fit rounded-md border px-3 py-1.5">
              Update the sheet
            </button>
          </form>

          {cards.length === 0 ? (
            <p className="text-sm text-muted-foreground print:hidden">
              Tick at least one table, or add the menu card, to print.
            </p>
          ) : (
            <ul className="grid grid-cols-2 gap-4 print:gap-0">
              {cards.map((card) => (
                <li
                  key={card.key}
                  className="flex flex-col items-center justify-between break-inside-avoid gap-1 overflow-hidden border p-4 text-center print:h-[94mm] print:gap-[1mm] print:rounded-none print:p-[2.5mm]"
                >
                  <p className="line-clamp-2 w-full break-words text-sm font-semibold leading-tight print:h-[9.5mm]">
                    {card.heading}
                  </p>
                  <p
                    className={`line-clamp-2 flex w-full items-center justify-center break-words font-bold leading-none print:h-[14mm] ${labelSize(card.label)}`}
                  >
                    {card.label}
                  </p>
                  <div
                    role="img"
                    aria-label={`QR code for ${card.label}`}
                    className="w-[5cm] shrink-0 [&>svg]:h-auto [&>svg]:w-full"
                    dangerouslySetInnerHTML={{ __html: card.svg }}
                  />
                  <p className="text-sm leading-tight print:h-[4.5mm]">{card.instruction}</p>
                  {wifi && (
                    <p className="line-clamp-2 w-full break-words text-xs leading-tight print:h-[6.5mm]">
                      {wifi}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </>
  );
}
