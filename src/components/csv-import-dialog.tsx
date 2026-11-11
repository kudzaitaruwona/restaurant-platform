"use client";

import { Check, Download, FileUp, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, type ReactNode, useId, useRef, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Field, Textarea, inputClassName } from "@/components/ui/input";
import { Notice } from "@/components/ui/notice";
import { byteLength, CSV_MAX_BYTES } from "@/lib/csv";
import type { ImportKind, ImportReport } from "@/lib/csv-import";
import { cn } from "@/lib/utils";

type Step = "choose" | "preview" | "done";

const plural = (count: number, noun: { one: string; other: string }) =>
  `${count} ${count === 1 ? noun.one : noun.other}`;

/**
 * One import flow for every CSV import (S-43): choose a file or paste one, see
 * every row with its problems, then import the valid rows. Nothing is written
 * until "Import"; the server checks every row again then, so what is imported
 * is what the file says at that moment, not what the preview saw. A native
 * modal <dialog>, so focus is held inside and Escape closes it.
 */
export function CsvImportDialog({
  kind,
  action,
  title,
  noun,
  intro,
  triggerLabel = "Import CSV",
  triggerSize = "staff",
}: {
  kind: ImportKind;
  /** The import route, e.g. "/api/menu/import". */
  action: string;
  title: string;
  /** What a row adds: { one: "item", other: "items" }. */
  noun: { one: string; other: string };
  /** What the file holds, in a sentence or two. */
  intro: ReactNode;
  triggerLabel?: string;
  /** staff (48px) on staff pages; compact (40px) in /admin's header. */
  triggerSize?: "staff" | "compact";
}) {
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const id = useId();
  const [step, setStep] = useState<Step>("choose");
  const [csv, setCsv] = useState("");
  const [report, setReport] = useState<ImportReport>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  function open() {
    form.current?.reset();
    setStep("choose");
    setCsv("");
    setReport(undefined);
    setError(undefined);
    dialog.current?.showModal();
  }

  function close() {
    if (pending) return;
    dialog.current?.close();
  }

  async function post(intent: "preview" | "confirm", text: string) {
    setPending(true);
    setError(undefined);
    try {
      const body = new FormData();
      body.set("intent", intent);
      body.set("csv", text);
      const response = await fetch(action, { method: "POST", body });
      const answer = await response.json().catch(() => undefined);
      if (response.ok) return answer as ImportReport;
      setError(answer?.error ?? "That didn't work. Try again.");
    } catch {
      setError("That didn't work. Check your connection and try again.");
    } finally {
      setPending(false);
    }
    return undefined;
  }

  async function check(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const file = data.get("file");
    const pasted = String(data.get("pasted") ?? "");
    const chosen = file instanceof File && file.size > 0;
    if (chosen && file.size > CSV_MAX_BYTES) {
      setError("The file is over 1 MB. Split it and import each part.");
      return;
    }
    // TextDecoder drops a byte order mark; the server strips one too.
    const text = chosen ? await file.text() : pasted;
    if (!text.trim()) {
      setError("Choose a CSV file or paste one.");
      return;
    }
    if (byteLength(text) > CSV_MAX_BYTES) {
      setError("The file is over 1 MB. Split it and import each part.");
      return;
    }
    const preview = await post("preview", text);
    if (!preview) return;
    setCsv(text);
    setReport(preview);
    setStep("preview");
  }

  async function confirm() {
    const result = await post("confirm", csv);
    if (!result) return;
    setReport(result);
    setStep("done");
    if (result.imported) router.refresh();
  }

  const skipped = report ? report.rows.length - report.ready : 0;

  return (
    <>
      <Button type="button" variant="secondary" size={triggerSize} onClick={open}>
        <FileUp aria-hidden />
        {triggerLabel}
      </Button>

      <dialog
        ref={dialog}
        aria-labelledby={`${id}title`}
        className="ui-dialog m-auto flex max-h-[min(720px,calc(100dvh-32px))] w-[min(880px,calc(100vw-32px))] max-w-none flex-col rounded-card border-0 bg-surface p-0 text-body text-ink shadow-float [&:not([open])]:hidden"
        onCancel={(event) => {
          if (pending) event.preventDefault();
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) close();
        }}
      >
        <header className="flex items-start justify-between gap-3 border-b border-line py-3 pr-3 pl-6">
          <h2 id={`${id}title`} className="pt-2 text-title font-semibold">
            {title}
          </h2>
          <IconButton label="Close" icon={<X />} variant="ghost" size="default" onClick={close} />
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-6">
          {step === "choose" && (
            <form ref={form} id={`${id}form`} onSubmit={check} className="flex flex-col gap-4">
              <div className="flex flex-col gap-2 text-ink-2">
                {intro}
                <p>
                  The first row names the columns. Up to 500 rows and 1 MB. Nothing is saved until
                  you check the rows and choose Import.
                </p>
              </div>
              <a
                href={`/api/csv-templates/${kind}`}
                download
                className={cn(buttonVariants({ variant: "ghost", size: "compact" }), "self-start")}
              >
                <Download aria-hidden />
                Download the template
              </a>
              <Field label="CSV file">
                <input
                  type="file"
                  name="file"
                  accept=".csv,text/csv"
                  className={cn(
                    inputClassName,
                    "file:mr-3 file:rounded-control file:border-0 file:bg-surface-2 file:px-3 file:py-1.5 file:text-caption file:font-semibold file:text-ink",
                  )}
                />
              </Field>
              <Field label="Or paste it here">
                <Textarea name="pasted" rows={6} spellCheck={false} className="font-mono text-caption" />
              </Field>
            </form>
          )}

          {step !== "choose" && report && (
            <>
              {step === "preview" ? (
                <Notice tone={report.ready === 0 ? "attention" : "neutral"} role="status">
                  {report.ready === 0
                    ? "No row can be imported. Fix the file and check it again."
                    : `${plural(report.ready, noun)} ready to import.`}
                  {skipped > 0 && report.ready > 0 && ` ${plural(skipped, { one: "row", other: "rows" })} will be skipped.`}
                </Notice>
              ) : (
                <Notice tone={report.imported ? "positive" : "attention"} role="status">
                  {report.imported
                    ? `Imported ${plural(report.imported, noun)}.`
                    : "Nothing was imported."}
                  {skipped > 0 &&
                    ` ${plural(skipped, { one: "row was", other: "rows were" })} skipped. Fix ${skipped === 1 ? "it" : "them"} and import the file again: rows already added are skipped then.`}
                </Notice>
              )}
              <ReportTable report={report} done={step === "done"} />
            </>
          )}

          {error && (
            <Notice tone="danger" role="alert">
              {error}
            </Notice>
          )}
        </div>

        <footer className="flex flex-wrap justify-end gap-3 border-t border-line px-6 py-4">
          {step === "choose" && (
            <>
              <Button type="button" variant="secondary" size="staff" disabled={pending} onClick={close}>
                Cancel
              </Button>
              <Button type="submit" form={`${id}form`} size="staff" disabled={pending}>
                {pending ? "Checking…" : "Check rows"}
              </Button>
            </>
          )}
          {step === "preview" && report && (
            <>
              <Button
                type="button"
                variant="secondary"
                size="staff"
                disabled={pending}
                onClick={() => {
                  setError(undefined);
                  setStep("choose");
                }}
              >
                Back
              </Button>
              <Button type="button" size="staff" disabled={pending || report.ready === 0} onClick={confirm}>
                {pending ? "Importing…" : `Import ${plural(report.ready, { one: "row", other: "rows" })}`}
              </Button>
            </>
          )}
          {step === "done" && (
            <Button type="button" size="staff" onClick={close}>
              Done
            </Button>
          )}
        </footer>
      </dialog>
    </>
  );
}

