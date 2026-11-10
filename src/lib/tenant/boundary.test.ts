import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

// S-25: the tenant seam is the only way app code reaches the database. Enforced
// by lint, which CI runs on every push.
async function restrictedImports(code: string, filePath: string) {
  const [result] = await new ESLint().lintText(code, { filePath });
  return result.messages.filter(
    (message) => message.ruleId === "no-restricted-imports",
  );
}

describe("database boundary", () => {
  it.each([
    `import { getDb } from "@/db";`,
    `import { getDb } from "@/db/index";`,
    `import { getDb } from "../../db";`,
    `import { createDatabase } from "@/db/client";`,
    `import { createDatabase } from "../db/client";`,
    `import { Pool } from "@neondatabase/serverless";`,
    `import { drizzle } from "drizzle-orm/neon-serverless";`,
  ])("app code may not reach past the seam: %s", async (code) => {
    expect(await restrictedImports(code, "src/app/menu/actions.ts")).not.toEqual(
      [],
    );
  }, 30_000);

  it("app code may use the seam and the table definitions", async () => {
    expect(
      await restrictedImports(
        `import { withTenant } from "@/lib/tenant";
import { staff } from "@/db/schema";
export { withTenant, staff };`,
        "src/app/menu/actions.ts",
      ),
    ).toEqual([]);
  }, 30_000);

  it("the seam itself may use getDb", async () => {
    expect(
      await restrictedImports(
        `import { getDb } from "@/db";\nexport { getDb };`,
        "src/lib/tenant/index.ts",
      ),
    ).toEqual([]);
  }, 30_000);

  it.each(["src/app/admin/page.tsx", "src/lib/staff-management.ts"])(
    "the admin login is out of reach of %s, like every other handle",
    async (filePath) => {
      expect(
        await restrictedImports(
          `import { getAdminDb } from "@/db/admin";\nexport { getAdminDb };`,
          filePath,
        ),
      ).not.toEqual([]);
    },
    30_000,
  );

  it("the tenant seam itself can't open the admin login", async () => {
    expect(
      await restrictedImports(
        `import { getAdminDb } from "@/db/admin";\nexport { getAdminDb };`,
        "src/lib/tenant/index.ts",
      ),
    ).not.toEqual([]);
  }, 30_000);

  it.each([
    "src/lib/tenant/platform-admin.ts",
    "src/lib/tenant/admin-entry.ts",
    "src/lib/auth/identity.ts",
    "src/lib/auth/database.ts",
  ])("the admin seam may open it: %s", async (filePath) => {
    expect(
      await restrictedImports(
        `import { getAdminDb } from "@/db/admin";\nexport { getAdminDb };`,
        filePath,
      ),
    ).toEqual([]);
  }, 30_000);

  // Staff sign-in's login (S-28, S-30) can write a working magic link for anyone.
  const staffAuthImports = [
    `import { getStaffAuthDb } from "@/db/staff-auth";\nexport { getStaffAuthDb };`,
    `import { getStaffAuthDb } from "../../db/staff-auth";\nexport { getStaffAuthDb };`,
  ];

  it.each(
    [
      "src/app/login/page.tsx",
      "src/lib/staff-management.ts",
      "src/lib/storage/index.ts",
      "src/lib/tenant/index.ts",
      "src/lib/tenant/platform-admin.ts",
      "src/lib/tenant/admin-entry.ts",
      "src/lib/auth/index.ts",
      "src/lib/auth/code-limit.ts",
    ].flatMap((filePath) => staffAuthImports.map((code) => [filePath, code])),
  )("staff sign-in's login is out of reach of %s: %s", async (filePath, code) => {
    expect(await restrictedImports(code, filePath)).not.toEqual([]);
  }, 30_000);

  it.each(["src/lib/auth/database.ts", "src/lib/auth/identity.ts"])(
    "sign-in's own handles may open it: %s",
    async (filePath) => {
      expect(await restrictedImports(staffAuthImports[0], filePath)).toEqual([]);
    },
    30_000,
  );

  // authDatabase() hands back the admin login or staff sign-in's, so it's a way
  // round both of the boundaries above.
  const authDatabaseImports = [
    `import { authDatabase } from "@/lib/auth/database";\nexport { authDatabase };`,
    `import { authDatabase } from "../auth/database";\nexport { authDatabase };`,
  ];

  it.each(
    [
      "src/app/admin/page.tsx",
      "src/lib/staff-management.ts",
      "src/lib/storage/index.ts",
      "src/lib/tenant/index.ts",
      "src/lib/tenant/platform-admin.ts",
      "src/db/seed.ts",
    ].flatMap((filePath) => authDatabaseImports.map((code) => [filePath, code])),
  )("sign-in's database is out of reach of %s: %s", async (filePath, code) => {
    expect(await restrictedImports(code, filePath)).not.toEqual([]);
  }, 30_000);

  it.each(["src/lib/auth/index.ts", "src/lib/auth/code-limit.ts"])(
    "sign-in may use its own database: %s",
    async (filePath) => {
      expect(
        await restrictedImports(
          `import { authDatabase } from "./database";\nexport { authDatabase };`,
          filePath,
        ),
      ).toEqual([]);
    },
    30_000,
  );

  it("sign-in's own files keep the rest of their boundaries", async () => {
    const code = `import { getAdminDb } from "@/db/admin";\nexport { getAdminDb };`;
    expect(await restrictedImports(code, "src/lib/auth/code-limit.ts")).not.toEqual([]);
    expect(await restrictedImports(code, "src/lib/auth/identity.ts")).toEqual([]);
  }, 30_000);

  // The system login (spec 01, S-35) bypasses RLS for every tenant, so only the
  // scheduled job's route and the Meta webhook's (#48) open it.
  const systemImports = [
    `import { getSystemDb } from "@/db/system";\nexport { getSystemDb };`,
    `import { getSystemDb } from "../../db/system";\nexport { getSystemDb };`,
  ];

  it.each(
    [
      "src/app/api/bookings/route.ts",
      "src/app/api/cron/other/route.ts",
      "src/app/dashboard/page.tsx",
      "src/lib/cron/tick.ts",
      "src/lib/cron/booking-status.ts",
      "src/lib/booking-day.ts",
      "src/lib/whatsapp/delivery-status.ts",
      "src/lib/whatsapp/sender.ts",
      "src/app/api/webhooks/other/route.ts",
      "src/lib/storage/index.ts",
      "src/lib/tenant/index.ts",
      "src/lib/tenant/platform-admin.ts",
      "src/lib/auth/database.ts",
      "src/lib/auth/identity.ts",
      "src/lib/auth/code-limit.ts",
    ].flatMap((filePath) => systemImports.map((code) => [filePath, code])),
  )("the system login is out of reach of %s: %s", async (filePath, code) => {
    expect(await restrictedImports(code, filePath)).not.toEqual([]);
  }, 30_000);

  it("the scheduled job's route may open it", async () => {
    expect(await restrictedImports(systemImports[0], "src/app/api/cron/tick/route.ts")).toEqual([]);
  }, 30_000);

  it("the Meta webhook's route may open it, and nothing else but the system login", async () => {
    const webhook = "src/app/api/webhooks/whatsapp/route.ts";
    expect(await restrictedImports(systemImports[0], webhook)).toEqual([]);
    for (const code of [
      `import { getDb } from "@/db";\nexport { getDb };`,
      `import { getAdminDb } from "@/db/admin";\nexport { getAdminDb };`,
      staffAuthImports[0],
      authDatabaseImports[0],
    ]) {
      expect(await restrictedImports(code, webhook)).not.toEqual([]);
    }
  }, 30_000);

  it("the webhook's status write takes the database it is handed, and opens no login of its own", async () => {
    const file = "src/lib/whatsapp/delivery-status.ts";
    for (const code of [`import { getDb } from "@/db";\nexport { getDb };`, staffAuthImports[0]]) {
      expect(await restrictedImports(code, file)).not.toEqual([]);
    }
    expect(
      await restrictedImports(`import type { Database } from "@/db/client";\nexport type { Database };`, file),
    ).toEqual([]);
  }, 30_000);

  it.each([
    `import { getDb } from "@/db";\nexport { getDb };`,
    `import { getAdminDb } from "@/db/admin";\nexport { getAdminDb };`,
    staffAuthImports[0],
    authDatabaseImports[0],
    `import { S3Client } from "@aws-sdk/client-s3";\nexport { S3Client };`,
  ])("the scheduled job's route keeps every other boundary: %s", async (code) => {
    expect(await restrictedImports(code, "src/app/api/cron/tick/route.ts")).not.toEqual([]);
  }, 30_000);

  it("the job's tasks take the database they are handed, and open no login of their own", async () => {
    for (const code of [
      `import { getDb } from "@/db";\nexport { getDb };`,
      `import { getAdminDb } from "@/db/admin";\nexport { getAdminDb };`,
      staffAuthImports[0],
    ]) {
      expect(await restrictedImports(code, "src/lib/cron/booking-status.ts")).not.toEqual([]);
    }
    expect(
      await restrictedImports(
        `import type { Database } from "@/db/client";\nexport type { Database };`,
        "src/lib/cron/booking-status.ts",
      ),
    ).toEqual([]);
  }, 30_000);

  it("adding this boundary keeps the storage one: both apply to app code", async () => {
    const messages = await restrictedImports(
      `import { getDb } from "@/db";
import { S3Client } from "@aws-sdk/client-s3";
export { getDb, S3Client };`,
      "src/app/menu/actions.ts",
    );
    expect(messages).toHaveLength(2);
  }, 30_000);

  it("the storage module is still kept out of the database", async () => {
    expect(
      await restrictedImports(
        `import { getDb } from "@/db";\nexport { getDb };`,
        "src/lib/storage/index.ts",
      ),
    ).toHaveLength(1);
  }, 30_000);

  it("the seam is still kept out of the S3 SDK", async () => {
    expect(
      await restrictedImports(
        `import { S3Client } from "@aws-sdk/client-s3";\nexport { S3Client };`,
        "src/lib/tenant/index.ts",
      ),
    ).toHaveLength(1);
  }, 30_000);
});
