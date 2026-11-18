/** Input validation for the B2C enquiry API. Pure. Free text is stored in the organisation's own database only; it is never sent to an AI provider. */
import { parseCustomerInput } from "@/lib/validate";
import { ENQUIRY_SOURCES, type EnquiryInput, type EnquirySource, type NewCustomerInput } from "@/types/enquiry";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_MESSAGE = 2000;
/** A reply (a draft, a person's edit, an approver's edit) may be longer than a customer message. 6000 matches approvals.preview and the message column, so an
 *  approver's edit always fits and the stored text and the approved text can be identical. */
export const MAX_REPLY = 6000;
export const MAX_REASON = 140;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

const optionalUuid = (v: unknown): string | null | undefined => (v === undefined || v === null || v === "" ? null : isUuid(v) ? v : undefined);

/** A plain message: trimmed, 1..max characters, no control characters or markup tags. */
export function cleanMessage(v: unknown, max = MAX_MESSAGE): string | null {
  if (typeof v !== "string") return null;
  const t = v.replace(/\r\n?/g, "\n").trim();
  if (!t || t.length > max || CONTROL.test(t) || /<\/?[a-z][^>]*>/i.test(t)) return null;
  return t;
}

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/;
/** Characters a search filter treats as patterns. They have no place in a contact detail used to FIND a customer, so they are refused outright. */
const WILDCARD = /[*%\\]/;

/** Digits only (the comparison form of a phone number). */
export const phoneDigits = (p: string): string => p.replace(/\D/g, "");

/** Contact details are normalised so the same person always matches, and every later comparison is exact: email lower-cased, phone reduced to digits with an
 *  optional leading +, Instagram without "@" and lower-cased. The fields are first checked by the CRM's own parser (parseCustomerInput), so a customer created
 *  here obeys exactly the same limits as one created on the Customers page; the checks below only ADD rules (wildcards, shape, one contact method). */
export function parseCustomer(raw: unknown): { ok: true; value: NewCustomerInput } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "The customer must be an object with a name and a way to reach them." };
  const c = raw as Record<string, unknown>;
  const base = parseCustomerInput({ name: c.name, email: c.email, phone: c.phone, instagram: c.instagram, city: c.city });
  if (!base) return { ok: false, error: "A customer detail is not valid (plain text, one line, within the usual length)." };
  for (const v of [base.name, base.email, base.phone, base.instagram, base.city]) if (v && (v.includes("\n") || CONTROL.test(v) || /<\/?[a-z][^>]*>/i.test(v))) return { ok: false, error: "A customer detail is not valid (plain text, one line)." };
  if ([base.email, base.phone, base.instagram].some((v) => v && WILDCARD.test(v))) return { ok: false, error: "Contact details cannot contain the characters * % or backslash." };
  const email = base.email ? base.email.toLowerCase() : null;
  if (email && !EMAIL.test(email)) return { ok: false, error: "That email address is not valid." };
  const digits = base.phone ? phoneDigits(base.phone) : "";
  if (base.phone && (digits.length < 7 || digits.length > 15 || !/^\+?[\d\s().-]+$/.test(base.phone))) return { ok: false, error: "That phone number is not valid." };
  const phone = base.phone ? `${base.phone.trim().startsWith("+") ? "+" : ""}${digits}` : null;
  const instagram = base.instagram ? base.instagram.replace(/^@/, "").toLowerCase() : null;
  if (instagram && !/^[a-z0-9._]{1,30}$/.test(instagram)) return { ok: false, error: "That Instagram handle is not valid." };
  if (!email && !phone && !instagram) return { ok: false, error: "Give at least one way to reach the customer: email, phone or Instagram." };
  return { ok: true, value: { name: base.name, email, phone, instagram, city: base.city } };
}

export interface ListQuery { limit: number; offset: number; status: string | null; customerId: string | null }
export const DEFAULT_PAGE = 50;
export const MAX_PAGE = 100;

/** Pagination from a query string. Out-of-range values are rejected, not silently clamped, so a client bug is visible. */
export function parseListQuery(sp: URLSearchParams, statuses: readonly string[] = []): { ok: true; value: ListQuery } | { ok: false; error: string } {
  const num = (k: string, dflt: number, min: number, max: number): number | null => {
    const v = sp.get(k);
    if (v === null || v === "") return dflt;
    return /^\d{1,6}$/.test(v) && Number(v) >= min && Number(v) <= max ? Number(v) : null;
  };
  const limit = num("limit", DEFAULT_PAGE, 1, MAX_PAGE);
  const offset = num("offset", 0, 0, 100_000);
  if (limit === null) return { ok: false, error: `limit must be a whole number from 1 to ${MAX_PAGE}.` };
  if (offset === null) return { ok: false, error: "offset must be a whole number of 0 or more." };
  const status = sp.get("status") || null;
  if (status && !statuses.includes(status)) return { ok: false, error: `status must be one of: ${statuses.join(", ")}.` };
  const customerId = sp.get("customerId") || null;
  if (customerId && !isUuid(customerId)) return { ok: false, error: "That customer id is not valid." };
  return { ok: true, value: { limit, offset, status, customerId } };
}

