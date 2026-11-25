import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ACTION = "/api/r/mbira/book";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const stored = new Map<string, string>();
const storage = {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => stored.set(key, value),
  removeItem: (key: string) => stored.delete(key),
};
const blocked = {
  getItem() { throw new Error("blocked"); },
  setItem() { throw new Error("blocked"); },
  removeItem() { throw new Error("blocked"); },
};

/** A page load: the module's memory starts empty. */
const load = () => {
  vi.resetModules();
  return import("./submission");
};

beforeEach(() => {
  stored.clear();
  vi.stubGlobal("sessionStorage", storage);
});
afterEach(() => vi.unstubAllGlobals());

describe("the id of a submission (#134)", () => {
  it("is a UUID, made without crypto.randomUUID, which plain http doesn't have", async () => {
    const { getRandomValues } = crypto;
    vi.stubGlobal("crypto", { getRandomValues: getRandomValues.bind(crypto) });
    const { submissionId } = await load();

    expect(submissionId(ACTION)).toMatch(UUID);
  });

  it("is kept until the submission is answered as booked, then is another", async () => {
    const { submissionId, submissionBooked } = await load();
    const id = submissionId(ACTION);

    expect(submissionId(ACTION)).toBe(id);
    expect(submissionId("/api/r/other/book")).not.toBe(id);
    submissionBooked(ACTION);
    expect(submissionId(ACTION)).not.toBe(id);
  });

  it("survives a reload, so a retry after one is still the same submission", async () => {
    const id = (await load()).submissionId(ACTION);
    const { submissionId, submissionBooked } = await load();

    expect(submissionId(ACTION)).toBe(id);
    submissionBooked(ACTION);
    expect((await load()).submissionId(ACTION)).not.toBe(id);
  });

  it("is kept by the page alone where storage is blocked", async () => {
    vi.stubGlobal("sessionStorage", blocked);
    const { submissionId, submissionBooked } = await load();
    const id = submissionId(ACTION);

    expect(id).toMatch(UUID);
    expect(submissionId(ACTION)).toBe(id);
    submissionBooked(ACTION);
    expect(submissionId(ACTION)).not.toBe(id);
  });
});

describe("the answer to a submission (#134)", () => {
  const answering = (...responses: (Response | Error)[]) => {
    const post = vi.fn<typeof fetch>(async () => {
      const next = responses.shift()!;
      if (next instanceof Error) throw next;
      return next;
    });
    vi.stubGlobal("fetch", post);
    return post;
  };
  const booked = (manageToken: string) => Response.json({ confirmation: { manageToken } }, { status: 201 });
  const cutShort = () => new Response('{"confirmation":{"mana', { status: 201 });

  it("is where the booking is", async () => {
    answering(booked("AbC"));
    const { submit } = await load();

    expect(await submit(ACTION, new FormData())).toEqual({ booked: "/b/AbC?booked=1" });
  });

  it("is a refusal when the server says so", async () => {
    answering(Response.json({ error: "Too short" }, { status: 400 }));
    const { submit } = await load();

    expect(await submit(ACTION, new FormData())).toEqual({ status: 400, refusal: { error: "Too short" } });
  });

  it.each([
    ["no response", () => new TypeError("Failed to fetch")],
    ["a body cut short", cutShort],
    ["a 500", () => Response.json({ error: "x" }, { status: 500 })],
    ["a gateway's page", () => new Response("<html>", { status: 504 })],
    ["somebody else's 200", () => Response.json({ hello: "portal" })],
  ])("is unknown, and so thrown, with %s", async (_what, response) => {
    answering(response());
    const { submit } = await load();

    await expect(submit(ACTION, new FormData())).rejects.toThrow();
  });

  it("of a try whose answer was lost is asked for again, until one says where the booking is", async () => {
    const tries = ["first", "second", "third"].map((name) => {
      const body = new FormData();
      body.set("name", name);
      return body;
    });
    const post = answering(
      Response.json({ error: "x", alreadyBooked: true }, { status: 409 }),
      new TypeError("Failed to fetch"),
      booked("AbC"),
    );
    const { bookingOfLost } = await load();

    expect(await bookingOfLost(ACTION, tries)).toBe("/b/AbC?booked=1");
    expect(post.mock.calls.map(([, init]) => init?.body)).toEqual(tries);
  });

  it("is nowhere when no lost try made the booking", async () => {
    const post = answering();
    const { bookingOfLost } = await load();

    expect(await bookingOfLost(ACTION, [])).toBeUndefined();
    expect(post).not.toHaveBeenCalled();
  });
});
