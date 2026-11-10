import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/db/client";
import { runTick, tickTasks } from "./tick";

const db = {} as Database;
const NOW = new Date("2026-11-10T18:00:00Z");
afterEach(() => vi.restoreAllMocks());

describe("runTick", () => {
  it("runs spec 04's status rules first, then spec 05's outbox, then D-06's phone purge, then S-30's pruning, in that order", () => {
    expect(tickTasks.map(({ name }) => name)).toEqual([
      "noShows",
      "completed",
      "notifications",
      "phonesPurged",
      "codeLimitsPruned",
    ]);
  });

  it("runs every task, in order, with the one database and the one moment, and reports what each did", async () => {
    const calls: string[] = [];
    const task = (name: string, count: number) => ({
      name,
      run: vi.fn(async (given: Database, now: Date) => {
        expect(given).toBe(db);
        expect(now).toBe(NOW);
        calls.push(name);
        return count;
      }),
    });

    const result = await runTick(db, NOW, [task("first", 2), task("second", 0)]);

    expect(calls).toEqual(["first", "second"]);
    expect(result).toEqual({ ok: true, tasks: { first: 2, second: 0 } });
  });

  it("still runs the tasks after one that fails, and says which failed, by code only", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = Object.assign(new Error("update bookings ... params: Jane, +263771234567"), {
      cause: { code: "40P01" },
    });
    const after = vi.fn(async () => 1);

    const result = await runTick(db, NOW, [
      { name: "broken", run: async () => Promise.reject(failure) },
      { name: "after", run: after },
    ]);

    expect(after).toHaveBeenCalled();
    expect(result).toEqual({ ok: false, tasks: { broken: "failed", after: 1 } });
    const logged = inspect(error.mock.calls, { depth: null });
    expect(logged).toContain("broken");
    expect(logged).toContain("40P01");
    expect(logged).not.toContain("+263771234567");
    expect(logged).not.toContain("Jane");
  });
});
