"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, useState } from "react";
import { postForm } from "@/lib/form-response";

type Entry = { id: string; name: string; content: ReactNode };

/**
 * The categories in order, reorderable by dragging a handle or with the arrow
 * buttons, which are what a phone uses: touch screens don't drag. Every move
 * posts the whole order, and the page refreshes from what the server kept.
 * Without JavaScript the list is just the categories in their saved order.
 */
export function SortableCategories({ entries }: { entries: Entry[] }) {
  const router = useRouter();
  const [order, setOrder] = useState(entries.map((entry) => entry.id));
  const [dragging, setDragging] = useState<string>();
  const [error, setError] = useState<string>();

  // The server's order wins whenever it changes (a category added or archived).
  const serverOrder = entries.map((entry) => entry.id).join();
  const [seen, setSeen] = useState(serverOrder);
  if (seen !== serverOrder) {
    setSeen(serverOrder);
    setOrder(entries.map((entry) => entry.id));
  }

  const byId = new Map(entries.map((entry) => [entry.id, entry]));

  async function save(next: string[]) {
    const before = order;
    setOrder(next);
    setError(undefined);
    const body = new FormData();
    for (const id of next) body.append("ids", id);
    try {
      const response = await postForm("/api/menu/categories/order", body);
      if (!response.ok) throw new Error();
      router.refresh();
    } catch {
      setOrder(before);
      setError("The new order wasn't saved. Try again.");
    }
  }

  const move = (id: string, to: number) => {
    const from = order.indexOf(id);
    if (from === to || to < 0 || to >= order.length) return;
    const next = [...order];
    next.splice(to, 0, ...next.splice(from, 1));
    void save(next);
  };

  return (
    <div className="flex flex-col gap-6">
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {order.map((id, index) => {
        const entry = byId.get(id);
        if (!entry) return null;
        return (
          <div
            key={id}
            onDragOver={(event) => dragging && event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              if (dragging) move(dragging, index);
              setDragging(undefined);
            }}
            className={dragging === id ? "opacity-50" : undefined}
          >
            <div className="mb-1 flex items-center gap-1 text-sm text-muted-foreground">
              <span
                draggable
                onDragStart={(event) => {
                  // A drag with no data doesn't start in every browser.
                  event.dataTransfer.setData("text/plain", entry.name);
                  event.dataTransfer.effectAllowed = "move";
                  setDragging(id);
                }}
                onDragEnd={() => setDragging(undefined)}
                aria-hidden="true"
                title="Drag to reorder"
                className="cursor-grab select-none px-1"
              >
                ⠿
              </span>
              <button
                type="button"
                aria-label={`Move ${entry.name} up`}
                disabled={index === 0}
                onClick={() => move(id, index - 1)}
                className="px-2 disabled:opacity-30"
              >
                ↑
              </button>
              <button
                type="button"
                aria-label={`Move ${entry.name} down`}
                disabled={index === order.length - 1}
                onClick={() => move(id, index + 1)}
                className="px-2 disabled:opacity-30"
              >
                ↓
              </button>
            </div>
            {entry.content}
          </div>
        );
      })}
    </div>
  );
}
