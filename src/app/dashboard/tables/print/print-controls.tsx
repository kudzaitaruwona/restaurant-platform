"use client";

import { Printer } from "lucide-react";
import { createContext, useContext, useLayoutEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { ChoiceChip } from "@/components/ui/chip";

/**
 * The sheet's controls, which share one fact: whether the form has been changed
 * since the sheet on screen was made. While it has, the sheet is stale, so Print
 * is off (and the cards are hidden from Ctrl+P too, see PRINT_CSS) until "Update
 * the sheet" shows what was asked for.
 */
const StaleContext = createContext(false);
const SetStaleContext = createContext<(stale: boolean) => void>(() => {});

export function PrintControls({ children }: { children: ReactNode }) {
  const [stale, setStale] = useState(false);
  return (
    <StaleContext value={stale}>
      <SetStaleContext value={setStale}>
        <div className="contents" data-print-stale={stale ? "" : undefined}>
          {children}
        </div>
      </SetStaleContext>
    </StaleContext>
  );
}

/**
 * The sheet's page-level CSS (@page, and the rules that make the shell print
 * black on white), present only while the sheet is on screen. Under
 * cacheComponents a page left behind is kept mounted but hidden (Activity), and
 * its <style> elements keep applying: printing another dashboard page would take
 * the sheet's @page and shell rules. Activity runs layout-effect cleanups when it
 * hides a tree and the effects again when it shows it, so the styles are dropped
 * while hidden. The first render keeps them, so the server's HTML (and a visit
 * without JavaScript) has them.
 */
export function PrintStyles({ css }: { css: string[] }) {
  const [shown, setShown] = useState(true);
  useLayoutEffect(() => {
    // Re-showing is the only time this runs again, and it must restore the styles.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setShown(true);
    return () => setShown(false);
  }, []);
  return shown ? css.map((rules) => <style key={rules}>{rules}</style>) : null;
}

/** Opens the browser's print dialog: the same as Ctrl+P, one tap on a tablet. */
export function PrintButton() {
  const stale = useContext(StaleContext);
  return (
    <div className="flex flex-col items-end gap-1">
      <Button type="button" size="staff" disabled={stale} onClick={() => window.print()}>
        <Printer aria-hidden />
        Print
      </Button>
      {stale && <p className="text-caption text-ink-2">Update the sheet first</p>}
    </div>
  );
}

/** The plain GET form; any change to it makes the sheet stale. */
export function PrintForm({ children }: { children: ReactNode }) {
  const setStale = useContext(SetStaleContext);
  return (
    <form
      method="get"
      action="/dashboard/tables/print"
      className="flex flex-col gap-5"
      onChange={() => setStale(true)}
    >
      {children}
    </form>
  );
}

export type Scope = "all" | "selected";
export type Picked = { scope: Scope; ids: string[] };

/** Ticking a table means "only the tables ticked": it picks that scope itself. */
export function pickTable(state: Picked, id: string, ticked: boolean): Picked {
  const ids = ticked ? [...new Set([...state.ids, id])] : state.ids.filter((x) => x !== id);
  return { scope: ticked ? "selected" : state.scope, ids };
}

export function TablePicker({
  tables,
  scope,
  tableIds,
}: {
  tables: { id: string; label: string }[];
  scope: Scope;
  tableIds: string[];
}) {
  const [picked, setPicked] = useState<Picked>({ scope, ids: tableIds });
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-2 text-lead font-semibold">Tables</legend>
      <div className="flex flex-wrap gap-2">
        <ChoiceChip
          name="scope"
          value="all"
          checked={picked.scope === "all"}
          onChange={() => setPicked({ ...picked, scope: "all" })}
        >
          All tables
        </ChoiceChip>
        <ChoiceChip
          name="scope"
          value="selected"
          checked={picked.scope === "selected"}
          onChange={() => setPicked({ ...picked, scope: "selected" })}
        >
          Only the tables ticked here
        </ChoiceChip>
      </div>
      <ul className="flex flex-wrap gap-2" aria-label="Tables to print">
        {tables.map((table) => (
          <li key={table.id}>
            <ChoiceChip
              type="checkbox"
              name="table"
              value={table.id}
              checked={picked.ids.includes(table.id)}
              onChange={(event) => setPicked(pickTable(picked, table.id, event.target.checked))}
              className="[&>span]:min-h-10 [&>span]:min-w-12 [&>span]:px-3.5"
            >
              {table.label}
            </ChoiceChip>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}
