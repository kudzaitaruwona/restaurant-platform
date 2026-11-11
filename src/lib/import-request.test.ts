import { describe, expect, it } from "vitest";
import { CSV_MAX_BYTES } from "./csv";
import { importAnswer, readImportRequest } from "./import-request";

const post = (fields: Record<string, string | Blob>, headers?: Record<string, string>) => {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return new Request("http://localhost/api/menu/import", { method: "POST", body, headers });
};

describe("readImportRequest", () => {
  it("reads the pasted text and what to do with it", async () => {
    // A form's text fields arrive with CRLF line breaks, which the parser takes.
    expect(await readImportRequest(post({ csv: "a,b\n1,2", intent: "preview" }))).toEqual({
      csv: "a,b\r\n1,2",
      intent: "preview",
    });
  });

  it("reads an uploaded file as UTF-8 text", async () => {
    const file = new File(["\uFEFFa,b\n1,2"], "menu.csv", { type: "text/csv" });
    const input = await readImportRequest(post({ csv: file, intent: "confirm" }));
    // Decoding drops the byte order mark; the parser strips one anyway.
    expect(input).toEqual({ csv: expect.stringMatching(/^\uFEFF?a,b\n1,2$/), intent: "confirm" });
  });

  it("answers 400 for anything but preview or confirm", async () => {
    const answer = await readImportRequest(post({ csv: "a", intent: "delete" }));
    expect(answer).toBeInstanceOf(Response);
    expect((answer as Response).status).toBe(400);
  });

  it("answers 400 with no CSV", async () => {
    const answer = (await readImportRequest(post({ intent: "preview" }))) as Response;
    expect(answer.status).toBe(400);
    expect(await answer.json()).toEqual({ error: "Choose a CSV file or paste one." });
  });

  it("answers 413 for a CSV over 1 MB", async () => {
    const answer = (await readImportRequest(
      post({ csv: "x".repeat(CSV_MAX_BYTES + 1), intent: "preview" }),
    )) as Response;
    expect(answer.status).toBe(413);
    expect(await answer.json()).toEqual({ error: "The file is over 1 MB. Split it and import each part." });
  });

  it("answers 413 before reading a body that says it is far too big", async () => {
    const answer = (await readImportRequest(
      post({ csv: "a", intent: "preview" }, { "content-length": String(CSV_MAX_BYTES * 3) }),
    )) as Response;
    expect(answer.status).toBe(413);
  });
});

describe("importAnswer", () => {
  it("is 400 with the reason for a file it can't read", async () => {
    const answer = importAnswer({ error: "The file is empty." });
    expect(answer.status).toBe(400);
    expect(await answer.json()).toEqual({ error: "The file is empty." });
  });

  it("is 200 with the report otherwise", async () => {
    const report = { columns: [], rows: [], ready: 0, imported: null };
    const answer = importAnswer(report);
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual(report);
  });
});
