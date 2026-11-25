import type { TimeChoice } from "@/lib/bookings";

/** Times under their period's name, in the order given. No Map.groupBy: older phones lack it. */
export function byPeriod(times: readonly TimeChoice[]) {
  const groups = new Map<string, TimeChoice[]>();
  for (const time of times) {
    const group = groups.get(time.period);
    if (group) group.push(time);
    else groups.set(time.period, [time]);
  }
  return [...groups];
}
