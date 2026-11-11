import { SearchX } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { pressable } from "./motion";
import { StatusPage } from "./status-page";

export const metadata: Metadata = { title: "Page not found" };

/** Any unknown address, and notFound() where no nearer page says more. */
export default function NotFound() {
  return (
    <StatusPage
      icon={<SearchX strokeWidth={1.75} />}
      title="Page not found"
      actions={
        <Link href="/" className={cn(buttonVariants({ variant: "secondary", size: "staff", className: "w-full" }), pressable)}>
          Go to the start
        </Link>
      }
    >
      That address doesn&apos;t lead anywhere. Check it, or go back to the start.
    </StatusPage>
  );
}
