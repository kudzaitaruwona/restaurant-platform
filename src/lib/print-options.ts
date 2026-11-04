/**
 * What the print sheet was asked to print (spec 03 › Print sheet), read from the
 * page's query string. Nothing here is trusted: table ids only ever pick from the
 * session restaurant's own tables, and anything unreadable falls back to the
 * default, which is every table, no menu card, Wi-Fi password included.
 */

export type RawSearchParams = Record<string, string | string[] | undefined>;

export type PrintOptions = {
  scope: "all" | "selected";
  /** Only meaningful for "selected". Well-formed ids; whether they're this restaurant's is the caller's check. */
  tableIds: string[];
  menuCard: boolean;
  wifiPassword: boolean;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_IDS = 500;

const list = (value: string | string[] | undefined) =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

export function parsePrintOptions(raw: RawSearchParams = {}): PrintOptions {
  return {
    scope: list(raw.scope)[0] === "selected" ? "selected" : "all",
    tableIds: [...new Set(list(raw.table).filter((id) => UUID.test(id)))].slice(0, MAX_IDS),
    menuCard: list(raw.menu).length > 0,
    wifiPassword: list(raw.nopassword).length === 0,
  };
}
