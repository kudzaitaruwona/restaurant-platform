import { Suspense } from "react";
import { StaffScreen } from "./staff-screen";

export default function Page() {
  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-6 px-4 py-12">
      <Suspense fallback={<p className="text-muted-foreground">Loading…</p>}>
        <StaffScreen />
      </Suspense>
    </main>
  );
}
