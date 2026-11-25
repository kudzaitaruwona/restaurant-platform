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

  describe("the bytes of an uploaded file are read here, not trusted from the browser", () => {
    const upload = async (bytes: Uint8Array | string, intent = "preview") => {
      const file = new File([bytes as BlobPart], "menu.csv", { type: "text/csv" });
      return readImportRequest(post({ csv: file, intent }));
    };
    const refusal = async (answer: unknown) => {
      expect(answer).toBeInstanceOf(Response);
      const response = answer as Response;
      expect(response.status).toBe(400);
      return ((await response.json()) as { error: string }).error;
    };

    it("reads UTF-8 accents as they are, with or without a byte order mark", async () => {
      expect(await upload("name\nCr\u00e8me")).toEqual({ csv: "name\nCr\u00e8me", intent: "preview" });
      const withBom = Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("name\nCr\u00e8me")]);
      expect(await upload(withBom)).toEqual({ csv: "name\nCr\u00e8me", intent: "preview" });
    });

    it("refuses a Windows-1252 file, whose accents would be corrupted, saying how to save it", async () => {
      // "Crème" in Windows-1252: the e-grave is the single byte 0xE8.
      const error = await refusal(await upload(Uint8Array.from([0x6e, 0x0a, 0x43, 0x72, 0xe8, 0x6d, 0x65])));
      expect(error).toBe(
        "This file isn't saved as UTF-8, so accented letters would be damaged. Save it as CSV UTF-8 and choose it again.",
      );
    });

    it("refuses a UTF-16 file, with or without its byte order mark", async () => {
      const le = Uint8Array.from([0xff, 0xfe, ...[..."a,b\n1,2"].flatMap((c) => [c.charCodeAt(0), 0])]);
      const be = Uint8Array.from([0xfe, 0xff, ...[..."a,b\n1,2"].flatMap((c) => [0, c.charCodeAt(0)])]);
      const bare = Uint8Array.from([..."a,b\n1,2"].flatMap((c) => [c.charCodeAt(0), 0]));
      for (const bytes of [le, be]) {
        expect(await refusal(await upload(bytes))).toBe(
          "This file is saved as UTF-16. Save it as CSV UTF-8 and choose it again.",
        );
      }
      expect(await refusal(await upload(bare))).toBe("That isn't a CSV file. Choose a .csv file, or paste the rows.");
    });

    it("refuses a PNG with a plain message, not a header error", async () => {
      const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
      expect(await refusal(await upload(png))).toBe("That isn't a CSV file. Choose a .csv file, or paste the rows.");
    });

    it("refuses an empty file, and one that is only spaces", async () => {
      expect(await refusal(await upload(new Uint8Array()))).toBe("That file is empty.");
      expect(await refusal(await upload("  \n "))).toBe("That file is empty.");
    });

    it("refuses an oversized file with 413 before decoding it", async () => {
      const answer = (await upload(new Uint8Array(CSV_MAX_BYTES + 1).fill(97))) as Response;
      expect(answer.status).toBe(413);
    });
  });

  describe("pasted text", () => {
    it("is refused when it carries the replacement character a bad decoding leaves", async () => {
      const answer = (await readImportRequest(post({ csv: "name\nCr\ufffdme", intent: "preview" }))) as Response;
      expect(answer.status).toBe(400);
      expect(((await answer.json()) as { error: string }).error).toBe(
        "This text has a character that couldn't be read (\ufffd), so letters were damaged on the way in. Paste it again, or save the file as CSV UTF-8 and choose the file.",
      );
    });

    it("is refused when it is only spaces", async () => {
      const answer = (await readImportRequest(post({ csv: "  ", intent: "preview" }))) as Response;
      expect(answer.status).toBe(400);
    });
  });

  it("refuses a body with no declared length once it passes the limit, without reading the rest", async () => {
    let pulled = 0;
    const chunk = new Uint8Array(256 * 1024).fill(97);
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(chunk);
      },
    });
    const request = new Request("http://localhost/api/menu/import", {
      method: "POST",
      body: endless,
      headers: { "content-type": "multipart/form-data; boundary=x" },
      duplex: "half",
    } as RequestInit);
    expect(request.headers.get("content-length")).toBeNull();

    const answer = (await readImportRequest(request)) as Response;

    expect(answer.status).toBe(413);
    expect(pulled * chunk.byteLength).toBeLessThan(CSV_MAX_BYTES * 2);
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
