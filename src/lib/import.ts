/** CSV import (M2): templates, row checking and duplicate detection for customers, retailers, tasks and orders.
 *  Pure functions, no I/O. The server runs `analyseImport` for the preview AND again at import time, so the file is
 *  never trusted twice, and every accepted row goes through the same `parse*Input` checks as the forms and the API. */
import { ORDER_CHANNELS, ORDER_STATUSES } from "@/types";
import type { OrderChannel, OrderStatus } from "@/types";
import { CsvError, parseCsv, toCsv } from "./csv";
import { isPriority, parseCustomerInput, parseOrderInput, parseRetailerInput, type CustomerInput, type OrderInput, type RetailerInput } from "./validate";
import type { Priority } from "@/types";

export const IMPORT_RESOURCES = ["customers", "retailers", "tasks", "orders"] as const;
export type ImportResource = (typeof IMPORT_RESOURCES)[number];
export const isImportResource = (v: unknown): v is ImportResource => typeof v === "string" && (IMPORT_RESOURCES as readonly string[]).includes(v);

/** Kept small on purpose: rows are saved one at a time through the same code as the forms. */
export const MAX_IMPORT_ROWS = 200;
export const MAX_IMPORT_CHARS = 500_000;

export interface ColumnSpec { name: string; required?: boolean; help: string; example: string }

export const IMPORT_COLUMNS: Record<ImportResource, ColumnSpec[]> = {
  customers: [
    { name: "name", required: true, help: "Full name", example: "Example Customer (delete this row)" },
    { name: "email", help: "Email address", example: "example@example.com" },
    { name: "phone", help: "Phone number", example: "+91 90000 00000" },
    { name: "instagram", help: "Instagram handle", example: "@example" },
    { name: "city", help: "City", example: "Mumbai" },
    { name: "interests", help: "Separate several with a semicolon", example: "earrings; necklaces" },
  ],
  retailers: [
    { name: "business", required: true, help: "Shop or business name", example: "Example Boutique (delete this row)" },
    { name: "location", help: "Town or area", example: "Pune" },
    { name: "category", help: "Type of shop", example: "Boutique" },
    { name: "contact", help: "Contact person", example: "A. Person" },
    { name: "email", help: "Email address", example: "shop@example.com" },
    { name: "phone", help: "Phone number", example: "+91 90000 00000" },
    { name: "instagram", help: "Instagram handle", example: "@exampleboutique" },
    { name: "website", help: "Website address", example: "https://example.com" },
    { name: "qualification", help: "Notes on fit", example: "Stocks fine jewellery" },
  ],
  tasks: [
    { name: "title", required: true, help: "What needs doing", example: "Call the boutique (delete this row)" },
    { name: "priority", help: "high, medium or low (blank = medium)", example: "medium" },
    { name: "due", help: "Today, Tomorrow, This week, or a date as YYYY-MM-DD (blank = unscheduled)", example: "2026-12-01" },
  ],
  orders: [
    { name: "channel", required: true, help: `One of: ${ORDER_CHANNELS.join(", ")}`, example: "instagram" },
    { name: "total", required: true, help: "Order total in rupees, 0 or more", example: "1499.00" },
    { name: "status", help: `One of: ${ORDER_STATUSES.join(", ")} (blank = new)`, example: "new" },
    { name: "ordered_at", help: "Date as YYYY-MM-DD (blank = now)", example: "2026-11-04" },
    { name: "customer_email", help: "Email of an EXISTING customer (import customers first)", example: "example@example.com" },
    { name: "retailer_business", help: "Name of an EXISTING retailer", example: "" },
    { name: "items", help: "Optional, e.g. Kundan Choker x1; Pearl Studs x2", example: "Pearl Studs x2" },
  ],
};

/** A downloadable template: the header row plus one example row to show the format. */
export function templateCsv(resource: ImportResource): string {
  const cols = IMPORT_COLUMNS[resource];
  return toCsv([cols.map((c) => c.name), cols.map((c) => c.example)]);
}

export interface ImportContext {
  customers: { id: string; name: string; email: string; phone: string; instagram: string; city: string }[];
  retailers: { id: string; business: string; location: string; email: string; phone: string }[];
  /** Tasks that still count as open (not done). */
  tasks: { title: string }[];
  orders: { customerId: string | null; retailerId: string | null; channel: string; total: number; orderedAt: string }[];
}
export const EMPTY_CONTEXT: ImportContext = { customers: [], retailers: [], tasks: [], orders: [] };

