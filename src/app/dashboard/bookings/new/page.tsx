import { Suspense } from "react";
import { NewBookingScreen } from "./new-booking-screen";

export default function Page({ searchParams }: PageProps<"/dashboard/bookings/new">) {
  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-6 px-4 py-12">
      <Suspense fallback={<p className="text-muted-foreground">Loading…</p>}>
        <NewBookingScreen searchParams={searchParams} />
      </Suspense>
    </main>
  );
}
