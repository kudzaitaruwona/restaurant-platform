import "server-only";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { categories, menuItems, restaurants } from "@/db/schema";
import { readCsvTable, yesNo } from "@/lib/csv";
import {
  type ImportReport,
  type ImportValues,
  importColumns,
  reportOf,
  reportRow,
  unique,
} from "@/lib/csv-import";
import { hasAPrice, itemFields, newCategory, noPrice } from "@/lib/menu";
import { revalidateMenu } from "@/lib/menu-cache";
import { recordAudit } from "@/lib/tenant/audit";
import { type TenantContext, type TenantTransaction, withTenant } from "@/lib/tenant/scope";

/**
 * Menu import from CSV (S-43, spec 02). Owner only, as the menu is (S-26):
 * callers check requireOwner(ctx). Each row goes through the item form's own
 * rules (itemFields, hasAPrice), so prices and limits can't differ from adding
 * one by hand, and lands where adding it by hand would: a new category after
 * the last one, an item at the end of its category. The rows go in with one
 * insert per kind, not one per row (S-43). Nothing is overwritten or deleted: a
 * row naming an item already in that category is skipped.
 */

type Importer = Pick<TenantContext, "restaurantId" | "staffId" | "platformAdminId">;
type Row = ImportValues<"menu">;

const rowItem = itemFields.omit({ categoryId: true }).refine(hasAPrice, noPrice);

/** Names match without regard to case or surrounding space. */
const nameKey = (name: string) => name.trim().toLowerCase();

type Planned = {
  row: Row;
  problems: string[];
  notes: string[];
  /** Set when the row is good to import. */
  item?: {
    category: string;
    name: string;
    description: string;
    priceUsd: string | null;
    priceZig: string | null;
    available: boolean;
  };
};

const unshownPrice = {
  usd_only: "This restaurant shows prices in USD only, so the ZiG price is saved but not shown.",
  zig_only: "This restaurant shows prices in ZiG only, so the USD price is saved but not shown.",
};

/**
 * What each row would do, against the menu as this transaction sees it. The
 * live categories are held with a share lock, as adding one item holds its
 * category, so none is archived under an import.
 */
async function plan(tx: TenantTransaction, restaurantId: string, rows: Row[]) {
  const [{ currencyMode }] = await tx
    .select({ currencyMode: restaurants.currencyMode })
    .from(restaurants)
    .where(eq(restaurants.id, restaurantId));
  const live = await tx
    .select({ id: categories.id, name: categories.name })
    .from(categories)
    .where(and(eq(categories.restaurantId, restaurantId), isNull(categories.archivedAt)))
    .for("share");
  const items = await tx
    .select({ categoryId: menuItems.categoryId, name: menuItems.name })
    .from(menuItems)
    .where(and(eq(menuItems.restaurantId, restaurantId), isNull(menuItems.archivedAt)));

  // The first live category of a name wins, as the editor's list shows it first.
  const categoryByName = new Map<string, { id: string; name: string }>();
  for (const category of live) {
    if (!categoryByName.has(nameKey(category.name))) categoryByName.set(nameKey(category.name), category);
  }
  const existing = new Set(items.map((item) => `${item.categoryId}\u0000${nameKey(item.name)}`));
  const inFile = new Map<string, number>();

  return rows.map((row): Planned => {
    const { values } = row;
    const problems: string[] = [];
    const notes: string[] = [];

    const category = newCategory.safeParse({ name: values.category });
    if (!category.success) problems.push(category.error.issues[0].message);
    const item = rowItem.safeParse({
      name: values.name,
      description: values.description,
      priceUsd: values.priceUsd,
      priceZig: values.priceZig,
    });
    if (!item.success) problems.push(...item.error.issues.map((issue) => issue.message));
    const available = yesNo(values.available, true);
    if (available === null) problems.push('Write yes or no in "available", or leave it blank for yes.');

    if (category.success && item.success) {
      const key = `${nameKey(category.data.name)}\u0000${nameKey(item.data.name)}`;
      const found = categoryByName.get(nameKey(category.data.name));
      if (found && existing.has(`${found.id}\u0000${nameKey(item.data.name)}`)) {
        problems.push(`"${item.data.name}" is already on the menu in ${found.name}.`);
      } else if (inFile.has(key)) {
        problems.push(`"${item.data.name}" is already in this file, on line ${inFile.get(key)}.`);
      } else if (!row.extraCells) {
        inFile.set(key, row.line);
      }
      if (currencyMode === "usd_only" && item.data.priceZig !== null) notes.push(unshownPrice.usd_only);
      if (currencyMode === "zig_only" && item.data.priceUsd !== null) notes.push(unshownPrice.zig_only);
    }

    const ok = problems.length === 0 && !row.extraCells && category.success && item.success;
    return {
      row,
      problems: unique(problems),
      notes,
      item: ok
        ? {
            category: category.data.name,
            name: item.data.name,
            description: item.data.description,
            priceUsd: item.data.priceUsd,
            priceZig: item.data.priceZig,
            available: available!,
          }
        : undefined,
    };
  });
}

