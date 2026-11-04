import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { envKeys } from "./env";

const exampleKeys = readFileSync(join(process.cwd(), ".env.example"), "utf8")
  .split("\n")
  .map((line) => line.match(/^([A-Z0-9_]+)=/)?.[1])
  .filter((key): key is string => key !== undefined);

describe(".env.example", () => {
  it("lists every variable the env schema knows about", () => {
    const missing = envKeys.filter((key) => !exampleKeys.includes(key));
    expect(missing).toEqual([]);
  });

  it("lists nothing the env schema doesn't validate, apart from test-only variables", () => {
    const testOnly = ["TEST_DATABASE_URL"];
    const unknown = exampleKeys.filter(
      (key) => !(envKeys as string[]).includes(key) && !testOnly.includes(key),
    );
    expect(unknown).toEqual([]);
  });
});
