"use client";

import type { ReactNode } from "react";
import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { TOP_BAR_ACTION_ID } from "./staff-rail";

/** The bar streams in with the layout, maybe after the page, so watch for it. */
function subscribe(changed: () => void) {
  const observer = new MutationObserver(changed);
  observer.observe(document.body, { childList: true, subtree: true });
  return () => observer.disconnect();
}

/**
 * Puts a page's primary action in the phone top bar (S-41), usually one
 * IconButton: `<StaffTopBarAction><IconButton label="Add booking" ... /></StaffTopBarAction>`.
 * The bar shows only below 768px, so keep the same action in the page header
 * too and hide that one on phones (`hidden md:inline-flex`).
 */
export function StaffTopBarAction({ children }: { children: ReactNode }) {
  const target = useSyncExternalStore(
    subscribe,
    () => document.getElementById(TOP_BAR_ACTION_ID),
    () => null,
  );
  return target ? createPortal(children, target) : null;
}
