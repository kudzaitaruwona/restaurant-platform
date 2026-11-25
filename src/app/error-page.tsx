"use client";

import { TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { pressable } from "./motion";
import { StatusPage } from "./status-page";

/**
 * What an error boundary shows. Never the error's own words: they can hold
 * anything. The digest matches the server's log.
 */
export function ErrorPage({
  error,
  retry,
  home,
}: {
  error: unknown;
  retry: () => void;
  home: { href: string; label: string };
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  const digest = error instanceof Error ? (error as { digest?: unknown }).digest : undefined;

  return (
    <StatusPage
      icon={<TriangleAlert strokeWidth={1.75} />}
      title="Something went wrong"
      actions={
        <>
          <button
            type="button"
            onClick={() => retry()}
            className={cn(buttonVariants({ size: "staff", className: "w-full" }), pressable)}
          >
            Try again
          </button>
          <Link
            href={home.href}
            className={cn(buttonVariants({ variant: "secondary", size: "staff", className: "w-full" }), pressable)}
          >
            {home.label}
          </Link>
        </>
      }
      footer={typeof digest === "string" ? `Error code ${digest}` : undefined}
    >
      This page didn&apos;t load. Check your connection and try again.
    </StatusPage>
  );
}
