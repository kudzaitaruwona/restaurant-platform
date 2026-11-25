"use client";

import {
  Ban,
  CircleX,
  Clock,
  MessageSquareText,
  Undo2,
  Volume2,
  VolumeX,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RowMenu, RowMenuItem, RowMenuLabel, RowMenuSeparator } from "@/components/ui/row-menu";
import {
  ageOf,
  arrivals,
  type BoardGroup,
  type BoardItem,
  boardColumns,
  cardMenuActions,
  type BoardStatus,
  type ItemStatus,
  itemsOfOrder,
  liveBoard,
  nextStatus,
  previousStatus,
  sameSpotGuard,
  sendMove,
  sendReject,
  sendVoid,
  type Tap,
  VOID_REASON_MAX,
  voidReasonFrom,
} from "@/lib/kitchen-board";
import { type Changes, type Connection, startPolling } from "@/lib/kitchen-poll";
import { tableName } from "@/lib/table-name";
import { cn } from "@/lib/utils";
import { ConnectionBar } from "./connection-bar";

const columnNames: Record<BoardStatus, string> = {
  placed: "Placed",
  cooking: "Cooking",
  done: "Done",
};
/** What a tap does in each column, said once in its header. */
const columnHints: Record<BoardStatus, string> = {
  placed: "Tap to start cooking",
  cooking: "Tap when done",
  done: "Tap when delivered",
};
/** What an empty column is waiting for, so an empty board never looks broken. */
const emptyColumns: Record<BoardStatus, [string, string]> = {
  placed: ["No orders waiting", "New items appear here within 5 seconds."],
  cooking: ["Nothing cooking", "Tap a placed item to start it."],
  done: ["Nothing to take out", "Cooked items wait here."],
};
const statusNames: Record<ItemStatus, string> = {
  placed: "Placed",
  cooking: "Cooking",
  done: "Done",
  delivered: "Delivered",
  voided: "Voided",
};
const forwardWords: Partial<Record<ItemStatus, string>> = {
  placed: "Start cooking",
  cooking: "Mark done",
  done: "Mark delivered",
};

const LONG_PRESS_MS = 500;
const TICK_MS = 15_000;
/** How long a refused move's message stays up. */
const MESSAGE_MS = 6_000;
/** Said for a tap the same-spot guard ignored (#100). */
const SPOT_MESSAGE = "Second tap in one spot ignored. Tap again in a moment if you meant it.";

type TapPoint = Omit<Tap, "itemId">;

type Override = "void" | "reject";
type Asking = { itemId: string; kind: Override };

/**
 * The kitchen board (spec 07, S-41): three columns, one ticket per order per
 * column, one tappable row per item. One tap moves an item on; a long press, or
 * its "..." button, opens the menu that moves it back, voids it or rejects its
 * order, each with a reason (#73, S-36). It polls every 5 seconds for what
 * changed, ages tickets against the server's clock, and flashes, with a sound
 * once a tap has allowed one, when new items arrive. It is dark whatever the
 * system says (data-page-theme), for a screen under bright lights all service.
 */
