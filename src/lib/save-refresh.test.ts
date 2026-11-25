import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REFRESH_LIMIT_MS, type Saved, refreshQueue, settleSave } from "./save-refresh";

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

/** Whether a promise has settled by now, as a flag to read. */
function watch(promise: Promise<unknown>) {
  const seen = { done: false };
  void promise.then(() => (seen.done = true));
  return seen;
}

describe("the page's one refresh (#111)", () => {
  it("is done when the refreshed page has rendered, not when it was asked for", async () => {
    const started: number[] = [];
    const queue = refreshQueue((turn) => started.push(turn));

    const asked = watch(queue.request());
    await vi.advanceTimersByTimeAsync(1000);
    expect(started).toEqual([1]);
    expect(asked.done).toBe(false);

    queue.rendered(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(asked.done).toBe(true);
  });

  it("is shared by the forms saved while one is under way, in a refresh that starts after their saves", async () => {
    const started: number[] = [];
    const queue = refreshQueue((turn) => started.push(turn));
    const first = watch(queue.request());
    const second = watch(queue.request());
    const third = watch(queue.request());
    expect(started).toEqual([1]);

    // The one under way may have read the database before the second and third saved.
    queue.rendered(1);
    await vi.advanceTimersByTimeAsync(0);
    expect([first.done, second.done, third.done]).toEqual([true, false, false]);
    expect(started).toEqual([1, 2]);

    queue.rendered(2);
    await vi.advanceTimersByTimeAsync(0);
    expect([second.done, third.done]).toEqual([true, true]);
    expect(started).toEqual([1, 2]);
  });

  it("ignores a render that says nothing new, as when a hidden page is shown again", async () => {
    const started: number[] = [];
    const queue = refreshQueue((turn) => started.push(turn));
    queue.rendered(0);
    const first = queue.request();
    queue.rendered(1);
    await first;

    const second = watch(queue.request());
    queue.rendered(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(second.done).toBe(false);
  });

  it("starts afresh for a save after a refresh that never came back, and settles both when it does", async () => {
    const started: number[] = [];
    const queue = refreshQueue((turn) => started.push(turn));
    const hung = watch(queue.request());
    await vi.advanceTimersByTimeAsync(REFRESH_LIMIT_MS);

    const later = watch(queue.request());
    expect(started).toEqual([1, 2]);
    queue.rendered(2);
    await vi.advanceTimersByTimeAsync(0);
    expect([hung.done, later.done]).toEqual([true, true]);
  });
});

describe("what a save says, and when (#111)", () => {
  const saved: Saved = { message: "Category added." };

  function save(options: { saved?: Saved; isLatest?: () => boolean } = {}) {
    const form = { isConnected: true };
    const here = { page: "/dashboard/menu" };
    const said: { form: (Saved | undefined)[]; page: (Saved & { quiet?: boolean })[] } = { form: [], page: [] };
    let render = () => {};
    const settled = watch(
      settleSave({
        form,
        refresh: () => new Promise<void>((resolve) => (render = resolve)),
        page: () => here.page,
        inForm: (what) => said.form.push(what),
        onPage: (what) => said.page.push(what),
        saved: "saved" in options ? options.saved : saved,
        isLatest: options.isLatest,
      }),
    );
    return { form, here, said, settled, render: async () => (render(), vi.advanceTimersByTimeAsync(0)) };
  }

  it("says nothing until the refreshed page has rendered, then says it in the form", async () => {
    const { said, settled, render } = save();
    await vi.advanceTimersByTimeAsync(REFRESH_LIMIT_MS - 1);
    expect(settled.done).toBe(false);
    expect(said).toEqual({ form: [], page: [] });

    await render();
    expect(settled.done).toBe(true);
    expect(said).toEqual({ form: [saved], page: [] });
  });

  it("says it on the page when the refresh took the form away (the first category)", async () => {
    const { form, said, render } = save();
    form.isConnected = false;
    await render();
    expect(said).toEqual({ form: [], page: [saved] });
  });

  it("is announced, but not shown, when the form has no message of its own", async () => {
    const { said, render } = save({ saved: undefined });
    await render();
    expect(said).toEqual({ form: [undefined], page: [{ message: "Done.", quiet: true }] });
  });

  it("says nothing on another page than the one it was sent from", async () => {
    for (const what of [saved, undefined]) {
      const { form, here, said, render } = save({ saved: what });
      form.isConnected = false;
      here.page = "/dashboard/tables";
      await render();
      expect(said.page).toEqual([]);
    }
  });

  it("lets go of a form whose refresh fails or hangs, saying the screen is old, until it does render", async () => {
    const { said, settled, render } = save();
    await vi.advanceTimersByTimeAsync(REFRESH_LIMIT_MS);
    expect(settled.done).toBe(true);
    expect(said.form).toEqual([{ ...saved, warning: expect.stringContaining("Reload the page") }]);

    await render();
    expect(said.form.at(-1)).toEqual(saved);
  });

  it("says a save with no message of its own was saved, when the screen can't show it", async () => {
    const { said } = save({ saved: undefined });
    await vi.advanceTimersByTimeAsync(REFRESH_LIMIT_MS);
    expect(said.form).toEqual([{ message: "Saved.", warning: expect.stringContaining("Reload the page") }]);
  });

  it("keeps the save's own warning beside the one about the screen", async () => {
    const { said } = save({ saved: { message: "Booking added.", warning: "No phone." } });
    await vi.advanceTimersByTimeAsync(REFRESH_LIMIT_MS);
    expect(said.form[0]?.warning).toMatch(/^No phone\. .*Reload the page/);
  });

  it("doesn't speak over a later send of the same form when the screen catches up", async () => {
    const { said, render } = save({ isLatest: () => false });
    await vi.advanceTimersByTimeAsync(REFRESH_LIMIT_MS);
    await render();
    expect(said.form).toHaveLength(1);
  });
});
