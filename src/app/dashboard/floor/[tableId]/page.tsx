import { Suspense } from "react";
import { TableDetailScreen } from "../table-detail-screen";

async function Detail({ params }: { params: Promise<{ tableId: string }> }) {
  return <TableDetailScreen tableId={(await params).tableId} />;
}

export default function Page({ params }: PageProps<"/dashboard/floor/[tableId]">) {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-12">
      <Suspense fallback={<p className="text-muted-foreground">Loading…</p>}>
        <Detail params={params} />
      </Suspense>
    </main>
  );
}
