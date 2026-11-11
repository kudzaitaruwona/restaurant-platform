import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BookingMetrics } from "@/lib/booking-metrics";
import { BookingMetricsPanel } from "./booking-metrics";

const none: BookingMetrics = {
  online: 0,
  staff: 0,
  onlineShare: null,
  outsideHours: 0,
  noShows: 0,
  attended: 0,
  noShowRate: null,
};

const text = (metrics: BookingMetrics) =>
  renderToStaticMarkup(<BookingMetricsPanel metrics={metrics} />)
    .replaceAll("&#x27;", "'")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");

describe("the booking metrics panel", () => {
  it("shows the three numbers, with what they are made of", () => {
    const shown = text({
      online: 3,
      staff: 1,
      onlineShare: 0.75,
      outsideHours: 2,
      noShows: 1,
      attended: 4,
      noShowRate: 0.25,
    });

    expect(shown).toContain("Booked online 75% 3 online, 1 added by staff");
    expect(shown).toContain("Booked while staff weren't answering 2");
    expect(shown).toContain("No-show rate 25% 1 of 4 finished bookings");
  });

  it("says there's nothing yet, rather than 0%, before there are bookings", () => {
    const shown = text(none);

    expect(shown).not.toContain("0%");
    expect(shown).not.toMatch(/[–—]/);
    expect(shown).toContain("Booked online Not yet No bookings yet");
    expect(shown).toContain("No-show rate Not yet No finished bookings yet");
  });

  it("shows a real 0% no-show rate as 0%", () => {
    expect(text({ ...none, attended: 5, noShowRate: 0 })).toContain("No-show rate 0% 0 of 5");
  });
});
