import { ShieldX } from "lucide-react";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { pressable } from "./motion";
import { StatusPage } from "./status-page";

/** What forbidden() shows: signed in, but not as someone who may see this page. */
export default function Forbidden() {
  return (
    <StatusPage
      icon={<ShieldX strokeWidth={1.75} />}
      title="You can't open this page"
      actions={
        <Link href="/" className={cn(buttonVariants({ variant: "secondary", size: "staff", className: "w-full" }), pressable)}>
          Go to the start
        </Link>
      }
    >
      Your account doesn&apos;t have access to it.
    </StatusPage>
  );
}
