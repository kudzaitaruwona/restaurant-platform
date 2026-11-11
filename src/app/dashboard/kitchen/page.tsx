import { Suspense } from "react";
import { KitchenScreen } from "./kitchen-screen";

export default function Page() {
  return (
    <main data-page-theme="dark" className="flex flex-1 flex-col">
      <Suspense fallback={<p className="text-ink-2">Loading the board…</p>}>
        <KitchenScreen />
      </Suspense>
    </main>
  );
}
