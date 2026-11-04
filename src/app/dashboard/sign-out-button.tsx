"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";

type Audience = "staff" | "admin";

/**
 * Sign-out is a POST, and Better Auth answers it with JSON, so not a plain form.
 * Goes to the sign-in page only if the session really ended: on a shared tablet,
 * a login page over a live session is worse than an error. Returns what went
 * wrong, if anything.
 */
export async function signOut(audience: Audience, go: (page: string) => void) {
  try {
    const response = await fetch(`/api/auth/${audience}/sign-out`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (!response.ok) return "That didn't work, so you're still signed in. Try again.";
  } catch {
    return "We couldn't reach the server, so you may still be signed in. Try again.";
  }
  go(audience === "admin" ? "/login/admin" : "/login");
}

export function SignOutButton({ audience }: { audience: Audience }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string>();

  async function click() {
    setPending(true);
    setProblem(undefined);
    const failure = await signOut(audience, (page) => router.replace(page));
    if (!failure) return; // stays pending until the sign-in page replaces this one
    setProblem(failure);
    setPending(false);
  }

  return (
    <div className="flex flex-col gap-2">
      <Button variant="outline" size="sm" disabled={pending} onClick={click}>
        {pending ? "Signing out…" : "Sign out"}
      </Button>
      {problem && (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}
    </div>
  );
}
