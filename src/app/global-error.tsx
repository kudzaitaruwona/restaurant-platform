"use client";

import "./globals.css";
import { ErrorPage } from "./error-page";

/** The root layout itself failed, so this is the whole document. */
export default function GlobalError({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="flex min-h-full flex-col">
        <title>Something went wrong</title>
        <ErrorPage error={error} retry={retry} home={{ href: "/", label: "Go to the start" }} />
      </body>
    </html>
  );
}