export interface TaskImport { title: string; due: string; priority: Priority }
export type ParsedInput =
  | { resource: "customers"; input: CustomerInput }
  | { resource: "retailers"; input: RetailerInput }
  | { resource: "tasks"; input: TaskImport }
  | { resource: "orders"; input: OrderInput };

export interface ImportRowReport { line: number; label: string; status: "valid" | "invalid" | "duplicate"; errors: string[]; note?: string }
export interface ImportReport {
  resource: ImportResource;
  headerErrors: string[];
  warnings: string[];
  rows: ImportRowReport[];
  counts: { total: number; valid: number; invalid: number; duplicate: number };
}
export interface Analysis { report: ImportReport; valid: { line: number; label: string; parsed: ParsedInput }[] }

/* ------------------------------------------------------------------ helpers */

const lower = (s: string) => s.trim().toLowerCase();
const digits = (s: string) => s.replace(/\D/g, "");
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const validIsoDate = (s: string) => ISO_DATE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);
const normHeader = (h: string) => h.trim().toLowerCase().replace(/[\s-]+/g, "_");
const KNOWN_DUE = new Set(["", "unscheduled", "today", "tomorrow", "this week"]);

function checkText(errors: string[], label: string, value: string, max: number) {
  if (value.length > max) errors.push(`${label} is too long (maximum ${max} characters).`);
}
function checkEmail(errors: string[], value: string) {
  if (value && !EMAIL.test(value)) errors.push("Email address is not valid.");
}
function checkPhone(errors: string[], value: string) {
  if (value && (digits(value).length < 6 || digits(value).length > 15)) errors.push("Phone number should have 6 to 15 digits.");
}

/* ------------------------------------------------------------------ duplicate keys */

const handle = (s: string) => lower(s).replace(/^@/, "");
function customerKeys(c: { name: string; email: string; phone: string; instagram: string; city: string }): string[] {
  const keys: string[] = [];
  if (c.email) keys.push(`email:${lower(c.email)}`);
  if (digits(c.phone).length >= 7) keys.push(`phone:${digits(c.phone).slice(-10)}`);
  if (handle(c.instagram)) keys.push(`instagram:${handle(c.instagram)}`);
  if (!keys.length) keys.push(`name:${lower(c.name)}|${lower(c.city)}`);
  return keys;
}
const NOT_RECORDED = "not recorded";
const clean = (s: string) => (lower(s) === NOT_RECORDED ? "" : s);
function retailerKeys(r: { business: string; location: string; email: string; phone: string }): string[] {
  const keys = [`business:${lower(r.business)}|${lower(clean(r.location))}`];
  if (clean(r.email)) keys.push(`email:${lower(clean(r.email))}`);
  if (digits(clean(r.phone)).length >= 7) keys.push(`phone:${digits(clean(r.phone)).slice(-10)}`);
  return keys;
}
const taskKey = (title: string) => `task:${lower(title)}`;
const dayOf = (iso: string) => String(iso ?? "").slice(0, 10);
const orderKey = (o: { customerId: string | null; retailerId: string | null; channel: string; total: number; orderedAt: string }) =>
  `order:${o.customerId ?? "-"}|${o.retailerId ?? "-"}|${o.channel}|${Number(o.total).toFixed(2)}|${dayOf(o.orderedAt)}`;

/* ------------------------------------------------------------------ per-row checks */

type Cells = Record<string, string>;

function parseCustomerRow(c: Cells): { errors: string[]; parsed?: ParsedInput } {
  const errors: string[] = [];
  if (!c.name) errors.push("Name is required.");
  checkText(errors, "Name", c.name, 200); checkText(errors, "Instagram", c.instagram, 100); checkText(errors, "City", c.city, 100);
  checkEmail(errors, c.email); checkPhone(errors, c.phone);
  const interests = c.interests ? c.interests.split(/[;|,]/).map((s) => s.trim()).filter(Boolean) : [];
  if (interests.length > 20 || interests.some((i) => i.length > 60)) errors.push("Interests: at most 20, each up to 60 characters.");
  const input = errors.length ? null : parseCustomerInput({ name: c.name, instagram: c.instagram, phone: c.phone, email: c.email, city: c.city, interests });
  if (!errors.length && !input) errors.push("A value is missing or too long.");
  return { errors, parsed: input ? { resource: "customers", input } : undefined };
}

