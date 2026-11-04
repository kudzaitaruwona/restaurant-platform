"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

/** Sign-out is a POST, and Better Auth answers it with JSON, so not a plain form. */
export function SignOutButton() {
  const router = useRouter();

  async function signOut() {
    await fetch("/api/auth/staff/sign-out", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    router.replace("/login");
  }

  return (
    <Button variant="outline" size="sm" onClick={signOut}>
      Sign out
    </Button>
  );
}
