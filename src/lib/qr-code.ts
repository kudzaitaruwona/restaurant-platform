import "server-only";
import QRCode from "qrcode";
import { bookingPagePath } from "@/lib/booking-link";

/** What a table's printed code encodes (spec 03): no label, no restaurant id. */
export const tableCodeUrl = (appUrl: string, qrToken: string) =>
  `${appUrl.replace(/\/+$/, "")}/t/${qrToken}`;

/** What the generic "View our menu" card encodes (spec 03): the restaurant's own menu link. */
export const menuCodeUrl = (appUrl: string, menuToken: string) =>
  `${appUrl.replace(/\/+$/, "")}/m/${menuToken}`;

/** What the booking link and its QR code point at (spec 04 › Settings). */
export const bookingPageUrl = (appUrl: string, slug: string) =>
  `${appUrl.replace(/\/+$/, "")}${bookingPagePath(slug)}`;

/**
 * The code as an SVG string, made here on the server so the print sheet needs no
 * client code. Error correction M, the spec's level (spec 03 › Print sheet). The
 * SVG scales to whatever width it is given. The margin is the standard quiet zone,
 * 4 modules, and it is drawn inside the SVG on a white ground, so a card can't
 * crowd it and a dark theme can't eat it.
 */
export const qrSvg = (text: string) =>
  QRCode.toString(text, { type: "svg", errorCorrectionLevel: "M", margin: 4 });
