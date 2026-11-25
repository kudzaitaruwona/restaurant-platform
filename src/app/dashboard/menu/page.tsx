import type { Metadata } from "next";
import { Suspense } from "react";
import { MenuScreen } from "./menu-screen";

export const metadata: Metadata = { title: "Menu" };

export default function Page() {
  return (
    <main className="flex w-full flex-1 flex-col">
      <Suspense fallback={<p className="text-ink-2">Loading…</p>}>
        <MenuScreen />
      </Suspense>
    </main>
  );
}
