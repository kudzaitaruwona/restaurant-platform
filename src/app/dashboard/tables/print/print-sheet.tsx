import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { cn } from "@/lib/utils";
import { getEnv } from "@/lib/env";
import { parsePrintOptions, type RawSearchParams } from "@/lib/print-options";
import { menuCodeUrl, qrSvg, tableCodeUrl } from "@/lib/qr-code";
import { getPrintHeader, listTables } from "@/lib/tables";
import { getTenantContext, requireOwner } from "@/lib/tenant";
import { PrintButton, PrintControls, PrintForm, PrintStyles, TablePicker } from "./print-controls";

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
// goes on a card is boxed to fit that: two 2mm paddings + two 1px borders 0.53 +
// name 9.5 + label 13 + QR 50 + instruction 4.5 + Wi-Fi 10 + four 0.5mm gaps =
// 93.53mm.
const PAGE_CSS = "@page{size:A4;margin:6mm}";

// On paper the sheet is the whole page: the shell's grid steps aside (its rail
// and top bar are already print:hidden), and everything prints black on white,
// whatever theme the screen is in.
// The page margin shows the root's background, so that goes white too: a dark
// theme with "background graphics" on would otherwise print a black border. A
// stale sheet (form changed, not yet updated) prints nothing.
const PRINT_CSS =
  "@media print{:root{color-scheme:light!important}html,body{background:#fff!important}" +
  "[data-staff-shell]{background:#fff!important;color:#111!important}" +
  "[data-print-stale] [aria-label=Preview]{display:none!important}" +
  "[data-staff-shell]>div:has(main[data-print-sheet]){display:block!important}}";

// A table's code takes orders as well as showing the menu (spec 06), and there's
// no per-restaurant ordering switch yet, so every table card says so. The generic
// menu card is menu-view only and never allows ordering (spec 03), so it doesn't.
const INSTRUCTION = "Scan to see the menu and order";
const MENU_ONLY_INSTRUCTION = "Scan to see the menu";

type Card = { key: string; heading: string; svg: string; label: string; instruction: string };

/** A long label steps down in size so it stays on its card; the box never grows. */
const labelSize = (label: string) =>
  label.length <= 6 ? "text-5xl" : label.length <= 13 ? "text-3xl" : "text-lg";

/**
 * The sizes the Wi-Fi box steps down through, each with what fits in its 10mm:
 * lines, and characters to a line of the card's 94mm. A character counts as 1em
 * wide, which no Latin one is over, and break-all fills every line, so a count
 * that fits here fits on paper. A cut-off password reads as a wrong one, so the
 * box has no clamp: anything past the last size isn't printed at all.
 */
const WIFI_SIZES = [
  { className: "text-xs leading-tight", lines: 2, perLine: 29 },
  { className: "text-[10px] leading-tight", lines: 3, perLine: 35 },
  { className: "text-[8px] leading-[1.15]", lines: 4, perLine: 44 },
];

