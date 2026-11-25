import { useSyncExternalStore } from "react";

/**
 * What the booking form remembers once it has booked (#89): when, in this tab, and
 * nothing else. This page runs a third party's script, so the manage token, a bearer
 * secret, is never put in its URL, its storage or its history state.
 */

/** The new booking's own page, which survives a reload and runs no script. */
export const bookedPath = (manageToken: string) => `/b/${encodeURIComponent(manageToken)}?booked=1`;

const key = (action: string) => `booked:${action}`;

// Storage throws where the browser blocks it; isLeftOver does without.
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

/** The browser has shown this page again from its back/forward cache, whole. */
let restored = false;

/** The guest came back to this page, or reloaded it, rather than following a link to it. */
function cameBack() {
  if (restored) return true; // how it first loaded is all the browser says then
  const [arrival] = performance.getEntriesByType("navigation") as PerformanceNavigationTiming[];
  return arrival?.type === "back_forward" || arrival?.type === "reload";
}

/**
 * True for a form the guest went back to, or reloaded, after booking: one loaded
 * before the booking (the browser kept the page whole), or brought back from history.
 * A form reached by a link afterwards is a new booking, and live. Where storage is
 * blocked the tab's history says it instead: the booking is ahead of this page (#134).
 */
export function isLeftOver(action: string) {
  let at: string | null;
  try {
    at = sessionStorage.getItem(key(action));
  } catch {
    return cameBack() && bookingAhead() !== undefined;
  }
  if (at === null) return false;
  return Number(at) >= performance.timeOrigin || cameBack();
}

export function subscribe(changed: () => void) {
  const shown = (event: PageTransitionEvent) => {
    if (event.persisted) restored = true; // Back to a page the browser kept
    changed();
  };
  window.addEventListener("pageshow", shown);
  return () => window.removeEventListener("pageshow", shown);
}

export const useLeftOver = (action: string) =>
  useSyncExternalStore(subscribe, () => isLeftOver(action), () => false);

/** The part of the Navigation API this page uses. Entries are this site's own, in order. */
type HistoryEntry = { index: number; key: string; url: string | null };
type Navigation = {
  entries: () => HistoryEntry[];
  currentEntry: HistoryEntry | null;
  traverseTo: (key: string) => unknown;
};
const navigation = () => (window as { navigation?: Navigation }).navigation;

/** A manage page. Its address is hidden from here by its Referrer-Policy; no other page's is. */
const isManagePage = ({ url }: HistoryEntry) => !url || /^https?:\/\/[^/]+\/b\//.test(url);

/**
 * The nearest manage page ahead of this one in the tab (#134): not merely the next
 * page, which may be another form. Undefined when there is none, or the browser
 * can't say (no Navigation API).
 */
export function bookingAhead() {
  const history = navigation();
  const here = history?.currentEntry?.index;
  if (history === undefined || here === undefined) return undefined;
  return history.entries().find((entry) => entry.index > here && isManagePage(entry))?.key;
}

export const useBookingAhead = () => useSyncExternalStore(subscribe, bookingAhead, () => undefined);

export const goToBooking = (key: string) => navigation()?.traverseTo(key);
