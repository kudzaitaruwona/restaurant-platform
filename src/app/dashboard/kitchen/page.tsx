import { Suspense } from "react";
import { KitchenScreen } from "./kitchen-screen";

export default function Page() {
  return (
    <main className="mx-auto flex w-full max-w-screen-2xl flex-1 flex-col gap-6 px-4 py-6">
      <Suspense fallback={<p className="text-muted-foreground">Loading…</p>}>
        <KitchenScreen />
      </Suspense>
    </main>
  );
}
