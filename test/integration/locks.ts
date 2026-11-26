import { inspect } from "node:util";
import { onTestFinished } from "vitest";

/**
 * Polls `check` until it passes, for as long as every action in `waiting` is still
 * pending: the way to wait for an action to reach a lock another connection holds.
 * An action that settles first can't be the one waiting, so that fails at once, with
 * what it returned or threw.
 *
 * No time limit of its own, unlike a `vi.waitFor` of a few seconds: reaching the
 * lock may first take a new connection, and on a loaded machine that alone took
 * longer than 5 seconds. A waiter that never comes is the test's own timeout. Polling
 * stops when the test ends, so a timed-out test doesn't leave it running.
 */
export async function whileWaiting<T>(waiting: Promise<unknown>[], check: () => Promise<T>): Promise<T> {
  let settled: { value: unknown } | { error: unknown } | undefined;
  for (const action of waiting) {
    action.then(
      (value) => (settled ??= { value }),
      (error: unknown) => (settled ??= { error }),
    );
  }
  let finished = false;
  onTestFinished(() => {
    finished = true;
  });
  let failure: unknown;
  while (!finished) {
    if (settled) {
      throw new Error(`An action expected to wait on a lock finished first: ${inspect(settled)}`, {
        cause: failure,
      });
    }
    try {
      return await check();
    } catch (error) {
      failure = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("The test ended while waiting", { cause: failure });
}