const toReport = (planned: Planned[], imported: number | null): ImportReport =>
  reportOf(
    "menu",
    planned.map(({ row, problems, notes }) => reportRow("menu", row, problems, notes)),
    imported,
  );

const read = (csv: string) => readCsvTable(csv, importColumns.menu);

/** What importing would do, row by row. Writes nothing. */
export async function previewMenuImport(
  ctx: Pick<TenantContext, "restaurantId">,
  csv: string,
): Promise<ImportReport | { error: string }> {
  const table = read(csv);
  if (!table.ok) return { error: table.error };
  const planned = await withTenant(ctx, (tx) => plan(tx, ctx.restaurantId, table.rows));
  return toReport(planned, null);
}

/**
 * Adds every valid row in one transaction: the categories it names that don't
 * exist yet (in file order, after the existing ones), then each item at the end
 * of its category. Invalid rows are skipped and reported. Audited once, with
 * the counts, for owners as well as an entered admin (S-43); the single adds
 * it stands for aren't audited one by one.
 */
export async function importMenu(
  ctx: Importer,
  csv: string,
): Promise<ImportReport | { error: string }> {
  const table = read(csv);
  if (!table.ok) return { error: table.error };

  const { restaurantId } = ctx;
  const { planned, imported } = await withTenant(ctx, async (tx) => {
    const planned = await plan(tx, restaurantId, table.rows);
    const ready = planned.flatMap((entry) => (entry.item ? [entry.item] : []));
    if (ready.length === 0) return { planned, imported: 0 };

    const live = await tx
      .select({ id: categories.id, name: categories.name })
      .from(categories)
      .where(and(eq(categories.restaurantId, restaurantId), isNull(categories.archivedAt)));
    const categoryIds = new Map<string, string>();
    for (const category of live) {
      if (!categoryIds.has(nameKey(category.name))) categoryIds.set(nameKey(category.name), category.id);
    }

    // The categories the file names that don't exist yet, in file order, after
    // the last one (archived ones included, as for adding one by hand).
    const newNames = new Map<string, string>();
    for (const { category } of ready) {
      if (!categoryIds.has(nameKey(category)) && !newNames.has(nameKey(category))) {
        newNames.set(nameKey(category), category);
      }
    }
    if (newNames.size > 0) {
      const [{ next }] = await tx
        .select({ next: sql<number>`coalesce(max(${categories.sortOrder}), -1) + 1` })
        .from(categories)
        .where(eq(categories.restaurantId, restaurantId));
      const added = await tx
        .insert(categories)
        .values([...newNames.values()].map((name, i) => ({ restaurantId, name, sortOrder: next + i })))
        .returning({ id: categories.id, name: categories.name });
      for (const category of added) categoryIds.set(nameKey(category.name), category.id);
    }

    // Each item at the end of its category, in file order. A new category
    // starts at 0; an existing one after its last item, archived ones included.
    const existingIds = live.map((category) => category.id);
    const ends = existingIds.length
      ? await tx
          .select({
            categoryId: menuItems.categoryId,
            next: sql<number>`max(${menuItems.sortOrder}) + 1`,
          })
          .from(menuItems)
          .where(and(eq(menuItems.restaurantId, restaurantId), inArray(menuItems.categoryId, existingIds)))
          .groupBy(menuItems.categoryId)
      : [];
    const nextIn = new Map(ends.map((end) => [end.categoryId, end.next]));
    await tx.insert(menuItems).values(
      ready.map(({ category, ...item }) => {
        const categoryId = categoryIds.get(nameKey(category))!;
        const sortOrder = nextIn.get(categoryId) ?? 0;
        nextIn.set(categoryId, sortOrder + 1);
        return { ...item, restaurantId, categoryId, sortOrder };
      }),
    );
    await recordAudit(tx, ctx, {
      action: "menu.import",
      entityType: "restaurant",
      entityId: restaurantId,
      details: {
        items: ready.length,
        categories: newNames.size,
        skipped: planned.length - ready.length,
      },
    });
    return { planned, imported: ready.length };
  });

  if (imported > 0) revalidateMenu(ctx);
  return toReport(planned, imported);
}
