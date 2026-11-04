import { Suspense } from "react";
import { BookingsScreen } from "./bookings-screen";

export default function Page({ searchParams }: PageProps<"/dashboard/bookings">) {
  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-6 px-4 py-12">
      <Suspense fallback={<p className="text-muted-foreground">Loading…</p>}>
        <BookingsScreen searchParams={searchParams} />
      </Suspense>
    </main>
  );
}
