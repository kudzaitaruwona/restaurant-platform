import { Client } from "@neondatabase/serverless";
import { vi } from "vitest";

/**
 * How many statements `run` sends to Postgres, over any connection in this
 * process. For holding a read to a constant number of queries however many rows it
 * returns. It lives here because app code mustn't reach the driver.
 */
export async function countQueries(run: () => Promise<unknown>) {
  const spy = vi.spyOn(Client.prototype, "query");
  try {
    await run();
    return spy.mock.calls.length;
  } finally {
    spy.mockRestore();
  }
}
