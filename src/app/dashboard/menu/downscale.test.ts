import { afterEach, describe, expect, it, vi } from "vitest";
import { downscalePhoto, MAX_EDGE, scaledSize } from "./downscale";

describe("scaledSize", () => {
  it.each([
    [4032, 3024, { width: 1600, height: 1200 }],
    [3024, 4032, { width: 1200, height: 1600 }],
    [1600, 1600, { width: 1600, height: 1600 }],
    [800, 600, { width: 800, height: 600 }],
  ])("%ix%i becomes %j: the long edge is at most MAX_EDGE, never enlarged", (w, h, expected) => {
    expect(scaledSize(w, h)).toEqual(expected);
    expect(MAX_EDGE).toBe(1600);
  });
});

describe("downscalePhoto", () => {
  afterEach(() => vi.unstubAllGlobals());

  const original = (bytes: number) =>
    new File([new Uint8Array(bytes)], "IMG_0001.HEIC", { type: "image/heic" });

  function stubCanvas(photo: { width: number; height: number }, jpegBytes: number) {
    const drawn: number[][] = [];
    const toBlob = vi.fn((callback: (blob: Blob | null) => void, type: string) =>
      callback(new Blob([new Uint8Array(jpegBytes)], { type })),
    );
    vi.stubGlobal("createImageBitmap", async () => ({ ...photo, close() {} }));
    vi.stubGlobal("document", {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({
          drawImage: (_image: unknown, x: number, y: number, w: number, h: number) =>
            drawn.push([x, y, w, h]),
        }),
        toBlob,
      }),
    });
    return { drawn, toBlob };
  }

  it("redraws a 12MP phone photo at 1600px as a JPEG well under Vercel's limit", async () => {
    const { drawn, toBlob } = stubCanvas({ width: 4032, height: 3024 }, 400_000);

    const result = await downscalePhoto(original(9_000_000));

    expect(drawn).toEqual([[0, 0, 1600, 1200]]);
    expect(toBlob.mock.calls[0].slice(1)).toEqual(["image/jpeg", 0.85]);
    expect(result.type).toBe("image/jpeg");
    expect(result.name).toBe("photo.jpg");
    expect(result.size).toBe(400_000);
  });

  it("keeps a small photo as it is", async () => {
    stubCanvas({ width: 800, height: 600 }, 50_000);
    const file = original(200_000);
    expect(await downscalePhoto(file)).toBe(file);
  });

  it("sends the original when the browser can't decode it, and the server decides", async () => {
    vi.stubGlobal("createImageBitmap", async () => {
      throw new Error("can't decode");
    });
    const file = original(3_000_000);
    expect(await downscalePhoto(file)).toBe(file);
  });

  it("sends the original when the browser has no createImageBitmap", async () => {
    vi.stubGlobal("createImageBitmap", undefined);
    const file = original(3_000_000);
    expect(await downscalePhoto(file)).toBe(file);
  });
});
