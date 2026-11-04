import "server-only";
import { getEnv } from "@/lib/env";
import type { ImageStorage } from "./storage";
import { publicUrl } from "./url";

/**
 * The only way app code touches photo storage (D-07, spec 02). Backed by
 * Cloudflare R2 through its S3-compatible API; public URLs are on
 * R2_PUBLIC_BASE_URL, the bucket's custom domain (never r2.dev).
 * ESLint forbids importing the S3 SDK anywhere else.
 *
 * The public menu page imports this for getUrl, on every cold start, so the SDK
 * loads on the first upload or delete and not with this module.
 */

let storage: Promise<ImageStorage> | undefined;

function r2(): Promise<ImageStorage> {
  storage ??= (async () => {
    const [{ S3Client }, { createImageStorage }] = await Promise.all([
      import("@aws-sdk/client-s3"),
      import("./storage"),
    ]);
    const env = getEnv();
    return createImageStorage({
      bucket: env.R2_BUCKET,
      publicBaseUrl: env.R2_PUBLIC_BASE_URL,
      client: new S3Client({
        region: "auto",
        endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: {
          accessKeyId: env.R2_ACCESS_KEY_ID,
          secretAccessKey: env.R2_SECRET_ACCESS_KEY,
        },
      }),
    });
  })();
  return storage;
}

export const uploadImage: ImageStorage["uploadImage"] = async (key, body, type) =>
  (await r2()).uploadImage(key, body, type);

export const deleteImage: ImageStorage["deleteImage"] = async (key) =>
  (await r2()).deleteImage(key);

export const getUrl: ImageStorage["getUrl"] = (key) =>
  publicUrl(getEnv().R2_PUBLIC_BASE_URL, key);
