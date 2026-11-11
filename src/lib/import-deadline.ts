/**
 * The time a staff or restaurants import may spend on its rows (S-43). Those
 * go one at a time, each with an invite email (up to 10 s) and a 550 ms pause,
 * so a slow email provider could outlast the function; the routes allow 300 s
 * (maxDuration), and stopping at 240 s leaves room for the row in progress and
 * for the report, so the report always comes back.
 */
export const IMPORT_TIME_BUDGET_MS = 240_000;

/** On each row the deadline stopped: importing the file again adds it. */
export const notImportedInTime =
  "Not imported: the import stopped here to finish in time. Import the file again to add this row; rows already added will be skipped.";

export type ImportTiming = {
  /** Asked before each row is started; once true, no further row is. */
  outOfTime?: () => boolean;
};

/** Out of time once `ms` have passed from now. */
export function deadlineIn(ms: number) {
  const end = Date.now() + ms;
  return () => Date.now() >= end;
}
