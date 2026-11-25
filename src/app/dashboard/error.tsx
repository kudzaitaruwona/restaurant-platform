"use client";

import { ErrorPage } from "../error-page";

/** Inside the staff shell, so the navigation stays. */
export default function DashboardError({ error, retry }: { error: unknown; retry: () => void }) {
  return <ErrorPage error={error} retry={retry} home={{ href: "/dashboard", label: "Go to Home" }} />;
}