function parseRetailerRow(c: Cells): { errors: string[]; parsed?: ParsedInput } {
  const errors: string[] = [];
  if (!c.business) errors.push("Business name is required.");
  checkText(errors, "Business", c.business, 200); checkText(errors, "Location", c.location, 200); checkText(errors, "Category", c.category, 100);
  checkText(errors, "Contact", c.contact, 200); checkText(errors, "Instagram", c.instagram, 100); checkText(errors, "Website", c.website, 300);
  checkText(errors, "Qualification", c.qualification, 1000);
  checkEmail(errors, c.email); checkPhone(errors, c.phone);
  const input = errors.length ? null : parseRetailerInput({ ...c });
  if (!errors.length && !input) errors.push("A value is missing or too long.");
  return { errors, parsed: input ? { resource: "retailers", input } : undefined };
}

function parseTaskRow(c: Cells): { errors: string[]; parsed?: ParsedInput } {
  const errors: string[] = [];
  if (!c.title) errors.push("Title is required.");
  checkText(errors, "Title", c.title, 200);
  const priority = c.priority ? lower(c.priority) : "medium";
  if (!isPriority(priority)) errors.push("Priority must be high, medium or low.");
  const dueText = c.due.trim();
  if (!KNOWN_DUE.has(lower(dueText)) && !validIsoDate(dueText)) errors.push("Due must be Today, Tomorrow, This week, or a date as YYYY-MM-DD.");
  if (errors.length) return { errors };
  return { errors, parsed: { resource: "tasks", input: { title: c.title, due: dueText || "Unscheduled", priority: priority as Priority } } };
}

function parseOrderRow(c: Cells, ctx: ImportContext): { errors: string[]; parsed?: ParsedInput } {
  const errors: string[] = [];
  const channel = lower(c.channel);
  if (!channel) errors.push("Channel is required.");
  else if (!(ORDER_CHANNELS as readonly string[]).includes(channel)) errors.push(`Channel must be one of: ${ORDER_CHANNELS.join(", ")}.`);
  const status = c.status ? lower(c.status) : "new";
  if (!(ORDER_STATUSES as readonly string[]).includes(status)) errors.push(`Status must be one of: ${ORDER_STATUSES.join(", ")}.`);
  let total = NaN;
  if (c.total === "") errors.push("Total is required.");
  else {
    total = Number(c.total.replace(/[₹,\s]/g, ""));
    if (!Number.isFinite(total) || total < 0) errors.push("Total must be a number, 0 or more.");
  }
  if (c.ordered_at && !validIsoDate(c.ordered_at)) errors.push("Order date must be YYYY-MM-DD.");
  let customerId: string | null = null;
  if (c.customer_email) {
    const found = ctx.customers.filter((x) => x.email && lower(x.email) === lower(c.customer_email));
    if (found.length === 0) errors.push("No existing customer has this email. Import or add the customer first.");
    else if (found.length > 1) errors.push("More than one customer has this email.");
    else customerId = found[0].id;
  }
  let retailerId: string | null = null;
  if (c.retailer_business) {
    const found = ctx.retailers.filter((x) => lower(x.business) === lower(c.retailer_business));
    if (found.length === 0) errors.push("No existing retailer has this business name. Import or add the retailer first.");
    else if (found.length > 1) errors.push("More than one retailer has this business name.");
    else retailerId = found[0].id;
  }
  const lineItems = c.items ? c.items.split(";").map((s) => s.trim()).filter(Boolean).map((part) => {
    const m = /^(.*?)(?:\s*[x×]\s*(\d{1,4}))?$/i.exec(part);
    return { name: (m?.[1] || part).trim(), quantity: m?.[2] ? Number(m[2]) : 1 };
  }) : [];
  if (lineItems.length > 100 || lineItems.some((i) => !i.name || i.name.length > 200)) errors.push("Items: at most 100, each name up to 200 characters.");
  if (errors.length) return { errors };
  const input = parseOrderInput({ customerId, retailerId, channel, status, total, lineItems, orderedAt: c.ordered_at ? `${c.ordered_at}T12:00:00.000Z` : null });
  if (!input) return { errors: ["A value is missing or invalid."] };
  return { errors, parsed: { resource: "orders", input: { ...input, channel: channel as OrderChannel, status: status as OrderStatus } } };
}

const labelOf = (resource: ImportResource, c: Cells): string =>
  (resource === "customers" ? c.name || c.email : resource === "retailers" ? c.business : resource === "tasks" ? c.title
    : [c.channel, c.total && `₹${c.total}`, c.customer_email || c.retailer_business].filter(Boolean).join(" · ")) || "(blank)";

/* ------------------------------------------------------------------ analysis */

