import "server-only";
import { readCsvTable } from "@/lib/csv";
import {
  type ImportReport,
  type ImportValues,
  importColumns,
  reportOf,
  reportRow,
} from "@/lib/csv-import";
import { newOwner, newRestaurant, unknownTimezone } from "@/lib/new-restaurant";
import { slugFrom } from "@/lib/slug";
import {
  type CurrencyMode,
  createFirstOwner,
  createRestaurant,
  DEFAULT_TIMEZONE,
  listRestaurants,
  type PlatformAdminContext,
} from "@/lib/tenant/platform-admin";

/**
 * Restaurants with their first owners, from CSV, on /admin (S-42, S-43).
 * Platform admin only: callers have getPlatformAdminContext(), and every write
 * is the same pair of platform_* functions the single forms call (S-28), which
 * audit themselves. A restaurant and its owner are two of those calls, so this
 * goes row by row, not in one transaction; an owner whose email turns out to
 * be taken leaves its restaurant made and ownerless, which the admin finishes
 * from the restaurant's card as with the single form.
 */

type Admin = Pick<PlatformAdminContext, "platformAdminId">;
type Row = ImportValues<"restaurants">;

/** A row with no currency_mode: USD with ZiG beneath it, spec 02's example. */
export const DEFAULT_CURRENCY_MODE: CurrencyMode = "usd_primary";

type Ready = {
  restaurant: { name: string; slug: string; timezone: string; currencyMode: CurrencyMode };
  owner: { email: string; displayName: string };
};
type Planned = { row: Row; problems: string[]; notes: string[]; ready?: Ready };

const messages = {
  noSlug: "Add a slug: one can't be made from this name.",
  slugTaken: (slug: string) => `The slug ${slug} is already in use.`,
  ownerTaken:
    "The restaurant was created, but not its owner: that email is already in use. Add the owner from the restaurant's card.",
  ownerNotMade: "The restaurant was created, but not its owner. Add the owner from the restaurant's card.",
  inviteNotSent: "The owner was added, but the invite email didn't go. Send it again from the restaurant's card.",
};

async function plan(admin: Admin, rows: Row[]) {
  const slugsInUse = new Set((await listRestaurants(admin)).map((restaurant) => restaurant.slug));
  const slugsInFile = new Map<string, number>();
  const emailsInFile = new Map<string, number>();

  return rows.map((row): Planned => {
    const { values } = row;
    const problems: string[] = [];
    const notes: string[] = [];

    const slug = values.slug || slugFrom(values.name);
    if (!values.slug && values.name) {
      if (slug) notes.push(`The slug will be ${slug}.`);
      else problems.push(messages.noSlug);
    }
    if (!values.timezone) notes.push(`No timezone given, so ${DEFAULT_TIMEZONE}.`);
    if (!values.currencyMode) notes.push(`No currency mode given, so ${DEFAULT_CURRENCY_MODE}.`);

    const restaurant = newRestaurant.safeParse({
      name: values.name,
      slug,
      timezone: values.timezone,
      currencyMode: values.currencyMode.toLowerCase() || DEFAULT_CURRENCY_MODE,
    });
    if (!restaurant.success) {
      // A missing slug has said why already.
      const issues = restaurant.error.issues.filter((issue) => slug || issue.path[0] !== "slug");
      problems.push(...issues.map((issue) => issue.message));
    }
    const owner = newOwner.safeParse({ email: values.ownerEmail, displayName: values.ownerName });
    if (!owner.success) problems.push(...owner.error.issues.map((issue) => issue.message));

    if (restaurant.success) {
      const { slug } = restaurant.data;
      if (slugsInUse.has(slug)) problems.push(messages.slugTaken(slug));
      else if (slugsInFile.has(slug)) problems.push(`The slug ${slug} is already in this file, on line ${slugsInFile.get(slug)}.`);
    }
    if (owner.success && emailsInFile.has(owner.data.email)) {
      problems.push(`${owner.data.email} is already in this file, on line ${emailsInFile.get(owner.data.email)}.`);
    }

    if (problems.length > 0 || row.extraCells || !restaurant.success || !owner.success) {
      return { row, problems: [...new Set(problems)], notes };
    }
    slugsInFile.set(restaurant.data.slug, row.line);
    emailsInFile.set(owner.data.email, row.line);
    return { row, problems, notes, ready: { restaurant: restaurant.data, owner: owner.data } };
  });
}

const toReport = (planned: Planned[], imported: number | null): ImportReport =>
  reportOf(
    "restaurants",
    planned.map(({ row, problems, notes }) => reportRow("restaurants", row, problems, notes)),
    imported,
  );

const read = (csv: string) => readCsvTable(csv, importColumns.restaurants);

/** What importing would do, row by row. Writes nothing. */
export async function previewRestaurantsImport(
  admin: Admin,
  csv: string,
): Promise<ImportReport | { error: string }> {
  const table = read(csv);
  if (!table.ok) return { error: table.error };
  return toReport(await plan(admin, table.rows), null);
}

/**
 * Creates each valid restaurant, then its owner, in file order. Counts the
 * restaurants made; an owner refused is a note on its row.
 */
export async function importRestaurants(
  admin: Admin,
  csv: string,
): Promise<ImportReport | { error: string }> {
  const table = read(csv);
  if (!table.ok) return { error: table.error };

  const planned = await plan(admin, table.rows);
  let imported = 0;
  for (const entry of planned) {
    if (!entry.ready) continue;
    const { restaurant, owner } = entry.ready;
    const created = await createRestaurant(admin, restaurant);
    if ("problem" in created) {
      entry.problems.push(
        created.problem === "slug_taken" ? messages.slugTaken(restaurant.slug) : unknownTimezone,
      );
      continue;
    }
    imported++;
    const first = await createFirstOwner(admin, created.id, owner);
    if ("problem" in first) {
      entry.notes.push(first.problem === "email_taken" ? messages.ownerTaken : messages.ownerNotMade);
    } else if (!first.invited) {
      entry.notes.push(messages.inviteNotSent);
    }
  }
  return toReport(planned, imported);
}