const wifiSize = (text: string[]) =>
  WIFI_SIZES.find(
    ({ lines, perLine }) =>
      text.reduce((sum, line) => sum + Math.ceil(line.length / perLine), 0) <= lines,
  )?.className;

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
      instruction: INSTRUCTION,
    })),
  );
  if (options.menuCard) {
    cards.unshift({
      key: "menu",
      heading: restaurant.name,
      label: "View our menu",
      svg: await qrSvg(menuCodeUrl(appUrl, restaurant.menuToken)),
      instruction: MENU_ONLY_INSTRUCTION,
    });
  }

  const wifiLines = restaurant.wifiName ? [`Wi-Fi: ${restaurant.wifiName}`] : [];
  if (restaurant.wifiName && restaurant.wifiPassword && options.wifiPassword) {
    wifiLines.push(`Password: ${restaurant.wifiPassword}`);
  }
  const wifiFits = wifiSize(wifiLines);
  const wifi = wifiFits
    ? { lines: wifiLines, size: wifiFits }
    : { lines: ["Ask staff for the Wi-Fi details"], size: WIFI_SIZES[0].className };

  return (
    <PrintControls>
      <PrintStyles css={[PAGE_CSS, PRINT_CSS]} />
      <noscript>
        <p className="rounded-control bg-attention-soft px-4 py-3 text-ink print:hidden">
          Without JavaScript the sheet can&apos;t tell when you have changed an option. After
          changing one, press &quot;Update the sheet&quot; before you print, or Ctrl+P prints the
          sheet as it was last made.
        </p>
      </noscript>
      <div className="flex flex-col gap-2 print:hidden">
        <Link
          href="/dashboard/tables"
          className={cn(buttonVariants({ variant: "ghost", size: "compact", className: "-ml-3.5 self-start text-ink-2" }))}
        >
          <ArrowLeft aria-hidden />
          Back to tables
        </Link>
        <PageHeader
          title="Print QR codes"
          subtitle="Print on A4, then cut out each card and put it on its table."
          actions={tables.length > 0 && cards.length > 0 ? <PrintButton /> : undefined}
        />
      </div>

      {tables.length === 0 ? (
        <p className="text-ink-2 print:hidden">Add a table first, and its code will be here.</p>
      ) : (
        <>
          <Card className="p-4 sm:p-5 print:hidden">
            <PrintForm>
              <TablePicker
                tables={tables.map(({ id, label }) => ({ id, label }))}
                scope={options.scope}
                tableIds={options.tableIds.filter((id) => tables.some((table) => table.id === id))}
              />
              <div className="flex flex-col gap-1 border-t border-line pt-4">
                <label className="flex min-h-12 cursor-pointer items-center gap-3">
                  <input
                    type="checkbox"
                    name="menu"
                    value="1"
                    defaultChecked={options.menuCard}
                    className="size-5 shrink-0 cursor-pointer accent-brand"
                  />
                  Add a &quot;View our menu&quot; card, for the door or counter
                </label>
                {restaurant.wifiName && restaurant.wifiPassword && (
                  <label className="flex min-h-12 cursor-pointer items-center gap-3">
                    <input
                      type="checkbox"
                      name="nopassword"
                      value="1"
                      defaultChecked={!options.wifiPassword}
                      className="size-5 shrink-0 cursor-pointer accent-brand"
                    />
                    Leave the Wi-Fi password off the cards (customers see it when it&apos;s printed)
                  </label>
                )}
              </div>
              <button
                type="submit"
                className={cn(buttonVariants({ variant: "secondary", size: "staff", className: "self-start" }))}
              >
                Update the sheet
              </button>
            </PrintForm>
          </Card>

          {!wifiFits && (
            <p className="rounded-control bg-attention-soft px-4 py-3 text-ink print:hidden">
              The Wi-Fi details are too long to fit on a card, so the cards say to ask staff. A
              shorter name or password in Settings will print.
            </p>
          )}

          {cards.length === 0 ? (
            <p className="rounded-control bg-surface-2 px-4 py-3 text-ink print:hidden">
              Tick at least one table, or add the menu card, to print.
            </p>
          ) : (
            <section aria-label="Preview" className="flex flex-col gap-3 print:block">
              <h2 className="text-caption font-medium text-ink-2 print:hidden">
                Preview: {cards.length} {cards.length === 1 ? "card" : "cards"}
              </h2>
              <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 print:grid-cols-2 print:gap-0">
                {cards.map((card) => (
                  <li
                    key={card.key}
                    className="flex flex-col items-center justify-between break-inside-avoid gap-1 overflow-hidden rounded-card border border-[#d4d4d4] bg-white p-4 text-center text-[#111] print:h-[94mm] print:gap-[0.5mm] print:rounded-none print:border-[#999] print:p-[2mm]"
                  >
                    <p className="line-clamp-2 w-full break-words text-sm font-semibold leading-tight print:h-[9.5mm]">
                      {card.heading}
                    </p>
                    <p
                      className={`line-clamp-2 flex w-full items-center justify-center break-words font-bold leading-none print:h-[13mm] ${labelSize(card.label)}`}
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
                    {wifi.lines.length > 0 && (
                      <div className={`w-full break-all print:h-[10mm] ${wifi.size}`}>
                        {wifi.lines.map((line) => (
                          <p key={line}>{line}</p>
                        ))}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </PrintControls>
  );
}
