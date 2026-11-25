import type { Metadata } from "next";
import { Suspense } from "react";
import { NewBookingScreen } from "./new-booking-screen";

export const metadata: Metadata = { title: "New booking" };

export default function Page({ searchParams }: PageProps<"/dashboard/bookings/new">) {
  return (
    <main className="flex flex-col gap-5">
      <Suspense fallback={<p className="text-ink-2">Loading…</p>}>
        <NewBookingScreen searchParams={searchParams} />
      </Suspense>
    </main>
  );
}
