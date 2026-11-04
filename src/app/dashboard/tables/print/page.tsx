import { Suspense } from "react";
import { PrintSheet } from "./print-sheet";

export default function Page() {
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 px-4 py-8 print:max-w-none print:p-0">
      <Suspense fallback={<p className="text-muted-foreground">Loading…</p>}>
        <PrintSheet />
      </Suspense>
    </main>
  );
}
