import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Connection, POLL_EVERY_MS, startPolling } from "./kitchen-poll";

const answer = (cursor: string, items: unknown[] = []) =>
  new Response(JSON.stringify({ cursor, now: new Date().toISOString(), items }), { status: 200 });

/** A poller on fake timers, with every request it made and every state it reported. */
function polling(respond: (url: string, signal: AbortSignal) => Promise<Response>) {
  const urls: string[] = [];
  const connection: Connection[] = [];
  const changes: unknown[] = [];
  const poller = startPolling({
    cursor: "100",
    fetch: (url, signal) => {
      urls.push(url);
      return respond(url, signal);
    },
    onChanges: (body) => changes.push(body),
    onConnection: (state) => connection.push(state),
  });
  return { poller, urls, connection, changes };
}

/** A request that never answers, until it's aborted. */
const hanging = (_url: string, signal: AbortSignal) =>
  new Promise<Response>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted")));
  });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("the kitchen's poll", () => {
  it("asks every 5 seconds, from the cursor the last answer gave", async () => {
    let next = 100;
    const { poller, urls, changes } = polling(async () => answer(String(++next)));

    expect(POLL_EVERY_MS).toBe(5_000);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(urls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(urls).toEqual(["/api/kitchen/changes?since=100", "/api/kitchen/changes?since=101"]);
    expect(changes).toHaveLength(2);
    poller.stop();
  });

  it("reports offline within 15 seconds of the network going, and recovers with no reload", async () => {
    let up = false;
    const { poller, connection, urls } = polling((url, signal) =>
      up ? Promise.resolve(answer("200")) : hanging(url, signal),
    );

    await vi.advanceTimersByTimeAsync(15_000);
    expect(connection).toContain("offline");

    up = true;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(connection.at(-1)).toBe("online");
    // The cursor survived the outage: nothing in it was skipped.
    expect(urls.filter((url) => url.endsWith("since=100")).length).toBeGreaterThan(1);
    poller.stop();
  });

  it("counts a refused answer as a failed poll, and a 401 as signed out", async () => {
    let status = 500;
    const { poller, connection } = polling(async () => new Response("{}", { status }));

    await vi.advanceTimersByTimeAsync(5_000);
    expect(connection.at(-1)).toBe("offline");
    status = 401;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(connection.at(-1)).toBe("signed_out");
    poller.stop();
  });

  it("polls at once when asked to refresh, and never two at a time", async () => {
    let inFlight = 0;
    let most = 0;
    const { poller, urls } = polling(async () => {
      most = Math.max(most, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 100));
      inFlight--;
      return answer("101");
    });

    poller.refresh();
    poller.refresh();
    await vi.advanceTimersByTimeAsync(300);

    expect(urls.length).toBe(2);
    expect(most).toBe(1);
    poller.stop();
  });

  it("stops asking once stopped", async () => {
    const { poller, urls } = polling(async () => answer("101"));
    poller.stop();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(urls).toEqual([]);
  });
});
