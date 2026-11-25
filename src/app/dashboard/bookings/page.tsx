import type { Metadata } from "next";
import { Suspense } from "react";
import { BookingsScreen } from "./bookings-screen";

export const metadata: Metadata = { title: "Bookings" };

export default function Page({ searchParams }: PageProps<"/dashboard/bookings">) {
  return (
    <main className="flex flex-col gap-5">
      <Suspense fallback={<p className="text-ink-2">Loading…</p>}>
        <BookingsScreen searchParams={searchParams} />
      </Suspense>
    </main>
  );
}
