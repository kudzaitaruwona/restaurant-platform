import "server-only";
import { getAdminDb } from "@/db/admin";
import { getStaffAuthDb } from "@/db/staff-auth";
import type { Audience } from "./index";

/**
 * Each session type's tables, through the login that may reach them (S-28,
 * S-30): staff sign-in's or the admin's, never app_tenant. Either one is a way
 * round a boundary, so ESLint keeps this to src/lib/auth.
 */
export const authDatabase = (audience: Audience) =>
  audience === "admin" ? getAdminDb() : getStaffAuthDb();
