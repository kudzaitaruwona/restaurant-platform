import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The scheduled job's route (S-35), with the job itself stood in for: the real
 * one works across every restaurant in the database, and other test files are
 * using it. What the job does is proved in src/lib/cron/*.int.test.ts; this
 * proves who gets to start it, and that a refused call never opens the login.
 */
const SECRET = "a-cron-secret-of-at-least-32-characters";
let cronSecret: string | undefined;
const systemDb = { system: true };

vi.mock("@/lib/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/env")>()),
  getEnv: () => ({ CRON_SECRET: cronSecret }),
}));
const getSystemDb = vi.fn(() => systemDb);
vi.mock("@/db/system", () => ({ getSystemDb }));
const runTick = vi.fn();
vi.mock("@/lib/cron/tick", () => ({ runTick }));

const route = await import("./route");

const call = (headers: Record<string, string> = {}, url = "http://localhost/api/cron/tick") =>
  route.GET(new Request(url, { headers }));

beforeEach(() => {
  cronSecret = SECRET;
  getSystemDb.mockClear();
  runTick.mockReset().mockResolvedValue({ ok: true, tasks: { noShows: 1 } });
});

describe("GET /api/cron/tick", () => {
  it("runs the job on the system login when Vercel's bearer token is right", async () => {
    const response = await call({ authorization: `Bearer ${SECRET}` });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, tasks: { noShows: 1 } });
    expect(runTick).toHaveBeenCalledTimes(1);
    expect(runTick).toHaveBeenCalledWith(systemDb, expect.any(Date));
  });

  it.each([
    ["no Authorization header", {}],
    ["the wrong secret", { authorization: "Bearer not-the-secret-not-the-secret-not" }],
    ["the secret without the scheme", { authorization: SECRET }],
  ])("refuses %s with a 401, without opening the system login", async (_name, headers) => {
    const response = await call(headers);
    expect(response.status).toBe(401);
    expect(getSystemDb).not.toHaveBeenCalled();
    expect(runTick).not.toHaveBeenCalled();
  });

  it.each([
    ["unset", undefined],
    ["shorter than 32 characters", "x".repeat(31)],
  ])("refuses every call when CRON_SECRET is %s", async (_name, secret) => {
    cronSecret = secret;
    const response = await call({ authorization: `Bearer ${secret ?? ""}` });
    expect(response.status).toBe(401);
    expect(runTick).not.toHaveBeenCalled();
  });

  it("takes no input: the query string can't choose what runs or for whom", async () => {
    await call(
      { authorization: `Bearer ${SECRET}` },
      "http://localhost/api/cron/tick?restaurant_id=00000000-0000-0000-0000-000000000000&task=noShows",
    );
    expect(runTick).toHaveBeenCalledWith(systemDb, expect.any(Date));
    expect(runTick.mock.calls[0]).toHaveLength(2);
  });

  it("answers 500 when a task failed, so the run shows as failed in Vercel", async () => {
    runTick.mockResolvedValue({ ok: false, tasks: { noShows: "failed", completed: 0 } });
    const response = await call({ authorization: `Bearer ${SECRET}` });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, tasks: { noShows: "failed", completed: 0 } });
  });

  it("is GET only", () => {
    expect(Object.keys(route).filter((key) => /^[A-Z]+$/.test(key))).toEqual(["GET"]);
  });
});
