import { describe, expect, it, vi } from "vitest";

/** A stale tap on a table's detail is refused with `refresh`, so ActionForm reloads the page (#102). */
vi.mock("@/lib/tenant", () => ({ getTenantContext: async () => ({ restaurantId: "r", staffId: "s", role: "staff" }) }));
vi.mock("@/lib/floor", () => ({
  orderItemIdFrom: async () => "item",
  markItemDelivered: async () => ({ outcome: "wrong_status", status: "delivered" }),
}));
vi.mock("@/lib/voids", () => ({
  voidItem: async () => ({ outcome: "wrong_status", status: "delivered" }),
  rejectOrder: async () => ({ outcome: "nothing_to_void" }),
}));

const reasonForm = () => {
  const body = new FormData();
  body.set("reason", "Mistake");
  return body;
};
const post = (body?: FormData) => new Request("http://localhost/x", { method: "POST", body }) as never;

describe("stale actions on a table's detail", () => {
  it("Mark delivered", async () => {
    const { POST } = await import("./order-items/[itemId]/deliver/route");
    const response = await POST(post(), { params: Promise.resolve({ itemId: "item" }) } as never);
    expect(response.status).toBe(409);
    const answer = await response.json();
    expect(answer).toMatchObject({ refresh: true });
    expect(answer.error).not.toMatch(/reload/i);
  });

  it("Void", async () => {
    const { POST } = await import("./order-items/[itemId]/void/route");
    const response = await POST(post(reasonForm()), { params: Promise.resolve({ itemId: "item" }) } as never);
    expect(response.status).toBe(409);
    const answer = await response.json();
    expect(answer).toMatchObject({ refresh: true });
    expect(answer.error).not.toMatch(/reload/i);
  });

  it("Reject order", async () => {
    const { POST } = await import("./orders/[orderId]/reject/route");
    const orderId = crypto.randomUUID();
    const response = await POST(post(reasonForm()), { params: Promise.resolve({ orderId }) } as never);
    expect(response.status).toBe(409);
    const answer = await response.json();
    expect(answer).toMatchObject({ refresh: true });
    expect(answer.error).not.toMatch(/reload/i);
  });
});
