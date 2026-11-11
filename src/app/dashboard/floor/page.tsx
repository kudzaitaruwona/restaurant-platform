import { Suspense } from "react";
import { FloorScreen } from "./floor-screen";

export default function Page() {
  return (
    <main className="flex min-h-full flex-col gap-5">
      <Suspense fallback={<p className="text-ink-2">Loading…</p>}>
        <FloorScreen />
      </Suspense>
    </main>
  );
}
