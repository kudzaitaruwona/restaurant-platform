import type { Metadata } from "next";
import { Suspense } from "react";
import { BookingSettingsScreen } from "./booking-settings-screen";

export const metadata: Metadata = { title: "Booking settings" };

export default function Page() {
  return (
    <main className="flex flex-col gap-5">
      <Suspense fallback={<p className="text-ink-2">Loading…</p>}>
        <BookingSettingsScreen />
      </Suspense>
    </main>
  );
}
