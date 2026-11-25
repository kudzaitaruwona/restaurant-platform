import type { Metadata } from "next";
import { Suspense } from "react";
import { TableDetailScreen } from "../table-detail-screen";

export const metadata: Metadata = { title: "Table" };

async function Detail({ params }: { params: Promise<{ tableId: string }> }) {
  return <TableDetailScreen tableId={(await params).tableId} />;
}

export default function Page({ params }: PageProps<"/dashboard/floor/[tableId]">) {
  return (
    <main className="flex min-h-full flex-col">
      <Suspense fallback={<p className="text-ink-2">Loading…</p>}>
        <Detail params={params} />
      </Suspense>
    </main>
  );
}
