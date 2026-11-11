import { createCn } from "cn/config";

/**
 * Joins class names and resolves Tailwind conflicts, knowing the design
 * system's own names (S-41, globals.css): without this, `text-body` would be
 * read as a colour and dropped next to `text-ink`.
 */
export const cn = createCn({
  extend: {
    classGroups: {
      "font-size": [{ text: ["caption", "body", "control", "lead", "title", "heading", "display"] }],
      rounded: [{ rounded: ["card", "control"] }],
      shadow: [{ shadow: ["float"] }],
    },
  },
});
