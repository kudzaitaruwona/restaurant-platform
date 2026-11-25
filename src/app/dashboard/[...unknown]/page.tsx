import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { getTenantContext } from "@/lib/tenant";

export const metadata: Metadata = { title: "Page not found" };

/** Signed out comes first, as on every staff page, so this says nothing to strangers. */
async function Unknown(): Promise<never> {
  await getTenantContext();
  notFound();
}

/** An address under /dashboard that is no page: the 404 keeps the shell. */
export default function Page() {
  return (
    <Suspense>
      <Unknown />
    </Suspense>
  );
}
