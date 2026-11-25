import { useSyncExternalStore } from "react";

/**
 * What the booking form remembers once it has booked (#89): when, in this tab, and
 * nothing else. This page runs a third party's script, so the manage token, a bearer
 * secret, is never put in its URL, its storage or its history state.
 */

/** The new booking's own page, which survives a reload and runs no script. */
export const bookedPath = (manageToken: string) => `/b/${encodeURIComponent(manageToken)}?booked=1`;

const key = (action: string) => `booked:${action}`;

// Storage throws where the browser blocks it. Then the form is merely not guarded.
export function rememberBooked(action: string) {
  try {
    sessionStorage.setItem(key(action), String(Date.now()));
  } catch {}
}

export function forgetBooked(action: string) {
  try {
    sessionStorage.removeItem(key(action));
  } catch {}
}

/**
 * True for a form the guest went back to, or reloaded, after booking: one loaded
 * before the booking (the browser kept the page whole), or brought back from history.
 * A form reached by a link afterwards is a new booking, and live.
 */
export function isLeftOver(action: string) {
  try {
    const at = sessionStorage.getItem(key(action));
    if (at === null) return false;
    const [arrival] = performance.getEntriesByType("navigation") as PerformanceNavigationTiming[];
    return (
      Number(at) >= performance.timeOrigin ||
      arrival?.type === "back_forward" ||
      arrival?.type === "reload"
    );
  } catch {
    return false;
  }
}

function subscribe(changed: () => void) {
  window.addEventListener("pageshow", changed); // Back to a page the browser kept
  return () => window.removeEventListener("pageshow", changed);
}

export const useLeftOver = (action: string) =>
  useSyncExternalStore(subscribe, () => isLeftOver(action), () => false);

const noSubscription = () => () => {};
/** Whether Forward leads anywhere, where the browser says; otherwise assume so. */
export const useCanGoForward = () =>
  useSyncExternalStore(
    noSubscription,
    () => (window as { navigation?: { canGoForward: boolean } }).navigation?.canGoForward ?? true,
    () => false,
  );
