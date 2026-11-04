import "server-only";
import QRCode from "qrcode";

/** What a table's printed code encodes (spec 03): no label, no restaurant id. */
export const tableCodeUrl = (appUrl: string, qrToken: string) =>
  `${appUrl.replace(/\/+$/, "")}/t/${qrToken}`;

/**
 * The code as an SVG string, made here on the server so the print sheet needs no
 * client code. Error correction M, the spec's level (spec 03 › Print sheet). The
 * SVG scales to whatever width it is given.
 */
export const qrSvg = (text: string) =>
  QRCode.toString(text, { type: "svg", errorCorrectionLevel: "M", margin: 1 });