export function KitchenBoard({ initial }: { initial: Changes }) {
  // What the board holds, for the callbacks that change it: applying a change
  // has to know what was there to tell what arrived, and what has left (#135).
  const [held] = useState(() => liveBoard(initial.items));
  const [board, setBoard] = useState(held.board);
  // The server's clock, as this tablet estimates it: renders the same on both sides.
  const [clock, setClock] = useState(() => Date.parse(initial.now));
  const skew = useRef(0);
  const [connection, setConnection] = useState<Connection>("online");
  const [flashing, setFlashing] = useState<ReadonlySet<string>>(new Set());
  const [asking, setAsking] = useState<Asking>();
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [message, setMessage] = useState<string>();
  const [soundOn, setSoundOn] = useState(false);
  const [alert] = useState(() =>
    arrivals({ makeAudio: () => new AudioContext(), onFlash: setFlashing }),
  );
  const poller = useRef<ReturnType<typeof startPolling> | null>(null);
  // Set once the board has been hidden (Activity keeps it mounted): the cursor of
  // what it holds. Shown again it goes on from there, at once, not from a newer
  // `initial`, which would leave out what changed while it was away (#135).
  const resumeFrom = useRef<string>(undefined);
  // One per board: a ticket that slides under a double tap isn't advanced (#100).
  const spot = useRef(sameSpotGuard());

  /** A move's answer, applied only if it is still true of the board (#101). */
  const applyAnswer = (items: BoardItem[]) => setBoard(held.answered(items).board);

  useEffect(() => {
    skew.current = Date.parse(initial.now) - Date.now();
    const tick = setInterval(() => setClock(Date.now() + skew.current), TICK_MS);
    let askedAt = 0; // One poll at a time, so it is the answering poll's.
    const polling = startPolling({
      cursor: resumeFrom.current ?? initial.cursor,
      fetch: (url, signal) => {
        askedAt = performance.now();
        return fetch(url, { signal, cache: "no-store" });
      },
      onChanges: (changes) => {
        skew.current = Date.parse(changes.now) - Date.now();
        setClock(Date.parse(changes.now));
        // Flashes and sounds for the items new to the board. An answer brings none.
        const { board: next, arrived } = held.polled(changes.items);
        setBoard(next);
        alert.arrive(arrived);
        spot.current.polled(askedAt, performance.now(), changes.items.map((item) => item.id));
      },
      onConnection: setConnection,
    });
    poller.current = polling;
    if (resumeFrom.current !== undefined) polling.refresh();
    return () => {
      clearInterval(tick);
      resumeFrom.current = polling.stop();
    };
  }, [initial.cursor, initial.now, held, alert]);

  // A refused move says so briefly, then gets out of the way.
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(undefined), MESSAGE_MS);
    return () => clearTimeout(timer);
  }, [message]);

  function enableSound() {
    alert.enableSound();
    setSoundOn(true);
  }

  async function move(item: BoardItem, to: ItemStatus) {
    setAsking(undefined);
    setPending((was) => new Set(was).add(item.id));
    try {
      await sendMove(item, to, {
        fetch: (url, init) => fetch(url, init),
        apply: (items) => {
          applyAnswer(items);
          spot.current.shown(item.id, performance.now());
        },
        say: setMessage,
        poller: poller.current,
        lost: () => spot.current.unanswered(item.id, performance.now()),
      });
    } finally {
      // The ticket moves about now, so the spot is guarded from here (#100). A lost
      // move's is kept until the board shows where the item is (#135).
      spot.current.settled(item.id, performance.now());
      setPending((was) => {
        const next = new Set(was);
        next.delete(item.id);
        return next;
      });
    }
  }

  /** Void an item, or reject its whole order: every one of its items leaves the board. */
  async function override(item: BoardItem, kind: Override, reason: string) {
    const order = itemsOfOrder(held.board(), item.orderId);
    const busy = kind === "void" ? [item] : order;
    setPending((was) => new Set([...was, ...busy.map((it) => it.id)]));
    const deps = {
      fetch: (url: string, init: RequestInit & { body: FormData }) => fetch(url, init),
      apply: applyAnswer,
      say: setMessage,
      poller: poller.current,
    };
    try {
      const worked =
        kind === "void"
          ? await sendVoid(item, reason, deps)
          : await sendReject(item, order, reason, deps);
      if (worked) setAsking(undefined);
    } finally {
      setPending((was) => {
        const next = new Set(was);
        for (const it of busy) next.delete(it.id);
        return next;
      });
    }
  }

  const now = new Date(clock);
  const columns = boardColumns(board);
  const live = connection === "online";

  return (
    // 16px, or 19px on a wall screen: the board's type is in em, so it grows with it.
    <div data-page-theme="dark" className="flex flex-col gap-4 text-[16px] min-[1600px]:text-[19px]">
      <ConnectionBar connection={connection} />
      <header className="flex min-h-12 flex-wrap items-center gap-4">
        <h1 className="text-[1.5em] font-semibold tracking-tight max-md:sr-only">Kitchen</h1>
        <span className="flex-1" />
        {soundOn ? (
          <span className="inline-flex min-h-12 items-center gap-2 px-2 font-medium text-ink-2">
            <Volume2 aria-hidden className="size-[1.25em]" />
            Sound on
          </span>
        ) : (
          <Button size="staff" className="text-[1.0625em]" onClick={enableSound}>
            <VolumeX aria-hidden />
            Tap to enable sound
          </Button>
        )}
      </header>

      <div
        data-stale={live ? undefined : "true"}
        className={cn(
          "grid grid-cols-1 gap-y-8 transition-[opacity,filter] duration-200 ease-out md:grid-cols-3",
          !live && "opacity-55 saturate-[.6]",
        )}
      >
        {columns.map((column) => {
          const count = column.groups.reduce((sum, group) => sum + group.items.length, 0);
          const [emptyTitle, emptyHint] = emptyColumns[column.status];
          return (
            <section
              key={column.status}
              aria-labelledby={`kitchen-${column.status}`}
              className="flex min-w-0 flex-col gap-3 border-line md:border-r md:px-4 md:first:pl-0 md:last:border-r-0 md:last:pr-0"
            >
              <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 pt-1">
                <h2 id={`kitchen-${column.status}`} className="text-[1.25em] font-semibold">
                  {columnNames[column.status]}
                </h2>
                <span
                  className="text-[1.0625em] font-semibold text-ink-2 tabular-nums"
                  aria-label={`${count} ${count === 1 ? "item" : "items"}`}
                >
                  {count}
                </span>
                <span className="ml-auto text-[.8125em] text-ink-2">{columnHints[column.status]}</span>
              </div>
              {column.groups.length === 0 && (
                <p className="rounded-card border border-dashed border-line px-4 py-8 text-center text-[1.0625em] text-ink-2">
                  <strong className="mb-1 block text-[1.18em] font-semibold text-ink">{emptyTitle}</strong>
                  {emptyHint}
                </p>
              )}
              {column.groups.map((group) => (
                <Ticket
                  key={group.orderId}
                  group={group}
                  status={column.status}
                  now={now}
                  flashing={flashing}
                  pending={pending}
                  asking={asking}
                  onForward={(item, tap) => {
                    const to = nextStatus(item.status);
                    if (!to) return;
                    if (!spot.current.allow({ itemId: item.id, ...tap })) {
                      // Never over a refused move's message, which matters more.
                      setMessage((was) => was ?? SPOT_MESSAGE);
                      return;
                    }
                    void move(item, to);
                  }}
                  onBack={(item) => {
                    const to = previousStatus(item.status);
                    if (to) void move(item, to);
                  }}
                  onAsk={setAsking}
                  onOverride={override}
                />
              ))}
            </section>
          );
        })}
      </div>

      <div role="status" className="pointer-events-none fixed inset-x-0 bottom-6 z-20 flex justify-center px-4">
        {message && (
          <p className="rounded-control bg-ink px-4 py-3 text-[1.0625em] font-medium text-page shadow-float">
            {message}
          </p>
        )}
      </div>
    </div>
  );
}

