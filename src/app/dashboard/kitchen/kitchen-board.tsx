"use client";

import { useEffect, useRef, useState } from "react";
import {
  ageOf,
  applyChanges,
  arrivals,
  type BoardItem,
  boardColumns,
  cardMenuActions,
  type BoardStatus,
  type ItemStatus,
  itemsOfOrder,
  nextStatus,
  previousStatus,
  sendMove,
  sendReject,
  sendVoid,
  VOID_REASON_MAX,
  voidReasonFrom,
} from "@/lib/kitchen-board";
import { type Changes, type Connection, startPolling } from "@/lib/kitchen-poll";

const columnNames: Record<BoardStatus, string> = {
  placed: "Placed",
  cooking: "Cooking",
  done: "Done",
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
const ageStyles = {
  fresh: "border-border bg-card",
  amber: "border-amber-500 bg-amber-100 text-amber-950",
  red: "border-red-600 bg-red-100 text-red-950",
} as const;

const LONG_PRESS_MS = 500;
const TICK_MS = 15_000;

/**
 * The kitchen board (spec 07): three columns, one card per item, an order's
 * items grouped. One tap moves an item on; a long press, or its ⋯ button, opens
 * the menu that moves it back, voids it or rejects its order, each with a
 * reason (#73, S-36). It polls every 5 seconds for what changed, ages
 * cards against the server's clock, and flashes, with a sound once a tap has
 * allowed one, when new items arrive.
 */
export function KitchenBoard({ initial }: { initial: Changes }) {
  const [board, setBoard] = useState<ReadonlyMap<string, BoardItem>>(
    () => new Map(initial.items.map((item) => [item.id, item])),
  );
  // What the board holds, for the callbacks that change it: applying a change
  // has to know what was there to tell what arrived.
  const current = useRef(board);
  // The server's clock, as this tablet estimates it: renders the same on both sides.
  const [clock, setClock] = useState(() => Date.parse(initial.now));
  const skew = useRef(0);
  const [connection, setConnection] = useState<Connection>("online");
  const [flashing, setFlashing] = useState<ReadonlySet<string>>(new Set());
  const [menuFor, setMenuFor] = useState<string>();
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [message, setMessage] = useState<string>();
  const [soundOn, setSoundOn] = useState(false);
  const [alert] = useState(() =>
    arrivals({ makeAudio: () => new AudioContext(), onFlash: setFlashing }),
  );
  const poller = useRef<ReturnType<typeof startPolling> | null>(null);

  /** Applies changed items, and flashes and sounds for the ones new to the board. */
  function update(items: BoardItem[]) {
    const { board: next, arrived } = applyChanges(current.current, items);
    current.current = next;
    setBoard(next);
    alert.arrive(arrived);
  }
  const updateRef = useRef(update);
  useEffect(() => {
    updateRef.current = update;
  });

  useEffect(() => {
    skew.current = Date.parse(initial.now) - Date.now();
    const tick = setInterval(() => setClock(Date.now() + skew.current), TICK_MS);
    poller.current = startPolling({
      cursor: initial.cursor,
      fetch: (url, signal) => fetch(url, { signal, cache: "no-store" }),
      onChanges: (changes) => {
        skew.current = Date.parse(changes.now) - Date.now();
        setClock(Date.parse(changes.now));
        updateRef.current(changes.items);
      },
      onConnection: setConnection,
    });
    return () => {
      clearInterval(tick);
      poller.current?.stop();
    };
  }, [initial.cursor, initial.now]);

  function enableSound() {
    alert.enableSound();
    setSoundOn(true);
  }

  async function move(item: BoardItem, to: ItemStatus) {
    setMenuFor(undefined);
    setPending((was) => new Set(was).add(item.id));
    try {
      await sendMove(item, to, {
        fetch: (url, init) => fetch(url, init),
        apply: update,
        say: setMessage,
        poller: poller.current,
      });
    } finally {
      setPending((was) => {
        const next = new Set(was);
        next.delete(item.id);
        return next;
      });
    }
  }

  /** Void an item, or reject its whole order: every one of its items leaves the board. */
  async function override(item: BoardItem, kind: "void" | "reject", reason: string) {
    const order = itemsOfOrder(current.current, item.orderId);
    const busy = kind === "void" ? [item] : order;
    setPending((was) => new Set([...was, ...busy.map((it) => it.id)]));
    const deps = {
      fetch: (url: string, init: RequestInit & { body: FormData }) => fetch(url, init),
      apply: update,
      say: setMessage,
      poller: poller.current,
    };
    try {
      const worked =
        kind === "void"
          ? await sendVoid(item, reason, deps)
          : await sendReject(item, order, reason, deps);
      if (worked) setMenuFor(undefined);
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

  return (
    <div className="flex flex-col gap-4">
      {connection !== "online" && (
        <div
          role="alert"
          className="sticky top-0 z-10 rounded-md bg-red-700 px-4 py-3 text-lg font-semibold text-white"
        >
          {connection === "offline"
            ? "Offline — reconnecting"
            : "Signed out. Sign in again to keep the board live."}
        </div>
      )}
      {!soundOn && (
        <button
          type="button"
          onClick={enableSound}
          className="rounded-md border-2 border-dashed px-4 py-3 text-lg font-medium"
        >
          Tap to enable sound
        </button>
      )}
      {message && (
        <p role="status" className="text-sm text-muted-foreground">
          {message}
        </p>
      )}
      <div className="grid grid-cols-3 gap-4">
        {columns.map((column) => (
          <section key={column.status} className="flex min-w-0 flex-col gap-3">
            <h2 className="text-xl font-semibold">{columnNames[column.status]}</h2>
            {column.groups.length === 0 && column.status === "placed" && (
              <p className="text-muted-foreground">No orders waiting.</p>
            )}
            {column.groups.map((group) => (
              <div
                key={group.orderId}
                data-order={group.orderId}
                className="flex flex-col gap-2 rounded-lg border-2 border-dashed border-muted-foreground/40 p-2"
              >
                {group.items.map((item) => (
                  <Card
                    key={item.id}
                    item={item}
                    now={now}
                    flashing={flashing.has(item.id)}
                    pending={pending.has(item.id)}
                    menuOpen={menuFor === item.id}
                    onForward={() => {
                      const to = nextStatus(item.status);
                      if (to) void move(item, to);
                    }}
                    onBack={() => {
                      const to = previousStatus(item.status);
                      if (to) void move(item, to);
                    }}
                    onMenu={(open) => setMenuFor(open ? item.id : undefined)}
                    onVoid={(reason) => override(item, "void", reason)}
                    onReject={(reason) => override(item, "reject", reason)}
                  />
                ))}
              </div>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}

function Card({
  item,
  now,
  flashing,
  pending,
  menuOpen,
  onForward,
  onBack,
  onMenu,
  onVoid,
  onReject,
}: {
  item: BoardItem;
  now: Date;
  flashing: boolean;
  pending: boolean;
  menuOpen: boolean;
  onForward: () => void;
  onBack: () => void;
  onMenu: (open: boolean) => void;
  onVoid: (reason: string) => Promise<void>;
  onReject: (reason: string) => Promise<void>;
}) {
  const age = ageOf(item, now);
  const pressTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const longPressed = useRef(false);
  const back = previousStatus(item.status);

  const cancelPress = () => clearTimeout(pressTimer.current);

  return (
    <article
      data-age={age.level}
      className={`flex flex-col rounded-md border-2 ${ageStyles[age.level]} ${
        flashing ? "animate-pulse ring-4 ring-sky-500" : ""
      }`}
    >
      <div className="flex">
        <button
          type="button"
          disabled={pending}
          aria-label={`${forwardWords[item.status]}: ${item.quantity} × ${item.name}, ${item.table}`}
          className="flex min-w-0 flex-1 touch-manipulation select-none flex-col gap-1 p-3 text-left disabled:opacity-60"
          onPointerDown={() => {
            longPressed.current = false;
            cancelPress();
            pressTimer.current = setTimeout(() => {
              longPressed.current = true;
              onMenu(true);
            }, LONG_PRESS_MS);
          }}
          onPointerUp={cancelPress}
          onPointerLeave={cancelPress}
          onPointerCancel={cancelPress}
          onContextMenu={(event) => event.preventDefault()}
          onClick={() => {
            if (longPressed.current) {
              longPressed.current = false;
              return;
            }
            onForward();
          }}
        >
          <span className="text-2xl font-bold">{item.table}</span>
          <span className="text-lg font-medium break-words">
            {item.quantity} × {item.name}
          </span>
          {item.note && (
            <span
              data-note="true"
              className="rounded border-l-4 border-sky-700 bg-sky-100 px-2 py-1 font-semibold whitespace-pre-wrap break-words text-sky-950"
            >
              {item.note}
            </span>
          )}
          <span className="text-sm">For {item.customerName}</span>
          <span className="text-sm font-medium">{age.label}</span>
        </button>
        <button
          type="button"
          aria-label={`More for ${item.quantity} × ${item.name}`}
          aria-expanded={menuOpen}
          className="px-3 text-2xl"
          onClick={() => onMenu(!menuOpen)}
        >
          ⋯
        </button>
      </div>
      {menuOpen && (
        <CardMenu
          item={item}
          back={back}
          pending={pending}
          onBack={onBack}
          onClose={() => onMenu(false)}
          onVoid={onVoid}
          onReject={onReject}
        />
      )}
    </article>
  );
}

/**
 * A card's menu (spec 07): move back one status for a mis-tap, void the item,
 * or reject its whole order (S-36). Void and reject ask for a reason first.
 */
function CardMenu({
  item,
  back,
  pending,
  onBack,
  onClose,
  onVoid,
  onReject,
}: {
  item: BoardItem;
  back: ItemStatus | undefined;
  pending: boolean;
  onBack: () => void;
  onClose: () => void;
  onVoid: (reason: string) => Promise<void>;
  onReject: (reason: string) => Promise<void>;
}) {
  const [asking, setAsking] = useState<"void" | "reject">();
  const [reason, setReason] = useState("");

  if (asking) {
    const words = asking === "void" ? "Void item" : "Reject order";
    return (
      <form
        className="flex flex-col gap-2 border-t p-2"
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = voidReasonFrom(reason);
          if (trimmed === null) return;
          void (asking === "void" ? onVoid : onReject)(trimmed);
        }}
      >
        <label className="flex flex-col gap-1 text-sm font-medium">
          {asking === "void"
            ? `Why void ${item.quantity} × ${item.name}?`
            : `Why reject ${item.customerName}'s whole order at ${item.table}?`}
          <input
            name="reason"
            required
            maxLength={VOID_REASON_MAX}
            autoFocus
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            className="rounded-md border px-2 py-2 text-base font-normal"
          />
        </label>
        <div className="flex gap-2">
          <button
            type="submit"
            disabled={pending || voidReasonFrom(reason) === null}
            className="rounded-md bg-red-700 px-3 py-2 font-medium text-white disabled:opacity-60"
          >
            {words}
          </button>
          <button type="button" className="rounded-md px-3 py-2" onClick={() => setAsking(undefined)}>
            Cancel
          </button>
        </div>
      </form>
    );
  }

  const redButton = "rounded-md border border-red-700 px-3 py-2 font-medium text-red-700";
  return (
    <div className="flex flex-wrap gap-2 border-t p-2">
      {cardMenuActions(item.status).map((action) =>
        action === "back" && back ? (
          <button
            key={action}
            type="button"
            disabled={pending}
            className="rounded-md border px-3 py-2 font-medium"
            onClick={onBack}
          >
            Move back to {statusNames[back]}
          </button>
        ) : action === "void" || action === "reject" ? (
          <button
            key={action}
            type="button"
            disabled={pending}
            className={redButton}
            onClick={() => setAsking(action)}
          >
            {action === "void" ? "Void item…" : "Reject order…"}
          </button>
        ) : null,
      )}
      <button type="button" className="rounded-md px-3 py-2" onClick={onClose}>
        Close
      </button>
    </div>
  );
}
