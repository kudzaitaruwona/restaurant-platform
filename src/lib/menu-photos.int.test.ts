import { eq, inArray } from "drizzle-orm";
import sharp from "sharp";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { auditLog, categories, menuItems, restaurants } from "@/db/schema";
import {
  openOwnerDatabase,
  testDatabaseSettings,
} from "../../test/integration/database";
import { addCategory, addMenuItem, getMenu } from "./menu";
import { menuTag } from "./menu-cache";
import { removeItemPhoto, setItemPhoto } from "./menu-photos";
import { PhotoRefused } from "./photo-image";

const revalidateTag = vi.hoisted(() => vi.fn());
vi.mock("next/cache", () => ({ revalidateTag }));

/**
 * Storage is faked at the interface the app uses (D-07), so nothing reaches R2:
 * what's checked is what the app asks it to store and delete.
 */
const bucket = vi.hoisted(() => ({
  files: new Map<string, { type: string; size: number }>(),
  deleted: [] as string[],
  failNextUpload: false,
}));

vi.mock("@/lib/storage", () => ({
  uploadImage: async (key: string, body: Uint8Array, type: string) => {
    if (bucket.failNextUpload) {
      bucket.failNextUpload = false;
      throw new Error("R2 is down");
    }
    bucket.files.set(key, { type, size: body.byteLength });
    return { key, url: `https://cdn.example.test/${key}` };
  },
  deleteImage: async (key: string) => {
    bucket.deleted.push(key);
    bucket.files.delete(key);
  },
  getUrl: (key: string) => `https://cdn.example.test/${key}`,
}));

const owner = openOwnerDatabase();
const created: string[] = [];

async function newRestaurant() {
  const restaurantId = crypto.randomUUID();
  await owner.db.insert(restaurants).values({
    id: restaurantId,
    name: "Photo Kitchen",
    slug: `photos-${restaurantId}`,
    menuToken: `photos-${restaurantId}`,
    currencyMode: "usd_only",
  });
  created.push(restaurantId);
  await addCategory({ restaurantId }, { name: "Mains" });
  const [category] = (await getMenu({ restaurantId })).categories;
  await addMenuItem(
    { restaurantId },
    { name: "Sadza", description: "", priceUsd: "8.50", priceZig: null, categoryId: category.id },
  );
  const itemId = (await getMenu({ restaurantId })).categories[0].items[0].id;
  return { restaurantId, itemId };
}

const jpeg = (width = 1600, height = 1200) =>
  sharp({
    create: { width, height, channels: 3, background: "#c33" },
  })
    .jpeg()
    .toBuffer();

const photoKeyOf = async (itemId: string) =>
  (await owner.db.select().from(menuItems).where(eq(menuItems.id, itemId)))[0]
    .photoKey;

beforeAll(() => {
  vi.stubEnv("DATABASE_URL", testDatabaseSettings().connectionString);
});

beforeEach(() => {
  revalidateTag.mockClear();
  bucket.files.clear();
  bucket.deleted.length = 0;
  bucket.failNextUpload = false;
});

afterAll(async () => {
  await owner.db.delete(auditLog).where(inArray(auditLog.restaurantId, created));
  await owner.db.delete(menuItems).where(inArray(menuItems.restaurantId, created));
  await owner.db.delete(categories).where(inArray(categories.restaurantId, created));
  await owner.db.delete(restaurants).where(inArray(restaurants.id, created));
  await owner.pool.end();
  vi.unstubAllEnvs();
});

