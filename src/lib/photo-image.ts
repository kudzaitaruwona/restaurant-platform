import "server-only";
import sharp, { type Sharp } from "sharp";

/**
 * Turns an upload into the two WebP files spec 02 asks for: 800px for the item
 * view, a 320px square for the thumbnail, each aiming for under 60KB.
 */

/**
 * Vercel refuses a request body over 4.5MB before our code runs, and the form
 * carries a little besides the file. The editor shrinks a photo to well under
 * this first (src/app/dashboard/menu/photo-form.tsx), so this is the backstop for
 * a browser that couldn't.
 */
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

/** Beyond what any phone camera makes. Decoding is what costs memory. */
const MAX_INPUT_PIXELS = 64_000_000;

const TARGET_BYTES = 60 * 1024;
const QUALITIES = [82, 72, 62, 52, 42, 32, 24, 16, 8];

/** The upload isn't an image this can use. The message is safe to show. */
export class PhotoRefused extends Error {}

async function toWebp(image: Sharp) {
  let smallest: Buffer | undefined;
  for (const quality of QUALITIES) {
    const bytes = await image.clone().webp({ quality }).toBuffer();
    if (bytes.byteLength < TARGET_BYTES) return bytes;
    smallest = bytes;
  }
  // The aim, not a promise: the lowest quality is as small as this gets.
  return smallest!;
}

export async function resizePhoto(bytes: Uint8Array) {
  let upright: Sharp;
  try {
    const source = sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS });
    const { format } = await source.metadata();
    // SVG is active content, and the rest aren't photos.
    if (!format || !["jpeg", "png", "webp", "heif", "avif", "gif", "tiff"].includes(format)) {
      throw new PhotoRefused("That file isn't a photo. Use a JPEG, PNG or WebP image.");
    }
    // .rotate() with no argument applies the EXIF orientation: without it a phone
    // held upright gives a sideways photo. Output carries no metadata, so the
    // location a phone records doesn't reach a public page.
    upright = source.rotate();
    const [large, thumb] = await Promise.all([
      toWebp(upright.clone().resize({ width: 800, height: 800, fit: "inside", withoutEnlargement: true })),
      toWebp(upright.clone().resize({ width: 320, height: 320, fit: "cover" })),
    ]);
    return { large, thumb };
  } catch (error) {
    if (error instanceof PhotoRefused) throw error;
    throw new PhotoRefused("That file couldn't be read as a photo. Try another.");
  }
}
