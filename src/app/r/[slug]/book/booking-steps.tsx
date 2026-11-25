"use client";

import { createContext, type ReactNode, use, useEffect, useRef, useState } from "react";
import type { TimeChoice } from "@/lib/bookings";
import { useLeftOver } from "./just-booked";
import { byPeriod } from "./times";

/**
 * What the choices and the details form share (#103): a refusal can take the chosen
 * time away, or swap it, without a new page, and the grid has to say the same.
 */
type Steps = {
  /** The time the form would book; none once a refusal has taken it away. */
  time: string | undefined;
  setTime: (time: string | undefined) => void;
  /** Every time left, from the last refusal that said. */
  available: readonly TimeChoice[] | undefined;
  setAvailable: (times: readonly TimeChoice[]) => void;
  pending: boolean;
  setPending: (pending: boolean) => void;
  /** Where the new booking is, until the browser gets there. Never in a URL or markup
   * of this page (just-booked.ts). */
  booked: string | undefined;
  setBooked: (path: string) => void;
  leftOver: boolean;
};

const StepsContext = createContext<Steps | null>(null);

export function useSteps() {
  const steps = use(StepsContext);
  if (!steps) throw new Error("useSteps outside BookingSteps");
  return steps;
}

export function BookingSteps({
  action,
  time: firstChoice,
  initialAvailable,
  className,
  children,
}: {
  action: string;
  /** The time in the URL, when it can be booked: only then is there a form. */
  time: string | undefined;
  initialAvailable?: readonly TimeChoice[];
  className?: string;
  children: ReactNode;
}) {
  const [time, setTime] = useState(firstChoice);
  const [available, setAvailable] = useState(initialAvailable);
  const [pending, setPending] = useState(false);
  const [booked, setBooked] = useState<string>();
  const leftOver = useLeftOver(action) && firstChoice !== undefined;
  return (
    <StepsContext
      value={{ time, setTime, available, setAvailable, pending, setPending, booked, setBooked, leftOver }}
    >
      <div className={className}>{children}</div>
    </StepsContext>
  );
}

/** Party, date and times: not to be touched mid-confirm, and gone once it has booked. */
export function Choices({ children }: { children: ReactNode }) {
  const { pending, booked, leftOver } = useSteps();
  return (
    <div
      inert={pending}
      hidden={booked !== undefined || leftOver}
      className="flex flex-col gap-7 inert:opacity-60"
    >
      {children}
    </div>
  );
}

/** A row that scrolls sideways on a phone, and starts where its chosen option can be seen. */
export function ChoiceRow({ children, className }: { children: ReactNode; className: string }) {
  const row = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = row.current;
    const chosen = element?.querySelector("input:checked")?.closest("label");
    if (!element || !chosen) return;
    const within = chosen.getBoundingClientRect();
    const frame = element.getBoundingClientRect();
    // Sideways only: scrollIntoView could move the page too.
    element.scrollLeft += within.left + within.width / 2 - (frame.left + frame.width / 2);
  }, []);
  return (
    <div ref={row} className={className}>
      {children}
    </div>
  );
}

const timeTile =
  "grid h-11 place-items-center rounded-control border border-line bg-surface font-medium text-ink tabular-nums no-underline transition-colors duration-150 ease-out hover:bg-surface-2 aria-[current]:border-brand aria-[current]:bg-brand aria-[current]:text-brand-ink";

/** The times as plain links, so choosing one needs no script. */
export function TimeGrid({
  party,
  date,
  dateLabel,
  times: loaded,
}: {
  party: number;
  date: string;
  dateLabel: string;
  times: readonly TimeChoice[];
}) {
  const { time: chosen, available } = useSteps();
  const times = available ?? loaded;
  if (times.length === 0) {
    return (
      <div className="flex flex-col gap-1 rounded-card bg-surface-2 p-4">
        <p>{`No tables for ${party} on ${dateLabel}.`}</p>
        <p className="text-body text-ink-2">Try another date.</p>
      </div>
    );
  }
  return byPeriod(times).map(([period, slots]) => (
    <div key={period} className="flex flex-col gap-2">
      <h2 className="text-caption font-semibold text-ink-2">{period}</h2>
      <ul className="m-0 grid list-none grid-cols-4 gap-2 p-0 lg:grid-cols-6">
        {slots.map(({ time }) => (
          <li key={time}>
            {/* #details: on a phone the reload lands on the details. */}
            <a
              href={`?party=${party}&date=${date}&time=${time}#details`}
              aria-current={time === chosen ? "true" : undefined}
              className={timeTile}
            >
              {time}
            </a>
          </li>
        ))}
      </ul>
    </div>
  ));
}
