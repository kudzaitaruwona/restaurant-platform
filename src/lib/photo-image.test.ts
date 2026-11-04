import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
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

describe("the upload limit", () => {
  it("sits under Vercel's 4.5MB request body limit, with room for the form", () => {
    expect(MAX_UPLOAD_BYTES).toBeLessThan(4.5 * 1024 * 1024);
  });
});
