/**
 * How long a sign-in code ceiling's window lasts (S-30). Its own module, with no
 * imports, so the scheduled job can prune rows past it without loading sign-in.
 */
export const CODE_WINDOW = "24 hours";
