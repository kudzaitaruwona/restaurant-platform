import { Suspense } from "react";
import { StaffScreen } from "./staff-screen";

export default function Page() {
  return (
    <Suspense fallback={<p className="text-body text-ink-2">Loading…</p>}>
      <StaffScreen />
    </Suspense>
  );
}
