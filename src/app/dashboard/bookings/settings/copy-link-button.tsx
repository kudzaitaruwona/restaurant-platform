"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * Copies the booking link. A client control, so it lives on the staff screen
 * only, never a public page (S-32). Where the clipboard is refused, the link is
 * still in a field beside it to select by hand.
 */
export function CopyLinkButton({ text }: { text: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <Button type="button" variant="secondary" size="staff" className="self-start" onClick={copy}>
        {state === "copied" ? <Check aria-hidden className="text-accent" /> : <Copy aria-hidden />}
        {state === "copied" ? "Copied" : "Copy link"}
      </Button>
      {state === "failed" && (
        <p role="alert" className="text-caption text-danger">
          Couldn&apos;t copy. Select the link above and copy it yourself.
        </p>
      )}
    </div>
  );
}
