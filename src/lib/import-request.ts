import { byteLength, CSV_MAX_BYTES } from "./csv";
import type { ImportReport } from "./csv-import";

/**
 * The request and answer every import route shares (S-43). The dialog posts
 * the CSV twice: with intent=preview, which writes nothing, then with
 * intent=confirm, which checks every row again and imports. Nothing from the
 * preview is trusted at confirm.
 */

export type ImportIntent = "preview" | "confirm";

const tooBig = () =>
  Response.json({ error: "The file is over 1 MB. Split it and import each part." }, { status: 413 });

/** Room for the form's own framing around a CSV at the limit. */
const BODY_SLACK = 64 * 1024;

export async function readImportRequest(
  request: Request,
): Promise<{ csv: string; intent: ImportIntent } | Response> {
  const declared = Number(request.headers.get("content-length"));
  if (declared > CSV_MAX_BYTES + BODY_SLACK) return tooBig();

  const form = await request.formData().catch(() => new FormData());
  const intent = form.get("intent");
  if (intent !== "preview" && intent !== "confirm") {
    return Response.json({ error: "Choose preview or confirm." }, { status: 400 });
  }
  const sent = form.get("csv");
  if (sent instanceof Blob && sent.size > CSV_MAX_BYTES) return tooBig();
  const csv = sent instanceof Blob ? await sent.text() : sent;
  if (!csv) return Response.json({ error: "Choose a CSV file or paste one." }, { status: 400 });
  if (byteLength(csv) > CSV_MAX_BYTES) return tooBig();
  return { csv, intent };
}

/** 400 with the reason for a file that can't be read as a whole; 200 with the report. */
export const importAnswer = (result: ImportReport | { error: string }, refusedStatus = 400) =>
  "error" in result
    ? Response.json({ error: result.error }, { status: refusedStatus })
    : Response.json(result);
