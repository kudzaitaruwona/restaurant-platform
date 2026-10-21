import {
  DeleteObjectCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import { createImageStorage } from "./storage";

// R2 is an external service, so the S3 client is the one thing faked here.
function setup() {
  const send = vi.fn().mockResolvedValue({});
  const storage = createImageStorage({
    bucket: "photos",
    publicBaseUrl: "https://images.example.test",
    client: { send } as unknown as S3Client,
  });
  return { storage, send };
}

describe("image storage", () => {
  it("getUrl returns a URL on the public custom domain", () => {
    const { storage } = setup();
    expect(storage.getUrl("r/abc/items/123-800.webp")).toBe(
      "https://images.example.test/r/abc/items/123-800.webp",
    );
  });

  it("getUrl percent-encodes each path segment", () => {
    const { storage } = setup();
    expect(storage.getUrl("r/abc/a b+c.webp")).toBe(
      "https://images.example.test/r/abc/a%20b%2Bc.webp",
    );
  });

  it("uploadImage puts the object in the bucket and returns its public URL", async () => {
    const { storage, send } = setup();
    const body = new Uint8Array([1, 2, 3]);

    const result = await storage.uploadImage("r/abc/x.webp", body, "image/webp");

    expect(result).toEqual({
      key: "r/abc/x.webp",
      url: "https://images.example.test/r/abc/x.webp",
    });
    expect(send).toHaveBeenCalledOnce();
    const command = send.mock.calls[0][0];
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input).toMatchObject({
      Bucket: "photos",
      Key: "r/abc/x.webp",
      Body: body,
      ContentType: "image/webp",
    });
  });

  it("uploadImage refuses a non-image content type", async () => {
    const { storage, send } = setup();
    await expect(
      storage.uploadImage("r/abc/x.html", new Uint8Array(), "text/html"),
    ).rejects.toThrow(/image/);
    expect(send).not.toHaveBeenCalled();
  });

  it("deleteImage deletes the object from the bucket", async () => {
    const { storage, send } = setup();

    await storage.deleteImage("r/abc/x.webp");

    const command = send.mock.calls[0][0];
    expect(command).toBeInstanceOf(DeleteObjectCommand);
    expect(command.input).toEqual({ Bucket: "photos", Key: "r/abc/x.webp" });
  });

  it.each(["", "/r/abc/x.webp", "r/../x.webp", "r//x.webp", "r\\x.webp"])(
    "rejects the unsafe key %j",
    async (key) => {
      const { storage, send } = setup();
      expect(() => storage.getUrl(key)).toThrow(/key/);
      await expect(
        storage.uploadImage(key, new Uint8Array(), "image/webp"),
      ).rejects.toThrow(/key/);
      await expect(storage.deleteImage(key)).rejects.toThrow(/key/);
      expect(send).not.toHaveBeenCalled();
    },
  );
});
