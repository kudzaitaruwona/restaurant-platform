import { Suspense } from "react";
import { PrintSheet } from "./print-sheet";

export default function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return (
    <main
      data-print-sheet
      className="flex w-full max-w-4xl flex-1 flex-col gap-6 print:max-w-none print:gap-0 print:p-0"
    >
      <Suspense fallback={<p className="text-ink-2">Loading…</p>}>
        <PrintSheet searchParams={searchParams} />
      </Suspense>
    </main>
  );
}
