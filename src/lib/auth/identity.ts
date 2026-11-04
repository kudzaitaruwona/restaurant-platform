import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { getAdminDb } from "@/db/admin";

/**
 * Who an email belongs to, before any tenant is known. RLS hides `staff` here,
 * so these go through the SECURITY DEFINER functions in the migration (S-30),
 * which refuse deactivated staff and platform_admin shadow rows themselves. Who
 * the platform admins are is for the admin login alone (S-28).
 */
export type StaffIdentity = {
  restaurantId: string;
  staffId: string;
  role: "owner" | "staff";
};

export async function findStaffIdentity(
  email: string,
): Promise<StaffIdentity | undefined> {
  const { rows } = await getDb().execute<{
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
