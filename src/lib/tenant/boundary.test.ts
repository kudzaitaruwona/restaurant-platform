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
