import { inspect } from "node:util";
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

  it.each([
    ["another role", "postgres://neondb_owner:hunter2@host/db"],
    ["a malformed URL", "postgres://app_tenant:hunter2@host:port/db"],
  ])("leaves the password out of the refusal for %s", async (_name, url) => {
    const error = await provisionAppRole(owner, url).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(Error);
    expect(inspect(error, { depth: null })).not.toContain("hunter2");
  });
});
