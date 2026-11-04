import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  bestFit,
  MAX_UPLOAD_BYTES,
  PhotoRefused,
  resizePhoto,
} from "./photo-image";

/** Noise doesn't compress, so this is a camera photo's worst case for the budget. */
async function noisyJpeg(width: number, height: number, orientation?: number) {
  const pixels = Buffer.alloc(width * height * 3);
  for (let i = 0; i < pixels.length; i++) pixels[i] = Math.floor(Math.random() * 256);
  let image = sharp(pixels, { raw: { width, height, channels: 3 } });
  if (orientation) image = image.withMetadata({ orientation });
  return image.jpeg({ quality: 90 }).toBuffer();
}

const infoOf = (bytes: Uint8Array) => sharp(bytes).metadata();

describe("resizePhoto", () => {
  it("makes an 800px item photo and a 320px square thumbnail, both WebP", async () => {
    const { large, thumb } = await resizePhoto(await noisyJpeg(2400, 1600));

    expect(await infoOf(large)).toMatchObject({ format: "webp", width: 800, height: 533 });
    expect(await infoOf(thumb)).toMatchObject({ format: "webp", width: 320, height: 320 });
  });

  it("aims for under 60KB each, even for a photo that won't compress", async () => {
    const { large, thumb } = await resizePhoto(await noisyJpeg(2400, 1600));

    expect(large.byteLength).toBeLessThan(60 * 1024);
    expect(thumb.byteLength).toBeLessThan(60 * 1024);
  });

  it("ships a photo that compresses at the top quality, not a lower one", async () => {
    const flat = await sharp({
      create: { width: 900, height: 900, channels: 3, background: "#c0803a" },
    })
      .png()
      .toBuffer();
    const { large } = await resizePhoto(flat);
    // 800px is what the pipeline makes of 900px; encode that directly at the top rung.
    const direct = await sharp(flat).resize({ width: 800, height: 800 }).webp({ quality: 82 }).toBuffer();
    expect(large.byteLength).toBe(direct.byteLength);
  });

  it("never enlarges a small photo", async () => {
    const { large } = await resizePhoto(await noisyJpeg(400, 300));
    expect(await infoOf(large)).toMatchObject({ width: 400, height: 300 });
  });

  it("stands a phone's sideways photo upright", async () => {
    // Stored 1200x800 with orientation 6: the phone was held upright.
    const { large } = await resizePhoto(await noisyJpeg(1200, 800, 6));
    const { width, height } = await infoOf(large);
    expect([width, height]).toEqual([533, 800]);
  });

  it("keeps no metadata, so a photo's location doesn't reach the page", async () => {
    const { large } = await resizePhoto(await noisyJpeg(900, 900, 6));
    expect((await infoOf(large)).exif).toBeUndefined();
  });

  it.each([
    ["text", Buffer.from("not an image")],
    ["an empty file", Buffer.alloc(0)],
    [
      "an SVG",
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'),
    ],
  ])("refuses %s", async (_name, bytes) => {
    await expect(resizePhoto(bytes)).rejects.toBeInstanceOf(PhotoRefused);
  });

  it("refuses a photo with more pixels than a phone makes", async () => {
    const huge = await sharp({
      create: { width: 12_000, height: 12_000, channels: 3, background: "#888" },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();
    await expect(resizePhoto(huge)).rejects.toBeInstanceOf(PhotoRefused);
  }, 30_000);
});

describe("bestFit", () => {
  /** A fake encoder whose size is the quality in bytes, recording what it was asked. */
  const fake = () => {
    const asked: number[] = [];
    const encode = async (quality: number) => {
      asked.push(quality);
      return Buffer.alloc(quality);
    };
    return { asked, encode };
  };

  it("picks the highest quality that fits, mid-ladder", async () => {
    const { encode } = fake();
    const result = await bestFit(encode, 50, [82, 72, 62, 52, 42, 32, 24, 16, 8]);
    expect(result.byteLength).toBe(42);
  });

  it("takes the top quality when it fits", async () => {
    const result = await bestFit(fake().encode, 1000, [82, 72, 62]);
    expect(result.byteLength).toBe(82);
  });

  it("returns the lowest quality when nothing fits", async () => {
    const result = await bestFit(fake().encode, 5, [82, 72, 62, 52, 42, 32, 24, 16, 8]);
    expect(result.byteLength).toBe(8);
  });

  it("encodes fewer times than there are rungs", async () => {
    const { asked, encode } = fake();
    await bestFit(encode, 50, [82, 72, 62, 52, 42, 32, 24, 16, 8]);
    expect(asked.length).toBeLessThanOrEqual(4);
  });
});

describe("the upload limit", () => {
  it("sits under Vercel's 4.5MB request body limit, with room for the form", () => {
    expect(MAX_UPLOAD_BYTES).toBeLessThan(4.5 * 1024 * 1024);
  });
});
