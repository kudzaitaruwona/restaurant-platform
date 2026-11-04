/**
 * A WhatsApp click-to-chat link for a restaurant's contact number (spec 04). The
 * number is built into a URL path, so it must be exactly what wa.me takes: the
 * country code and number, digits only, no plus. Anything else gets no link
 * rather than a half-escaped one; the number itself is still shown.
 *
 * restaurants.contact_phone is E.164 by a CHECK, but it allows as few as two
 * digits, and a link wants a real number, so this asks for seven or more.
 */
const LINKABLE = /^[+][1-9][0-9]{6,14}$/;

export function whatsappLink(phone: string | null | undefined): string | undefined {
  return phone && LINKABLE.test(phone) ? `https://wa.me/${phone.slice(1)}` : undefined;
}
