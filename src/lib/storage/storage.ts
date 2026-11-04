import {
  DeleteObjectCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { assertSafeKey, publicUrl } from "./url";

export type ImageStorage = {
  /** Stores an image under `key` and returns its public URL. Overwrites. */
  uploadImage(
    key: string,
    body: Uint8Array,
    contentType: string,
  ): Promise<{ key: string; url: string }>;
  /** Removes the image stored under `key`. Deleting a missing key is a no-op. */
  deleteImage(key: string): Promise<void>;
  /** The public URL for `key`, on the bucket's custom domain. */
  getUrl(key: string): string;
};

export type ImageStorageConfig = {
  bucket: string;
  /** Custom domain bound to the bucket, without a trailing slash. */
  publicBaseUrl: string;
  client: Pick<S3Client, "send">;
};

// Raster formats only. SVG is active content and objects are served publicly
// with their stored ContentType, so `image/*` is not safe to accept. Spec 02
// stores WebP; the others are allowed for callers that skip conversion.
const ALLOWED_CONTENT_TYPES = new Set([
  "image/webp",
  "image/jpeg",
  "image/png",
  "image/avif",
]);

export function createImageStorage({
  bucket,
  publicBaseUrl,
  client,
}: ImageStorageConfig): ImageStorage {
  const getUrl = (key: string) => publicUrl(publicBaseUrl, key);

  return {
    getUrl,

    async uploadImage(key, body, contentType) {
      assertSafeKey(key);
      if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
        throw new Error(
          `uploadImage only stores images, got content type ${JSON.stringify(contentType)}.`,
        );
      }
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
        }),
      );
      return { key, url: getUrl(key) };
    },

    async deleteImage(key) {
      assertSafeKey(key);
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  };
}
