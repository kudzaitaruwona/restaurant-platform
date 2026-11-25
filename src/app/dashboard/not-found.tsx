import { SearchX } from "lucide-react";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { pressable } from "../motion";
import { StatusPage } from "../status-page";

/** notFound() from a staff page, inside the shell. */
export default function NotFound() {
  return (
    <StatusPage
      icon={<SearchX strokeWidth={1.75} />}
      title="Page not found"
      actions={
        <Link href="/dashboard" className={cn(buttonVariants({ size: "staff", className: "w-full" }), pressable)}>
          Go to Home
        </Link>
      }
    >
      There&apos;s nothing at that address, or it has been removed. If someone sent you here, ask them for a new link.
    </StatusPage>
  );
}
