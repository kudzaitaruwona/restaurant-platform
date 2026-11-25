import { ShieldX } from "lucide-react";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { pressable } from "../motion";
import { StatusPage } from "../status-page";

/** forbidden() from a staff page, inside the shell: an owner-only page (S-26). */
export default function Forbidden() {
  return (
    <StatusPage
      icon={<ShieldX strokeWidth={1.75} />}
      title="Only an owner can open this page"
      actions={
        <Link href="/dashboard" className={cn(buttonVariants({ size: "staff", className: "w-full" }), pressable)}>
          Go to Home
        </Link>
      }
    >
      Ask an owner of your restaurant if you need something changed here, or to make you an owner.
    </StatusPage>
  );
}