/** Every row with what will happen to it, or what did. */
export function ReportTable({ report, done }: { report: ImportReport; done: boolean }) {
  return (
    <div className="overflow-x-auto rounded-control border border-line">
      <table className="w-full border-collapse text-left text-caption">
        <thead className="bg-surface-2 text-ink-2">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">
              Line
            </th>
            {report.columns.map((column) => (
              <th key={column} scope="col" className="px-3 py-2 font-medium whitespace-nowrap">
                {column}
              </th>
            ))}
            <th scope="col" className="min-w-56 px-3 py-2 font-medium">
              {done ? "Result" : "Check"}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {report.rows.map((row) => {
            const ok = row.problems.length === 0;
            return (
              <tr key={row.line} className={cn("align-top", !ok && "bg-danger-soft/40")}>
                <td className="px-3 py-2 text-ink-2 tabular-nums">{row.line}</td>
                {row.values.map((value, index) => (
                  <td key={index} className="max-w-48 px-3 py-2 [overflow-wrap:anywhere]">
                    {value}
                  </td>
                ))}
                <td className="px-3 py-2">
                  {ok ? (
                    <span className="inline-flex items-center gap-1 font-semibold text-accent">
                      <Check aria-hidden className="size-4" />
                      {done ? "Imported" : "Ready"}
                    </span>
                  ) : (
                    <ul className="flex flex-col gap-0.5 text-danger">
                      <li className="font-semibold">Skipped</li>
                      {row.problems.map((problem) => (
                        <li key={problem}>{problem}</li>
                      ))}
                    </ul>
                  )}
                  {row.notes.length > 0 && (
                    <ul className="mt-1 flex flex-col gap-0.5 text-ink-2">
                      {row.notes.map((note) => (
                        <li key={note}>{note}</li>
                      ))}
                    </ul>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
