/**
 * Shrinks a phone photo in the browser before it is sent. Vercel refuses a
 * request body over 4.5MB, and a phone's original can be twice that, so the
 * server never sees it. The server still makes the real 800px and 320px files
 * (src/lib/photo-image.ts): this only has to be small enough to send and large
 * enough to resize from. It belongs to the editor and never to the public page,
 * which runs no script (spec 02, S-32).
 */

/** The long edge. The server's largest output is 800px, so this is 2x. */
export const MAX_EDGE = 1600;
const QUALITY = 0.85;
/** Below this, redrawing would cost quality for nothing. */
const LEAVE_ALONE_BYTES = 1024 * 1024;

export function scaledSize(width: number, height: number) {
  const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

/**
 * A JPEG of at most MAX_EDGE, or the original when it is already small or this
 * browser can't decode it (a HEIC photo outside Safari, say). The original then
 * goes to the server, which refuses it with a message if it is too large.
 */
export async function downscalePhoto(file: File): Promise<File> {
  if (typeof createImageBitmap !== "function") return file;
  try {
    // from-image applies the camera's rotation here, because the JPEG drawn
    // below carries none.
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const { width, height } = scaledSize(bitmap.width, bitmap.height);
    if (
      file.size <= LEAVE_ALONE_BYTES &&
      width === bitmap.width &&
      height === bitmap.height
    ) {
      bitmap.close();
      return file;
    }

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", QUALITY),
    );
    return blob ? new File([blob], "photo.jpg", { type: "image/jpeg" }) : file;
  } catch {
    return file;
  }
}
