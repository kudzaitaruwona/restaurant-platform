import "server-only";
import { sql } from "drizzle-orm";
import { getAdminDb } from "@/db/admin";
import { getStaffAuthDb } from "@/db/staff-auth";

/**
 * Who an email belongs to, before any tenant is known. RLS hides `staff` here,
 * so these go through the SECURITY DEFINER functions in the migration (S-30),
 * which refuse deactivated staff and platform_admin shadow rows themselves.
 * Each is for its own audience's login alone: who the staff are for staff
 * sign-in's, and who the platform admins are for the admin's (S-28). Both run on
 * every signed-in request, on the login that has just read the session.
 */
export type StaffIdentity = {
  restaurantId: string;
  staffId: string;
  role: "owner" | "staff";
};

export async function findStaffIdentity(
  email: string,
): Promise<StaffIdentity | undefined> {
  const { rows } = await getStaffAuthDb().execute<{
    restaurant_id: string;
    staff_id: string;
    role: StaffIdentity["role"];
  }>(sql`select * from staff_identity_by_email(${email})`);
  const [row] = rows;
  return (
    row && {
      restaurantId: row.restaurant_id,
      staffId: row.staff_id,
      role: row.role,
    }
  );
}

export async function findPlatformAdminId(
  email: string,
): Promise<string | undefined> {
  const { rows } = await getAdminDb().execute<{ id: string | null }>(
    sql`select platform_admin_id_by_email(${email}) as id`,
  );
  return rows[0].id ?? undefined;
}

/**
 * Marks a staff member as joined on their first sign-in (S-42). Only the first
 * one counts: the function leaves a time already there alone. Only sign-in's
 * login may run it, and only the table's owner can write the column otherwise.
 */
export async function recordFirstSignIn(email: string) {
  await getStaffAuthDb().execute(sql`select staff_record_first_sign_in(${email})`);
}
