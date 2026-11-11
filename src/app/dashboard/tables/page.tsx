import { Suspense } from "react";
import { TablesScreen } from "./tables-screen";

export default function Page() {
  return (
    <main className="flex w-full flex-1 flex-col">
      <Suspense fallback={<p className="text-ink-2">Loading…</p>}>
        <TablesScreen />
      </Suspense>
    </main>
  );
}
