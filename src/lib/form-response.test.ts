import { afterEach, describe, expect, it, vi } from "vitest";
import { formSaved, postForm } from "./form-response";

afterEach(() => vi.unstubAllGlobals());

describe("postForm", () => {
  it("posts the form saying it can do without a redirect", async () => {
    const fetchSpy = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchSpy);
    const body = new FormData();

    const response = await postForm("/api/staff", body);

    expect(response.status).toBe(204);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/staff");
    expect(init).toMatchObject({ method: "POST", body });
    const marked = new Request("http://x.test/", { headers: init.headers });
    expect(formSaved(marked, "/dashboard").status).toBe(204);
  });
});

describe("formSaved", () => {
  it("sends a plain form post on to the page", () => {
    const response = formSaved(new Request("http://x.test/"), "/dashboard/staff");
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/dashboard/staff");
  });
});
