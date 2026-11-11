import { LogIn } from "lucide-react";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { StatusPage } from "./status-page";

/** What unauthorized() shows: on /dashboard, usually a session that has ended. */
export default function Unauthorized() {
  return (
    <StatusPage
      icon={<LogIn strokeWidth={1.75} />}
      title="You're signed out"
      actions={
        <Link href="/login" className={cn(buttonVariants({ size: "staff", className: "w-full" }))}>
          Sign in
        </Link>
      }
      footer={
        <>
          Run the platform?{" "}
          <Link href="/login/admin" className="font-medium text-ink underline underline-offset-4">
            Platform admin sign-in
          </Link>
        </>
      }
    >
      Sign in again to carry on.
    </StatusPage>
  );
}
