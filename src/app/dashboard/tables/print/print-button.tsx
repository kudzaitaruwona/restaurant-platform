"use client";

import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Opens the browser's print dialog: the same as Ctrl+P, one tap on a tablet. */
export function PrintButton() {
  return (
    <Button type="button" size="staff" onClick={() => window.print()}>
      <Printer aria-hidden />
      Print
    </Button>
  );
}
