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

/** The body's bytes, or null once more than `limit` have arrived. */
async function readCapped(request: Request, limit: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

export async function readImportRequest(
  request: Request,
): Promise<{ csv: string; intent: ImportIntent } | Response> {
  const limit = CSV_MAX_BYTES + BODY_SLACK;
  // A body that declares itself too big is refused unread.
  if (Number(request.headers.get("content-length")) > limit) return tooBig();
  // One that declares nothing (chunked) or lies is counted as it arrives and
  // dropped past the limit, so the server never buffers more than that.
  const body = await readCapped(request, limit);
  if (body === null) return tooBig();
  const form = await new Response(body, {
    headers: { "content-type": request.headers.get("content-type") ?? "" },
  })
    .formData()
    .catch(() => new FormData());
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
