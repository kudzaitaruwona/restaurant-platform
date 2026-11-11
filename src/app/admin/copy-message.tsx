"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { pressable } from "../motion";

type Copied = "idle" | "copied" | "selected";

const labels: Record<Copied, string> = {
  idle: "Copy message for WhatsApp",
  copied: "Copied",
  selected: "Selected. Copy it now",
};

/**
 * A ready-to-send message and a button that copies it. Where the clipboard is
 * refused (an insecure origin, an old browser), the text is selected instead so
 * a keyboard copy or a long-press takes it.
 */
export function CopyMessage({ text }: { text: string }) {
  const id = useId();
  const box = useRef<HTMLParagraphElement>(null);
  const [state, setState] = useState<Copied>("idle");

  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), state === "copied" ? 1600 : 4000);
    return () => clearTimeout(timer);
  }, [state]);

  function selectText() {
    const node = box.current;
    const selection = window.getSelection();
    if (!node || !selection) return;
    const range = document.createRange();
    range.selectNodeContents(node);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  async function copy() {
    try {
      if (!navigator.clipboard) throw new Error("no clipboard");
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      selectText();
      setState("selected");
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <p
        id={id}
        ref={box}
        className="rounded-control border border-line bg-surface-2 px-3 py-2.5 text-body whitespace-pre-wrap select-all"
      >
        {text}
      </p>
      <Button
        type="button"
        variant="secondary"
        size="compact"
        aria-describedby={id}
        onClick={copy}
        className={`self-start ${pressable}`}
      >
        {state === "copied" ? <Check aria-hidden /> : <Copy aria-hidden />}
        <span aria-live="polite">{labels[state]}</span>
      </Button>
    </div>
  );
}
