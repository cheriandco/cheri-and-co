/** Personal-data redaction applied to everything that is about to leave the server for the AI provider.
 *  Policy (owner decision): real customer names, phone numbers, emails and other direct identifiers are NEVER sent.
 *  The Content & Marketing pilot sends only product facts, so this is defence in depth: a stray phone number or
 *  email in a product name, note or claim is replaced before sending, and the count is reported to the reviewer.
 *  It cannot recognise a person's NAME in free text; the pilot avoids that risk by never sending customer records. */

export interface Redacted { text: string; count: number }

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const URL_LIKE = /\bhttps?:\/\/\S+|\bwww\.\S+/gi;
const HANDLE = /(?<![\w@])@[A-Za-z0-9_.]{2,30}/g;
/** A run of digits that may contain spaces, dashes, dots or brackets. Treated as a phone or id number when it holds 7+ digits. */
const NUMBER_RUN = /(?<![\w])\+?\(?\d[\d\s().-]{5,}\d(?![\w])/g;

export function redactPersonalData(input: string): Redacted {
  let count = 0;
  const swap = (re: RegExp, label: string) => (s: string) => s.replace(re, () => { count += 1; return label; });
  let text = swap(EMAIL, "[email]")(input);
  text = swap(URL_LIKE, "[link]")(text);
  text = swap(HANDLE, "[handle]")(text);
  text = text.replace(NUMBER_RUN, (m) => {
    if (m.replace(/\D/g, "").length < 7) return m;
    count += 1;
    return "[number]";
  });
  return { text, count };
}

/** True when the text holds something redaction would change. Used to reject AI OUTPUT that echoes personal data. */
export const containsPersonalData = (text: string): boolean => redactPersonalData(text).count > 0;

/** Redacts every string inside a plain JSON-like value (objects, arrays, strings). Other types pass through. */
export function redactDeep<T>(value: T): { value: T; count: number } {
  let count = 0;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") { const r = redactPersonalData(v); count += r.count; return r.text; }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return { value: walk(value) as T, count };
}
