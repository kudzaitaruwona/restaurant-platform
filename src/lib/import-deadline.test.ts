import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IMPORT_TIME_BUDGET_MS, deadlineIn } from "./import-deadline";

describe("deadlineIn", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("is not out of time before the budget, and is from then on", () => {
    const outOfTime = deadlineIn(IMPORT_TIME_BUDGET_MS);
    expect(outOfTime()).toBe(false);
    vi.advanceTimersByTime(IMPORT_TIME_BUDGET_MS - 1);
    expect(outOfTime()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(outOfTime()).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(outOfTime()).toBe(true);
  });

  it("measures from when it was made", () => {
    vi.advanceTimersByTime(10_000);
    const outOfTime = deadlineIn(5_000);
    vi.advanceTimersByTime(4_999);
    expect(outOfTime()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(outOfTime()).toBe(true);
  });
});
