import { describe, expect, it } from "vitest";
import { provisionAppRole } from "./app-role";

const owner = { connectionString: "postgres://app:app@localhost:1/unused" };

describe("provisionAppRole", () => {
  it.each([
    ["another role", "postgres://neondb_owner:secret@host/db"],
    ["no password", "postgres://app_tenant@host/db"],
  ])("refuses a connection URL with %s, before connecting", async (_name, url) => {
    await expect(provisionAppRole(owner, url)).rejects.toThrow(/app_tenant/);
  });

  it("never echoes the password", async () => {
    await expect(
      provisionAppRole(owner, "postgres://neondb_owner:hunter2@host/db"),
    ).rejects.not.toThrow(/hunter2/);
  });
});
