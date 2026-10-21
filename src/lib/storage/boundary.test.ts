import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

// "uploadImage, deleteImage and getUrl are the only way app code touches
// storage": enforced by lint, which CI runs on every push.
async function lintRuleIds(code: string, filePath: string) {
  const [result] = await new ESLint().lintText(code, { filePath });
  return result.messages.map((message) => message.ruleId);
}

describe("storage boundary", () => {
  it.each([
    `import { S3Client } from "@aws-sdk/client-s3";`,
    `import { createImageStorage } from "@/lib/storage/storage";`,
  ])("app code may not reach past @/lib/storage: %s", async (code) => {
    expect(await lintRuleIds(code, "src/app/menu/actions.ts")).toContain(
      "no-restricted-imports",
    );
  }, 30_000);

  it("app code may import the storage interface", async () => {
    expect(
      await lintRuleIds(
        `import { uploadImage } from "@/lib/storage";\nexport { uploadImage };`,
        "src/app/menu/actions.ts",
      ),
    ).not.toContain("no-restricted-imports");
  }, 30_000);

  it("the storage module itself may use the S3 SDK", async () => {
    expect(
      await lintRuleIds(
        `import { S3Client } from "@aws-sdk/client-s3";\nexport { S3Client };`,
        "src/lib/storage/index.ts",
      ),
    ).not.toContain("no-restricted-imports");
  }, 30_000);
});
