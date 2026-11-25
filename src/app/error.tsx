"use client";

import { ErrorPage } from "./error-page";

export default function RootError({ error, retry }: { error: unknown; retry: () => void }) {
  return <ErrorPage error={error} retry={retry} home={{ href: "/", label: "Go to the start" }} />;
}
