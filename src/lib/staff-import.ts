import "server-only";
import { readCsvTable } from "@/lib/csv";
import {
  type ImportReport,
  type ImportValues,
  importColumns,
  reportOf,
  reportRow,
} from "@/lib/csv-import";
import { addStaff, listStaff, type NewStaff, parseNewStaff } from "@/lib/staff-management";
import type { Acting } from "@/lib/tenant/audit";

/**
 * Staff import from CSV (S-42, S-43, spec 01). Owner only, as staff management
 * is (S-26): callers check requireOwner(ctx). Each row goes through the staff
 * form's own parser and then addStaff, unchanged, one person at a time: so each
 * person is created, audited (staff.create) and invited exactly as when added
 * by hand (S-42). That is why this import, unlike the menu's and the tables',
 * isn't one transaction: a person added is added, whatever the next row does.
 */

type Row = ImportValues<"staff">;
type Planned = { row: Row; problems: string[]; person?: NewStaff };

const messages = {
  ownerFirst:
    "This restaurant has no owner yet, so add its owner first: put an owner row above this one.",
  // The single form's words (POST /api/staff): emails are unique across restaurants.
  emailTaken: "That email can't be added: it already has a staff login.",
};

async function plan(ctx: Acting, rows: Row[]) {
  const team = await listStaff(ctx);
  const onStaff = new Set(team.flatMap((member) => (member.email ? [member.email.toLowerCase()] : [])));
  let hasOwner = team.some((member) => member.active && member.role === "owner");
  const inFile = new Map<string, number>();

  return rows.map((row): Planned => {
    const form = new FormData();
    form.set("email", row.values.email);
    form.set("displayName", row.values.name);
    form.set("role", row.values.role.toLowerCase() || "staff");
    const person = parseNewStaff(form);
    if (!person.success) return { row, problems: [person.message] };

    const { email, role } = person.data;
    const problems: string[] = [];
    if (onStaff.has(email)) problems.push(`${email} is already on your staff.`);
    else if (inFile.has(email)) problems.push(`${email} is already in this file, on line ${inFile.get(email)}.`);
    else if (role !== "owner" && !hasOwner) problems.push(messages.ownerFirst);
    if (problems.length > 0 || row.extraCells) return { row, problems };

    inFile.set(email, row.line);
    if (role === "owner") hasOwner = true;
    return { row, problems, person: person.data };
  });
}

const toReport = (planned: Planned[], imported: number | null): ImportReport =>
  reportOf(
    "staff",
    planned.map(({ row, problems }) => reportRow("staff", row, problems)),
    imported,
  );

const read = (csv: string) => readCsvTable(csv, importColumns.staff);

/**
 * What importing would do, row by row. Writes nothing. An email another
 * restaurant has can't be seen from here (RLS), so that shows only on import.
 */
export async function previewStaffImport(
  ctx: Acting,
  csv: string,
): Promise<ImportReport | { error: string }> {
  const table = read(csv);
  if (!table.ok) return { error: table.error };
  return toReport(await plan(ctx, table.rows), null);
}

/** Adds each valid person in file order, through addStaff. */
export async function importStaff(
  ctx: Acting,
  csv: string,
): Promise<ImportReport | { error: string }> {
  const table = read(csv);
  if (!table.ok) return { error: table.error };

  const planned = await plan(ctx, table.rows);
  let imported = 0;
  for (const entry of planned) {
    if (!entry.person) continue;
    const result = await addStaff(ctx, entry.person);
    if (result === "added") imported++;
    else entry.problems.push(result === "email_taken" ? messages.emailTaken : messages.ownerFirst);
  }
  return toReport(planned, imported);
}