describe("setItemPhoto", () => {
  it("stores the 800px and 320px WebP files through uploadImage", async () => {
    const tenant = await newRestaurant();

    expect(await setItemPhoto(tenant, tenant.itemId, await jpeg())).toBe("saved");

    const key = (await photoKeyOf(tenant.itemId))!;
    // Random, and neither id in it: the public page prints this address.
    expect(key).toMatch(/^menu\/[0-9a-f-]{36}$/);
    expect(key).not.toContain(tenant.restaurantId);
    expect(key).not.toContain(tenant.itemId);
    expect([...bucket.files.keys()].sort()).toEqual([`${key}-320.webp`, `${key}-800.webp`]);
    for (const file of bucket.files.values()) {
      expect(file.type).toBe("image/webp");
      expect(file.size).toBeLessThan(60 * 1024);
    }
  });

  it("shows the key on the menu and refreshes the public page", async () => {
    const tenant = await newRestaurant();
    await setItemPhoto(tenant, tenant.itemId, await jpeg());

    const [item] = (await getMenu(tenant)).categories[0].items;
    expect(item.photoKey).toBe(await photoKeyOf(tenant.itemId));
    expect(revalidateTag).toHaveBeenCalledWith(menuTag(tenant.restaurantId), { expire: 0 });
  });

  it("replaces a photo: new files under a new key, the old two deleted", async () => {
    const tenant = await newRestaurant();
    await setItemPhoto(tenant, tenant.itemId, await jpeg());
    const first = (await photoKeyOf(tenant.itemId))!;

    await setItemPhoto(tenant, tenant.itemId, await jpeg(900, 900));

    const second = (await photoKeyOf(tenant.itemId))!;
    expect(second).not.toBe(first);
    expect(bucket.deleted.sort()).toEqual([`${first}-320.webp`, `${first}-800.webp`]);
    expect([...bucket.files.keys()].sort()).toEqual([
      `${second}-320.webp`,
      `${second}-800.webp`,
    ]);
  });

  it("refuses a file that isn't a photo, storing and deleting nothing", async () => {
    const tenant = await newRestaurant();
    await setItemPhoto(tenant, tenant.itemId, await jpeg());
    const before = await photoKeyOf(tenant.itemId);
    bucket.deleted.length = 0;

    await expect(
      setItemPhoto(tenant, tenant.itemId, Buffer.from("<svg onload=alert(1)/>")),
    ).rejects.toBeInstanceOf(PhotoRefused);

    expect(await photoKeyOf(tenant.itemId)).toBe(before);
    expect(bucket.deleted).toEqual([]);
    expect(bucket.files.size).toBe(2);
  });

  it("keeps the old photo and cleans up when storage fails", async () => {
    const tenant = await newRestaurant();
    await setItemPhoto(tenant, tenant.itemId, await jpeg());
    const before = await photoKeyOf(tenant.itemId);
    bucket.failNextUpload = true;

    await expect(setItemPhoto(tenant, tenant.itemId, await jpeg())).rejects.toThrow(
      "R2 is down",
    );

    expect(await photoKeyOf(tenant.itemId)).toBe(before);
    expect([...bucket.files.keys()].sort()).toEqual([`${before}-320.webp`, `${before}-800.webp`]);
  });

  it("does not undo the save if deleting the old photo fails", async () => {
    const tenant = await newRestaurant();
    await setItemPhoto(tenant, tenant.itemId, await jpeg());
    const first = await photoKeyOf(tenant.itemId);
    const storage = await import("@/lib/storage");
    const spy = vi.spyOn(storage, "deleteImage").mockRejectedValue(new Error("R2 is down"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      expect(await setItemPhoto(tenant, tenant.itemId, await jpeg())).toBe("saved");
      expect(await photoKeyOf(tenant.itemId)).not.toBe(first);
      expect(log).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      log.mockRestore();
    }
  });

  it("audits a platform admin's change, as the menu's other writes do", async () => {
    const tenant = await newRestaurant();
    const platformAdminId = crypto.randomUUID();

    await setItemPhoto({ ...tenant, platformAdminId }, tenant.itemId, await jpeg());
    await removeItemPhoto({ ...tenant, platformAdminId }, tenant.itemId);

    expect(
      await owner.db
        .select({ action: auditLog.action, actorId: auditLog.actorId })
        .from(auditLog)
        .where(eq(auditLog.entityId, tenant.itemId)),
    ).toEqual([
      { action: "menu_item.photo_set", actorId: platformAdminId },
      { action: "menu_item.photo_remove", actorId: platformAdminId },
    ]);
  });
});

describe("removeItemPhoto", () => {
  it("clears the photo and deletes both files through deleteImage", async () => {
    const tenant = await newRestaurant();
    await setItemPhoto(tenant, tenant.itemId, await jpeg());
    const key = (await photoKeyOf(tenant.itemId))!;
    revalidateTag.mockClear();

    expect(await removeItemPhoto(tenant, tenant.itemId)).toBe("saved");

    expect(await photoKeyOf(tenant.itemId)).toBeNull();
    expect(bucket.deleted.sort()).toEqual([`${key}-320.webp`, `${key}-800.webp`]);
    expect(bucket.files.size).toBe(0);
    expect(revalidateTag).toHaveBeenCalledWith(menuTag(tenant.restaurantId), { expire: 0 });
  });

  it("is a no-op for an item with no photo", async () => {
    const tenant = await newRestaurant();
    expect(await removeItemPhoto(tenant, tenant.itemId)).toBe("saved");
    expect(bucket.deleted).toEqual([]);
  });
});

describe("tenant scope", () => {
  it("won't touch another restaurant's item: nothing stored, nothing deleted", async () => {
    const [mine, theirs] = [await newRestaurant(), await newRestaurant()];
    await setItemPhoto(theirs, theirs.itemId, await jpeg());
    const theirKey = await photoKeyOf(theirs.itemId);
    bucket.files.clear();

    expect(await setItemPhoto(mine, theirs.itemId, await jpeg())).toBe("no_such_item");
    expect(await removeItemPhoto(mine, theirs.itemId)).toBe("no_such_item");

    expect(await photoKeyOf(theirs.itemId)).toBe(theirKey);
    expect(bucket.files.size).toBe(0);
    expect(bucket.deleted).toEqual([]);
  });

  it.each(["not-a-uuid", "'; drop table menu_items; --", crypto.randomUUID()])(
    "treats the item id %j as no such item",
    async (itemId) => {
      const tenant = await newRestaurant();
      expect(await setItemPhoto(tenant, itemId, await jpeg())).toBe("no_such_item");
      expect(await removeItemPhoto(tenant, itemId)).toBe("no_such_item");
    },
  );
});
