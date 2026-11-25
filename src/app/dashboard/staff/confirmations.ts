import type { Confirmation } from "../action-form";

/**
 * What the staff screen asks before it changes a person (S-41's in-page
 * dialogs). Addressed to the reader when the row is theirs: demoting or
 * deactivating yourself locks you out of this very page.
 */
export function roleConfirmation(member: {
  displayName: string;
  role: "owner" | "staff";
  you: boolean;
}): Confirmation {
  if (member.role !== "owner") {
    return {
      title: `Make ${member.displayName} an owner?`,
      description:
        "They'll be able to manage the menu and prices, staff, tables and settings, including other owners.",
      confirmLabel: "Make owner",
      cancelLabel: "Keep as staff",
      tone: "primary",
    };
  }
  if (member.you) {
    return {
      title: "Make yourself staff?",
      description:
        "You'll lose access to staff management, the menu, tables and settings, including this page. Only another owner can make you an owner again.",
      confirmLabel: "Make me staff",
      cancelLabel: "Stay owner",
      tone: "danger",
    };
  }
  return {
    title: `Make ${member.displayName} staff?`,
    description:
      "They'll lose access to the menu and prices, staff, tables and settings. They keep the kitchen, floor and bookings.",
    confirmLabel: "Make staff",
    cancelLabel: "Keep as owner",
    tone: "primary",
  };
}

export function deactivateConfirmation(member: {
  displayName: string;
  you: boolean;
}): Confirmation {
  return member.you
    ? {
        title: "Deactivate yourself?",
        description: "You won't be able to sign in.",
        confirmLabel: "Deactivate me",
        cancelLabel: "Keep",
      }
    : {
        title: `Deactivate ${member.displayName}?`,
        description: "They won't be able to sign in.",
        confirmLabel: "Deactivate",
        cancelLabel: "Keep",
      };
}
