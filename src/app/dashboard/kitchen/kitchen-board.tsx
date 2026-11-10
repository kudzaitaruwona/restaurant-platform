"use client";

import { useEffect, useRef, useState } from "react";
import {
  ageOf,
  applyChanges,
  type BoardItem,
  boardColumns,
  type BoardStatus,
  type ItemStatus,
  nextStatus,
  previousStatus,
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
const FLASH_MS = 4_000;
const TICK_MS = 15_000;

/** Two short beeps, made on the spot: no sound file to fetch. */
function beep(audio: AudioContext) {
  for (const start of [0, 0.25]) {
    const tone = audio.createOscillator();
    const gain = audio.createGain();
    tone.frequency.value = 880;
    gain.gain.value = 0.2;
    tone.connect(gain).connect(audio.destination);
    tone.start(audio.currentTime + start);
    tone.stop(audio.currentTime + start + 0.15);
  }
}

/**
 * The kitchen board (spec 07): three columns, one card per item, an order's
 * items grouped. One tap moves an item on; a long press, or its ⋯ button, opens
 * the menu that moves it back. It polls every 5 seconds for what changed, ages
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
  const audio = useRef<AudioContext | null>(null);
  const poller = useRef<ReturnType<typeof startPolling> | null>(null);

  /** Applies changed items, and flashes and sounds for the ones new to the board. */
  function update(items: BoardItem[]) {
    const { board: next, arrived } = applyChanges(current.current, items);
    current.current = next;
    setBoard(next);
    arrive(arrived);
  }

  function arrive(ids: string[]) {
    if (ids.length === 0) return;
    setFlashing((was) => new Set([...was, ...ids]));
    setTimeout(
      () => setFlashing((was) => new Set([...was].filter((id) => !ids.includes(id)))),
      FLASH_MS,
    );
    if (audio.current) beep(audio.current);
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
    audio.current ??= new AudioContext();
    void audio.current.resume();
    setSoundOn(true);
  }

  async function move(item: BoardItem, to: ItemStatus) {
    setMenuFor(undefined);
    setMessage(undefined);
    setPending((was) => new Set(was).add(item.id));
    try {
      const body = new FormData();
      body.set("from", item.status);
      body.set("to", to);
      const response = await fetch(`/api/kitchen/items/${item.id}/status`, { method: "POST", body });
      const answer = (await response.json().catch(() => ({}))) as {
        item?: BoardItem;
        status?: ItemStatus;
        error?: string;
      };
      if (response.ok && answer.item) {
        update([answer.item]);
      } else {
        setMessage(answer.error ?? "That didn't work. Try again.");
        if (answer.status) update([{ ...item, status: answer.status }]);
        poller.current?.refresh();
      }
    } catch {
      setMessage("That didn't reach the server. Try again.");
    } finally {
      setPending((was) => {
        const next = new Set(was);
        next.delete(item.id);
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
}: {
  item: BoardItem;
  now: Date;
  flashing: boolean;
  pending: boolean;
  menuOpen: boolean;
  onForward: () => void;
  onBack: () => void;
  onMenu: (open: boolean) => void;
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
            if (!back) return;
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
        {back && (
          <button
            type="button"
            aria-label={`More for ${item.quantity} × ${item.name}`}
            aria-expanded={menuOpen}
            className="px-3 text-2xl"
            onClick={() => onMenu(!menuOpen)}
          >
            ⋯
          </button>
        )}
      </div>
      {menuOpen && back && (
        <div className="flex gap-2 border-t p-2">
          <button
            type="button"
            disabled={pending}
            className="rounded-md border px-3 py-2 font-medium"
            onClick={onBack}
          >
            Move back to {statusNames[back]}
          </button>
          <button type="button" className="rounded-md px-3 py-2" onClick={() => onMenu(false)}>
            Close
          </button>
        </div>
      )}
    </article>
  );
}
