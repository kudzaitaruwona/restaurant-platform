"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  type ReactNode,
  Suspense,
  createContext,
  startTransition,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { Notice } from "@/components/ui/notice";
import { type Saved, refreshQueue } from "@/lib/save-refresh";
import { clearOnOtherSend } from "./dashboard/refusals";

const RefreshContext = createContext<(() => Promise<void>) | undefined>(undefined);

/** Refreshes the page's data; resolves once the refreshed page has rendered. */
export function useRefresh() {
  const router = useRouter();
  const shared = useContext(RefreshContext);
  return shared ?? (async () => router.refresh());
}

/** The page as its address says it: a form left on another is hidden, or gone. */
export const currentPage = () => window.location.pathname + window.location.search;

type SavedHere = Saved & { quiet?: boolean };
const SavedContext = createContext<(saved: SavedHere) => void>(() => {});

/** Says what a save did in the nearest SavedPlace, for a form that can't say it itself. */
export const useSaySaved = () => useContext(SavedContext);

/**
 * Around the pages whose forms refresh them (#111). The refresh is shared by the
 * forms, and outlives them, so each can wait for it; a save's message goes at
 * the top when the form that would show it is gone and no SavedPlace is nearer.
 */
export function PageRefresh({ children }: { children: ReactNode }) {
  const router = useRouter();
  // Set in the refresh's own transition, so it commits with the refreshed page.
  const [rendered, setRendered] = useState(0);
  const [queue] = useState(() =>
    refreshQueue((turn) =>
      startTransition(() => {
        router.refresh();
        setRendered(turn);
      }),
    ),
  );
  useEffect(() => {
    queue.rendered(rendered);
  }, [queue, rendered]);
  return (
    <RefreshContext value={queue.request}>
      <SavedPlace first>{children}</SavedPlace>
    </RefreshContext>
  );
}

/** Calls `clear` when any form on the page is sent, and on stopping (the page left, or hidden and kept). */
export function clearWithSends(clear: () => void) {
  const off = clearOnOtherSend(Symbol("saved-place"), clear);
  return () => {
    off();
    clear();
  };
}

/**
 * Where a form inside says what it saved if the save took the form away (a
 * deleted row): after the content, or `first`. It stays until the next send.
 */
export function SavedPlace({
  first = false,
  className,
  children,
}: {
  first?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const outer = useSaySaved();
  const region = useRef<HTMLDivElement>(null);
  const [saved, setSaved] = useState<SavedHere>();
  useEffect(() => {
    const stop = clearWithSends(() => setSaved(undefined));
    return () => stop();
  }, []);
  // A message at the top of the page may be out of sight.
  useEffect(() => {
    if (saved && !saved.quiet) region.current?.scrollIntoView({ block: "nearest" });
  }, [saved]);

  // Here, unless this place is gone too. The same function always: every form inside reads it.
  const say = useCallback(
    (what: SavedHere) => (region.current?.isConnected ? setSaved(what) : outer(what)),
    [outer],
  );
  const shown = saved && !saved.quiet;
  const status = (
    <div role="status" ref={region} className={shown ? (first ? "mb-4" : undefined) : "sr-only"}>
      {saved && (saved.quiet ? saved.message : <SavedMessage saved={{ ...saved, plain: false }} />)}
    </div>
  );
  return (
    <SavedContext value={say}>
      {first && (
        <Suspense>
          <OnOtherPage clear={() => setSaved(undefined)} />
        </Suspense>
      )}
      {first && status}
      {first ? (
        children
      ) : (
        <div className={className}>
          {children}
          {status}
        </div>
      )}
    </SavedContext>
  );
}

/** Clears what the last page's form said: the place outlives the page. */
function OnOtherPage({ clear }: { clear: () => void }) {
  const address = `${usePathname()}?${useSearchParams()}`;
  const before = useRef(address);
  useEffect(() => {
    if (before.current === address) return;
    before.current = address;
    clear();
  });
  return null;
}

/** What a save says: its message, with a link and a warning if it has them. */
export function SavedMessage({ saved }: { saved: Saved }) {
  return (
    <div className="flex flex-col gap-2">
      {saved.plain ? (
        <p className="text-caption text-ink-2">{saved.message}</p>
      ) : (
        <Notice tone="positive">
          {saved.message}
          {saved.href && (
            <>
              {" "}
              {/* A full load, so the day's row is the page's :target. */}
              <a href={saved.href} className="font-semibold underline underline-offset-2">
                {saved.linkLabel ?? "View"}
              </a>
            </>
          )}
        </Notice>
      )}
      {saved.warning && <Notice tone="attention">{saved.warning}</Notice>}
    </div>
  );
}
