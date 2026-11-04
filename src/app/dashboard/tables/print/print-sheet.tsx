import Link from "next/link";
import { getEnv } from "@/lib/env";
import { qrSvg, tableCodeUrl } from "@/lib/qr-code";
import { getPrintHeader, listTables } from "@/lib/tables";
import { getTenantContext, requireOwner } from "@/lib/tenant";

/**
 * The print sheet (spec 03): one card per table, printed with the browser's own
 * print function. A4, two cards across and three down, and a card never splits
 * over a page. Owner only (S-26): the codes are the tables' keys.
 */
export async function PrintSheet() {
  const tenant = await getTenantContext();
  requireOwner(tenant);
  const [tables, restaurant] = await Promise.all([
    listTables(tenant),
    getPrintHeader(tenant),
  ]);
  const appUrl = getEnv().NEXT_PUBLIC_APP_URL;
  const cards = await Promise.all(
    tables.map(async (table) => ({
      ...table,
      svg: await qrSvg(tableCodeUrl(appUrl, table.qrToken)),
    })),
  );
  const wifi = restaurant.wifiName
    ? `Wi-Fi: ${restaurant.wifiName}${restaurant.wifiPassword ? `, password ${restaurant.wifiPassword}` : ""}`
    : undefined;

  return (
    <>
      <style>{"@page{size:A4;margin:8mm}"}</style>
      <div className="flex flex-col gap-1 print:hidden">
        <Link href="/dashboard/tables" className="text-sm text-muted-foreground underline">
          Back to tables
        </Link>
        <h1 className="font-heading text-3xl font-semibold tracking-tight">Print QR codes</h1>
        <p className="text-sm text-muted-foreground">
          Use your browser&apos;s print function, on A4. Each card is cut out and put on its table.
        </p>
      </div>

      {cards.length === 0 ? (
        <p className="text-sm text-muted-foreground print:hidden">
          Add a table first, and its code will be here.
        </p>
      ) : (
        <ul className="grid grid-cols-2 gap-4 print:gap-0">
          {cards.map((card) => (
            <li
              key={card.id}
              className="flex flex-col items-center justify-between break-inside-avoid gap-2 border p-4 text-center print:h-[93mm] print:rounded-none"
            >
              <p className="text-lg font-semibold">{restaurant.name}</p>
              <p className="text-6xl font-bold leading-none">{card.label}</p>
              <div
                role="img"
                aria-label={`QR code for table ${card.label}`}
                className="w-[5cm] [&>svg]:h-auto [&>svg]:w-full"
                dangerouslySetInnerHTML={{ __html: card.svg }}
              />
              <p className="text-sm">Scan to see the menu</p>
              {wifi && <p className="text-xs">{wifi}</p>}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
