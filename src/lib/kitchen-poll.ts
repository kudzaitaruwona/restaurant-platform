import type { BoardItem } from "./kitchen-board";

/**
 * The kitchen board's live updates (spec 07, proposed): a poll every 5 seconds
 * for the changes since the last one. Polling rather than WebSockets suits
 * Vercel's serverless runtime and flaky restaurant Wi-Fi. A poll that fails or
 * takes longer than 4 seconds says so at once, so the "Offline — reconnecting"
 * bar is up within 9 seconds of the network going (well inside spec 07's 15),
 * and the next poll that answers takes it down again. The cursor only moves on an
 * answer, so an outage skips nothing.
 */
export const POLL_EVERY_MS = 5_000;
const GIVE_UP_AFTER_MS = 4_000;

export type Connection = "online" | "offline" | "signed_out";
export type Changes = { cursor: string; now: string; items: BoardItem[] };

export function startPolling(options: {
  cursor: string;
  fetch: (url: string, signal: AbortSignal) => Promise<Response>;
  onChanges: (changes: Changes) => void;
  onConnection: (state: Connection) => void;
}) {
  let cursor = options.cursor;
  let stopped = false;
  let inFlight = false;
  let again = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedule = () => {
    clearTimeout(timer);
    if (!stopped) timer = setTimeout(poll, POLL_EVERY_MS);
  };

  async function poll() {
    if (stopped) return;
    if (inFlight) {
      again = true;
      return;
    }
    inFlight = true;
    clearTimeout(timer);
    const controller = new AbortController();
    const giveUp = setTimeout(() => controller.abort(), GIVE_UP_AFTER_MS);
    try {
      const response = await options.fetch(
        `/api/kitchen/changes?since=${encodeURIComponent(cursor)}`,
        controller.signal,
      );
      if (response.status === 401) {
        options.onConnection("signed_out");
      } else if (!response.ok) {
        options.onConnection("offline");
      } else {
        const changes = (await response.json()) as Changes;
        if (stopped) return;
        cursor = changes.cursor;
        options.onChanges(changes);
        options.onConnection("online");
      }
    } catch {
      if (!stopped) options.onConnection("offline");
    } finally {
      clearTimeout(giveUp);
      inFlight = false;
      if (again) {
        again = false;
        void poll();
      } else {
        schedule();
      }
    }
  }

  schedule();
  return {
    /** Poll now, as after a move another tablet beat this one to. */
    refresh: () => void poll(),
    stop: () => {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
