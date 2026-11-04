"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

/** Sign-out is a POST, and Better Auth answers it with JSON, so not a plain form. */
export function SignOutButton({ audience }: { audience: "staff" | "admin" }) {
  const router = useRouter();

  async function signOut() {
    await fetch(`/api/auth/${audience}/sign-out`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    router.replace(audience === "admin" ? "/login/admin" : "/login");
  }

  return (
    <Button variant="outline" size="sm" onClick={signOut}>
      Sign out
    </Button>
  );
}
