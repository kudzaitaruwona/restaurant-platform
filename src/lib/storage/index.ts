import "server-only";
import { S3Client } from "@aws-sdk/client-s3";
import { getEnv } from "@/lib/env";
import { createImageStorage, type ImageStorage } from "./storage";

/**
 * The only way app code touches photo storage (D-07, spec 02). Backed by
 * Cloudflare R2 through its S3-compatible API; public URLs are on
 * R2_PUBLIC_BASE_URL, the bucket's custom domain (never r2.dev).
 * ESLint forbids importing the S3 SDK anywhere else.
 */

let storage: ImageStorage | undefined;

function r2(): ImageStorage {
  if (!storage) {
    const env = getEnv();
    storage = createImageStorage({
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
  }
  return storage;
}

export const uploadImage: ImageStorage["uploadImage"] = (key, body, type) =>
  r2().uploadImage(key, body, type);

export const deleteImage: ImageStorage["deleteImage"] = (key) =>
  r2().deleteImage(key);

export const getUrl: ImageStorage["getUrl"] = (key) => r2().getUrl(key);
