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

/**
 * The highest of `qualities` (descending) whose encoding is under `limit` bytes,
 * found by bisecting, since a lower quality makes a smaller file: four tries for
 * nine rungs, not nine. If nothing fits, the lowest quality, as small as this gets.
 */
export async function bestFit(
  encode: (quality: number) => Promise<Buffer>,
  limit: number = TARGET_BYTES,
  qualities: readonly number[] = QUALITIES,
) {
  let fits: Buffer | undefined;
  let tried: Buffer | undefined;
  let [high, low] = [0, qualities.length - 1];
  while (high <= low) {
    const middle = Math.floor((high + low) / 2);
    tried = await encode(qualities[middle]);
    if (tried.byteLength < limit) {
      fits = tried;
      low = middle - 1;
    } else {
      high = middle + 1;
    }
  }
  // The aim, not a promise: if nothing fits, the last try was the lowest quality.
  return fits ?? tried!;
}

/**
 * The image is decoded and resized once, to raw pixels, so each try only encodes.
 */
async function toWebp(image: Sharp) {
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  return bestFit((quality) =>
    sharp(data, { raw: { width, height, channels } }).webp({ quality }).toBuffer(),
  );
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
