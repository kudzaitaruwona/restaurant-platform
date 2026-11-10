import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { config } from "../../../../../vercel";

/** S-35: one cron entry, every 5 minutes, calling the job's route. */
describe("the scheduled job's schedule (vercel.ts)", () => {
  it("is a single cron, every 5 minutes, on GET /api/cron/tick", () => {
    expect(config.crons).toEqual([{ path: "/api/cron/tick", schedule: "*/5 * * * *" }]);
  });

  it("names a route that exists", () => {
    const [{ path }] = config.crons;
    expect(existsSync(join(process.cwd(), "src/app", path, "route.ts"))).toBe(true);
  });
});