/** One order's items in one column: its table, name and age once, then a row per item. */
function Ticket({
  group,
  status,
  now,
  flashing,
  pending,
  asking,
  onForward,
  onBack,
  onAsk,
  onOverride,
}: {
  group: BoardGroup;
  status: BoardStatus;
  now: Date;
  flashing: ReadonlySet<string>;
  pending: ReadonlySet<string>;
  asking: Asking | undefined;
  onForward: (item: BoardItem, tap: TapPoint) => void;
  onBack: (item: BoardItem) => void;
  onAsk: (asking: Asking | undefined) => void;
  onOverride: (item: BoardItem, kind: Override, reason: string) => Promise<void>;
}) {
  // An order's items share its placedAt, so they share its age.
  const age = ageOf(group.items[0], now);
  const isNew = group.items.some((item) => flashing.has(item.id));
  const askingItem = asking && group.items.find((item) => item.id === asking.itemId);

  return (
    <article
      data-order={group.orderId}
      data-age={age.level}
      className={cn(
        "overflow-hidden rounded-card border border-line bg-surface transition-[border-color,background-color] duration-200 ease-out",
        age.level === "amber" && "border-attention",
        age.level === "red" && "border-2 border-attention",
        isNew && "border-2 border-accent bg-accent-soft",
      )}
    >
      <div
        className={cn(
          "flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line py-2.5 pr-3 pl-4",
          status === "done" && "bg-accent-soft",
          age.level !== "fresh" && "bg-attention-soft",
        )}
      >
        <span className="text-[2em] leading-none font-bold tracking-tight">{tableName(group.table)}</span>
        {/* The name has a line of its own (last in the flow, first in the markup), so it breaks between words and only breaks a word that is longer than the card; nothing on a card is cut off (#101). */}
        <span className="order-last basis-full break-words text-[1.0625em] font-medium text-ink-2">
          {group.customerName}
        </span>
        {isNew && (
          <span className="ml-auto shrink-0 rounded-full bg-accent px-2.5 py-0.5 text-[.8125em] font-semibold text-on-accent motion-safe:animate-pulse">
            New
          </span>
        )}
        <span
          className={cn(
            "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap tabular-nums",
            !isNew && "ml-auto",
            status === "done" ? "text-[.9375em] font-medium text-ink-2" : "text-[1.25em] font-semibold",
            age.level === "amber" && "text-attention-ink",
            age.level === "red" && "rounded-control bg-attention px-3 py-1.5 text-on-attention",
          )}
        >
          {status === "done" ? (
            `ordered ${age.label}`
          ) : (
            <>
              <Clock aria-hidden className="size-[1em]" />
              {age.label}
            </>
          )}
        </span>
      </div>
      {group.items.map((item) => (
        <ItemRow
          key={item.id}
          item={item}
          pending={pending.has(item.id)}
          onForward={(tap) => onForward(item, tap)}
          onBack={() => onBack(item)}
          onAsk={(kind) => onAsk({ itemId: item.id, kind })}
        />
      ))}
      {askingItem && (
        <ReasonForm
          key={`${askingItem.id}-${asking.kind}`}
          item={askingItem}
          kind={asking.kind}
          pending={pending.has(askingItem.id)}
          onCancel={() => onAsk(undefined)}
          onSubmit={(reason) => onOverride(askingItem, asking.kind, reason)}
        />
      )}
    </article>
  );
}

