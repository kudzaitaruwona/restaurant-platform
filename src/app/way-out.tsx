"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { buttonVariants } from "@/components/ui/button";
import { signInHref, signInPages } from "@/lib/auth/return-to";
import { cn } from "@/lib/utils";
import { pressable } from "./motion";

/**
 * The parts of the signed-out and no-access pages that depend on the address.
 * In the browser because Next.js renders those pages into every route's payload:
 * asking who is signed in there would cost every page, guests' included.
 */

const isAdminPath = (pathname: string | null) =>
  pathname === "/admin" || Boolean(pathname?.startsWith("/admin/"));

const button = (variant: "primary" | "secondary") =>
  cn(buttonVariants({ variant, size: "staff", className: "w-full" }), pressable);

const quietLink = "font-medium text-ink underline underline-offset-4";

/** Sign in as whoever this page is for, and come back to it. */
export function SignInLink() {
  const href = signInHref(usePathname(), useSearchParams().toString());
  return (
    <Link href={href} className={button("primary")}>
      Sign in
    </Link>
  );
}

/** The other way in, in case it's the wrong one. */
export function OtherSignIn() {
  return isAdminPath(usePathname()) ? (
    <>
      Work at a restaurant?{" "}
      <Link href={signInPages.staff} className={quietLink}>
        Staff sign-in
      </Link>
    </>
  ) : (
    <>
      Run the platform?{" "}
      <Link href={signInPages.admin} className={quietLink}>
        Platform admin sign-in
      </Link>
    </>
  );
}

export function NoAccessReason() {
  return isAdminPath(usePathname()) ? (
    <>This page is for the team that runs the platform. If you need something from it, ask them.</>
  ) : (
    <>You&apos;re signed in as a platform admin. Enter a restaurant from the admin console first.</>
  );
}

export function NoAccessLink() {
  return isAdminPath(usePathname()) ? (
    <Link href="/dashboard" className={button("primary")}>
      Go to your dashboard
    </Link>
  ) : (
    <Link href="/admin" className={button("primary")}>
      Go to the admin console
    </Link>
  );
}
