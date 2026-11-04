import "server-only";
import { getDb } from "@/db";
import { getAdminDb } from "@/db/admin";
import type { Audience } from "./index";

/**
 * Each session type's tables, through the login that may reach them (S-28). This
 * is the admin login or the raw one, so ESLint keeps it to src/lib/auth.
 */
export const authDatabase = (audience: Audience) =>
  audience === "admin" ? getAdminDb() : getDb();
