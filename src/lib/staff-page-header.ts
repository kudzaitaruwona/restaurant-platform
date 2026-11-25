/**
 * Set by the proxy on a GET under /dashboard, so the tenant seam can tell a staff
 * page from a data call. It only picks how an admin outside any restaurant is
 * refused: a redirect to /admin or a 403. It never grants anything.
 */
export const STAFF_PAGE_HEADER = "x-staff-page";
