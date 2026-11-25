import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { announceSend } from "../../refusals";
import type { ActionForm } from "../../action-form";
import { clearWithSends, DeletePeriodForm, Say } from "./day-feedback";

const form = vi.hoisted(() => ({ props: undefined as unknown }));
vi.mock("../../action-form", () => ({
  ActionForm: (props: unknown) => {
    form.props = props;
    return null;
  },
}));

describe("a deleted period's message", () => {
  it("is told to the day's block once the delete is saved, and not by the form itself", () => {
    const say = vi.fn();
    renderToStaticMarkup(
      <Say value={say}>
        <DeletePeriodForm action="/delete" deletedMessage="Deleted Lunch on Monday.">
          Delete
        </DeletePeriodForm>
      </Say>,
    );
    const props = form.props as ComponentProps<typeof ActionForm>;
    expect(props.savedMessage).toBeUndefined();
    expect(say).not.toHaveBeenCalled();

    props.onSaved?.();

    expect(say).toHaveBeenCalledExactlyOnceWith("Deleted Lunch on Monday.");
  });

  it("goes when any form on the page is sent, but outlives its own delete's send", () => {
    let message: string | undefined;
    const stop = clearWithSends(() => (message = undefined));

    announceSend(Symbol("the delete")); // sent, then saved
    message = "Deleted.";
    expect(message).toBe("Deleted.");
    announceSend(Symbol("another form"));
    expect(message).toBeUndefined();
    stop();
  });

  it("goes when the page is left, and listens no longer", () => {
    const clear = vi.fn();
    const stop = clearWithSends(clear);

    stop();
    expect(clear).toHaveBeenCalledTimes(1);
    announceSend(Symbol("another form"));
    expect(clear).toHaveBeenCalledTimes(1);
  });
});