export function analyseImport(resource: ImportResource, text: string, ctx: ImportContext = EMPTY_CONTEXT): Analysis {
  const empty = (headerErrors: string[], warnings: string[] = []): Analysis => ({
    valid: [], report: { resource, headerErrors, warnings, rows: [], counts: { total: 0, valid: 0, invalid: 0, duplicate: 0 } },
  });
  if (text.length > MAX_IMPORT_CHARS) return empty(["This file is too large. Split it into smaller files."]);
  let table: string[][];
  try { table = parseCsv(text); } catch (e) { return empty([e instanceof CsvError ? e.message : "This file could not be read as CSV."]); }
  const headerIndex = table.findIndex((r) => r.some((c) => c.trim() !== ""));
  if (headerIndex < 0) return empty(["The file is empty. Download the template and fill it in."]);

  const spec = IMPORT_COLUMNS[resource];
  const known = new Set(spec.map((c) => c.name));
  const header = table[headerIndex].map(normHeader);
  const seen = new Set<string>();
  const headerErrors: string[] = [];
  const warnings: string[] = [];
  header.forEach((h) => { if (h && seen.has(h)) headerErrors.push(`The column “${h}” appears more than once.`); seen.add(h); });
  for (const c of spec) if (c.required && !seen.has(c.name)) headerErrors.push(`Required column “${c.name}” is missing.`);
  const unknown = header.filter((h) => h && !known.has(h));
  if (unknown.length) warnings.push(`Ignored columns that are not part of the template: ${unknown.join(", ")}.`);
  if (headerErrors.length) return empty(headerErrors, warnings);

  const body = table.slice(headerIndex + 1).map((cells, i) => ({ cells, line: headerIndex + 2 + i })).filter((r) => r.cells.some((c) => c.trim() !== ""));
  if (body.length === 0) return empty(["The file has a header but no rows."], warnings);
  if (body.length > MAX_IMPORT_ROWS) return empty([`This file has ${body.length} rows. The limit is ${MAX_IMPORT_ROWS} per import; split it into smaller files.`], warnings);

  // keys of what already exists, then of valid rows seen earlier in this file
  const taken = new Map<string, string>();
  if (resource === "customers") for (const c of ctx.customers) for (const k of customerKeys(c)) taken.set(k, "an existing customer");
  if (resource === "retailers") for (const r of ctx.retailers) for (const k of retailerKeys(r)) taken.set(k, "an existing retailer");
  if (resource === "tasks") for (const t of ctx.tasks) taken.set(taskKey(t.title), "an open task");
  if (resource === "orders") for (const o of ctx.orders) taken.set(orderKey(o), "an existing order");

  const rows: ImportRowReport[] = [];
  const valid: Analysis["valid"] = [];
  for (const { cells, line } of body) {
    const c: Cells = {};
    spec.forEach((s) => { c[s.name] = ""; });
    header.forEach((h, i) => { if (known.has(h)) c[h] = (cells[i] ?? "").trim(); });
    const label = labelOf(resource, c);
    const result = resource === "customers" ? parseCustomerRow(c) : resource === "retailers" ? parseRetailerRow(c)
      : resource === "tasks" ? parseTaskRow(c) : parseOrderRow(c, ctx);
    if (result.errors.length || !result.parsed) { rows.push({ line, label, status: "invalid", errors: result.errors }); continue; }

    const p = result.parsed;
    const keys = p.resource === "customers" ? customerKeys({ name: p.input.name, email: p.input.email ?? "", phone: p.input.phone ?? "", instagram: p.input.instagram ?? "", city: p.input.city ?? "" })
      : p.resource === "retailers" ? retailerKeys({ business: p.input.business, location: p.input.location ?? "", email: p.input.email ?? "", phone: p.input.phone ?? "" })
      : p.resource === "tasks" ? [taskKey(p.input.title)]
      : p.input.orderedAt ? [orderKey({ customerId: p.input.customerId, retailerId: p.input.retailerId, channel: p.input.channel, total: p.input.total, orderedAt: p.input.orderedAt })] : [];
    const hit = keys.find((k) => taken.has(k));
    if (hit) {
      rows.push({ line, label, status: "duplicate", errors: [], note: `Skipped: matches ${taken.get(hit)}.` });
      continue;
    }
    for (const k of keys) taken.set(k, `line ${line} of this file`);
    rows.push({ line, label, status: "valid", errors: [] });
    valid.push({ line, label, parsed: p });
  }
  const count = (s: ImportRowReport["status"]) => rows.filter((r) => r.status === s).length;
  return { valid, report: { resource, headerErrors: [], warnings, rows, counts: { total: rows.length, valid: count("valid"), invalid: count("invalid"), duplicate: count("duplicate") } } };
}
