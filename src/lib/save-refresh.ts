/** What a save says about itself. */
export type Saved = {
  message: string;
  href?: string;
  linkLabel?: string;
  warning?: string;
  /** A quiet line of text, not a notice. */
  plain?: boolean;
};

/**
 * How long a form stays pending for its refreshed page. Longer, and the refresh
 * has failed or hung: the form is let go, and says the screen may be old.
 */
export const REFRESH_LIMIT_MS = 10_000;

/**
 * One refresh at a time for every form on the page. A save while one is under
 * way waits for the next, which it shares: the one under way may have read the
 * database before the save. `start` begins a refresh, and `rendered` is told the
 * last one on the screen. One older than the limit isn't waited for by others.
 */
export function refreshQueue(start: (turn: number) => void) {
  let turn = 0;
  let startedAt = 0;
  let running: (() => void)[] | undefined;
  let next: (() => void)[] | undefined;

  function run(waiting: (() => void)[]) {
    running = waiting;
    startedAt = Date.now();
    start(++turn);
  }

  return {
    request: () =>
      new Promise<void>((resolve) => {
        if (!running) run([resolve]);
        else if (Date.now() - startedAt >= REFRESH_LIMIT_MS) {
          run([...running, ...(next ?? []), resolve]);
          next = undefined;
        } else (next ??= []).push(resolve);
      }),
    rendered(shown: number) {
      if (!running || shown < turn) return;
      const done = running;
      const waiting = next;
      running = next = undefined;
      if (waiting) run(waiting);
      for (const resolve of done) resolve();
    },
  };
}

/** Whether `done` settles within the limit. It must not reject. */
export const withinRefreshLimit = (done: Promise<void>) =>
  new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), REFRESH_LIMIT_MS);
    void done.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });

const screenIsOld = "This screen hasn't updated yet. Reload the page to see the change.";

/**
 * After a save: refreshes the page and settles once it has rendered, or at the
 * limit, then says what was saved. In the form while it is there; on the page if
 * the refresh took the form away; nowhere if the person has gone to another page.
 * A save with nothing to say (`saved` undefined) is announced, not shown.
 */
export async function settleSave({
  form,
  saved,
  refresh,
  page,
  inForm,
  onPage,
  isLatest = () => true,
}: {
  form: { isConnected: boolean };
  saved: Saved | undefined;
  refresh: () => Promise<void>;
  /** The page's address now. */
  page: () => string;
  inForm: (saved: Saved | undefined) => void;
  onPage: (saved: Saved & { quiet?: boolean }) => void;
  /** False once the form has been sent again. */
  isLatest?: () => boolean;
}) {
  const sentFrom = page();
  function say(what: Saved | undefined) {
    if (form.isConnected) inForm(what);
    if (page() !== sentFrom) return;
    if (!what) onPage({ message: "Done.", quiet: true });
    else if (!form.isConnected) onPage(what);
  }

  const rendered = refresh();
  if (await withinRefreshLimit(rendered)) return say(saved);
  say({
    ...(saved ?? { message: "Saved." }),
    warning: saved?.warning ? `${saved.warning} ${screenIsOld}` : screenIsOld,
  });
  void rendered.then(() => {
    if (isLatest()) say(saved);
  });
}