/** One item: the whole row is its tap target, with its own "..." menu. */
function ItemRow({
  item,
  pending,
  onForward,
  onBack,
  onAsk,
}: {
  item: BoardItem;
  pending: boolean;
  onForward: (tap: TapPoint) => void;
  onBack: () => void;
  onAsk: (kind: Override) => void;
}) {
  const row = useRef<HTMLDivElement>(null);
  const pressTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const longPressed = useRef(false);
  const back = previousStatus(item.status);
  const actions = cardMenuActions(item.status);

  const cancelPress = () => clearTimeout(pressTimer.current);
  // Opened once the finger lifts, so the lift doesn't light-dismiss it straight away.
  const openMenu = () =>
    setTimeout(() => row.current?.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')?.click());

  return (
    // The "..." button sits over the row's top-right corner, so a note below it
    // can use the ticket's whole width instead of what is left beside the button (#101).
    <div ref={row} className="relative border-line not-first-of-type:border-t">
      <button
        type="button"
        disabled={pending}
        aria-label={`${forwardWords[item.status]}: ${item.quantity} × ${item.name}, ${tableName(item.table)}`}
        className={cn(
          "grid min-h-16 w-full min-w-0 touch-manipulation grid-cols-[3em_minmax(0,1fr)] items-start gap-x-2 py-3 pr-4 pl-4 text-left transition-colors duration-150 ease-out outline-none select-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset active:bg-accent-soft disabled:cursor-progress disabled:opacity-55",
          // The name's row is as tall as the menu button, so a note never runs under it.
          item.note && "grid-rows-[minmax(3.25rem,auto)_auto]",
        )}
        onPointerDown={() => {
          longPressed.current = false;
          cancelPress();
          pressTimer.current = setTimeout(() => {
            longPressed.current = true;
          }, LONG_PRESS_MS);
        }}
        onPointerUp={() => {
          cancelPress();
          if (longPressed.current) openMenu();
        }}
        onPointerLeave={cancelPress}
        onPointerCancel={cancelPress}
        onContextMenu={(event) => event.preventDefault()}
        onClick={(event) => {
          if (longPressed.current) {
            longPressed.current = false;
            return;
          }
          onForward({ x: event.clientX, y: event.clientY, at: event.timeStamp, fromPointer: event.detail > 0 });
        }}
      >
        <span className="text-[1.5em] leading-[1.07] font-bold whitespace-nowrap tabular-nums">
          {item.quantity}{" "}
          <span className="text-[.7em] font-medium text-ink-2">×</span>
        </span>
        <span className="pr-10 text-[1.25em] leading-[1.28] font-semibold break-words">{item.name}</span>
        {item.note && (
          <span
            data-note="true"
            className="col-span-2 mt-2 flex items-start gap-2 rounded-control bg-attention-soft px-3 py-2 text-[1.0625em] font-semibold whitespace-pre-wrap break-words text-ink"
          >
            <MessageSquareText aria-hidden className="mt-0.5 size-[1.1em] shrink-0 text-attention-ink" />
            <span className="min-w-0">{item.note}</span>
          </span>
        )}
      </button>
      <RowMenu
        label={`More for ${item.quantity} × ${item.name}`}
        className="absolute top-0 right-0 h-16 w-14 rounded-none border-0 bg-transparent text-ink-2 hover:bg-surface-2 hover:text-ink focus-visible:ring-inset focus-visible:ring-offset-0 aria-expanded:bg-surface-2 aria-expanded:text-ink [&_svg]:size-6"
      >
        <RowMenuLabel>
          {item.quantity} × {item.name}, {tableName(item.table)}
        </RowMenuLabel>
        {actions.includes("back") && back && (
          <>
            <RowMenuItem icon={<Undo2 />} disabled={pending} onSelect={onBack}>
              Move back to {statusNames[back]}
            </RowMenuItem>
            <RowMenuSeparator />
          </>
        )}
        {actions.includes("void") && (
          <RowMenuItem icon={<Ban />} tone="danger" disabled={pending} onSelect={() => onAsk("void")}>
            Void item…
          </RowMenuItem>
        )}
        {actions.includes("reject") && (
          <RowMenuItem icon={<CircleX />} tone="danger" disabled={pending} onSelect={() => onAsk("reject")}>
            Reject whole order…
          </RowMenuItem>
        )}
      </RowMenu>
    </div>
  );
}

/**
 * The menu's second step, inside the ticket (spec 07, S-36): void the item or
 * reject its whole order, with a reason.
 */
function ReasonForm({
  item,
  kind,
  pending,
  onCancel,
  onSubmit,
}: {
  item: BoardItem;
  kind: Override;
  pending: boolean;
  onCancel: () => void;
  onSubmit: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const form = useRef<HTMLFormElement>(null);
  // The field's autofocus only scrolls the field into view, which leaves the
  // buttons below the fold on a lower ticket (#101): bring the whole form in.
  useEffect(() => {
    form.current?.scrollIntoView({ block: "nearest" });
  }, []);
  return (
    <form
      ref={form}
      className="grid scroll-mb-24 gap-2.5 border-t border-line p-3"
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = voidReasonFrom(reason);
        if (trimmed === null) return;
        void onSubmit(trimmed);
      }}
    >
      <label className="grid gap-2 text-[.9375em] font-semibold">
        {kind === "void"
          ? `Why void ${item.quantity} × ${item.name}?`
          : `Why reject ${item.customerName}'s whole order at ${tableName(item.table)}?`}
        <Input
          name="reason"
          required
          maxLength={VOID_REASON_MAX}
          autoFocus
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          className="bg-surface-2 text-[1.0625em] font-normal"
        />
      </label>
      <div className="flex gap-2">
        <Button type="submit" variant="danger" size="staff" disabled={pending || voidReasonFrom(reason) === null}>
          {kind === "void" ? "Void item" : "Reject order"}
        </Button>
        <Button type="button" variant="ghost" size="staff" className="text-ink-2" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