export interface FollowUpPatch { status?: "open" | "done" | "postponed"; dueDate?: string; priority?: "high" | "medium" | "low"; reason?: string }

/** At least one of status, dueDate, priority, reason. A date follows the same rules as a new follow-up. */
export function parseFollowUpPatch(b: Record<string, unknown> | null, now = new Date()): { ok: true; value: FollowUpPatch } | { ok: false; error: string } {
  if (!b) return { ok: false, error: "Send a JSON body." };
  const out: FollowUpPatch = {};
  if (b.status !== undefined) {
    if (b.status !== "open" && b.status !== "done" && b.status !== "postponed") return { ok: false, error: "Status must be open, done or postponed." };
    out.status = b.status;
  }
  if (b.priority !== undefined) {
    if (b.priority !== "high" && b.priority !== "medium" && b.priority !== "low") return { ok: false, error: "Priority must be high, medium or low." };
    out.priority = b.priority;
  }
  if (b.dueDate !== undefined) {
    const d = parseFollowUpInput({ dueDate: b.dueDate, reason: "x" }, now);
    if (!d.ok) return d;
    out.dueDate = d.value.dueDate;
  }
  if (b.reason !== undefined) {
    const r = cleanMessage(b.reason, MAX_REASON);
    if (!r || r.includes("\n")) return { ok: false, error: `Give a short reason (1 to ${MAX_REASON} characters, one line).` };
    out.reason = r;
  }
  if (!Object.keys(out).length) return { ok: false, error: "Change at least one of: status, dueDate, priority, reason." };
  return { ok: true, value: out };
}

export function parseEnquiryInput(b: Record<string, unknown> | null): { ok: true; value: EnquiryInput } | { ok: false; error: string } {
  if (!b) return { ok: false, error: "Send a JSON body." };
  const source = (b.source === undefined || b.source === "" ? "other" : b.source) as EnquirySource;
  if (!ENQUIRY_SOURCES.includes(source)) return { ok: false, error: `Source must be one of: ${ENQUIRY_SOURCES.join(", ")}.` };
  const customerId = optionalUuid(b.customerId);
  const productId = optionalUuid(b.productId);
  if (customerId === undefined) return { ok: false, error: "That customer id is not valid." };
  if (productId === undefined) return { ok: false, error: "That product id is not valid." };
  let customer: NewCustomerInput | null = null;
  if (b.customer !== undefined && b.customer !== null) {
    if (customerId) return { ok: false, error: "Send either customerId or customer details, not both." };
    const c = parseCustomer(b.customer);
    if (!c.ok) return c;
    customer = c.value;
  }
  const message = cleanMessage(b.message);
  if (!message) return { ok: false, error: `Enter the customer's message (1 to ${MAX_MESSAGE} characters, plain text).` };
  return { ok: true, value: { source, customerId, customer, productId, message } };
}

export interface FollowUpInput { dueDate: string; reason: string; assigneeId: string | null; priority: "high" | "medium" | "low" }

/** dueDate: YYYY-MM-DD, today or later (relative to `now`), at most one year ahead. */
export function parseFollowUpInput(b: Record<string, unknown> | null, now = new Date()): { ok: true; value: FollowUpInput } | { ok: false; error: string } {
  if (!b) return { ok: false, error: "Send a JSON body." };
  const date = typeof b.dueDate === "string" ? b.dueDate : "";
  const t = /^\d{4}-\d{2}-\d{2}$/.test(date) ? Date.parse(`${date}T00:00:00Z`) : NaN;
  const today = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== date) return { ok: false, error: "Choose a follow-up date (YYYY-MM-DD)." };
  if (t < today) return { ok: false, error: "The follow-up date cannot be in the past." };
  if (t > today + 366 * 86_400_000) return { ok: false, error: "The follow-up date must be within a year." };
  const reason = cleanMessage(b.reason, MAX_REASON);
  if (!reason || reason.includes("\n")) return { ok: false, error: `Give a short reason (1 to ${MAX_REASON} characters, one line).` };
  const assigneeId = optionalUuid(b.assigneeId);
  if (assigneeId === undefined) return { ok: false, error: "That assignee id is not valid." };
  const priority = b.priority === undefined || b.priority === "" ? "medium" : b.priority;
  if (priority !== "high" && priority !== "medium" && priority !== "low") return { ok: false, error: "Priority must be high, medium or low." };
  return { ok: true, value: { dueDate: date, reason, assigneeId, priority } };
}

export function parseReplyInput(b: Record<string, unknown> | null): { ok: true; value: { productId: string | null } } | { ok: false; error: string } {
  const productId = optionalUuid(b?.productId);
  return productId === undefined ? { ok: false, error: "That product id is not valid." } : { ok: true, value: { productId } };
}
