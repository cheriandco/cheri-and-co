/** Field lists for the M2 forms. Plain data, so server pages can pass them to the client form component. */
import { ORDER_CHANNELS, ORDER_STATUSES } from "@/types";
import type { FieldSpec } from "@/components/record-form";

export const CUSTOMER_FIELDS: FieldSpec[] = [
  { name: "name", label: "Name", required: true, maxLength: 200 },
  { name: "email", label: "Email", maxLength: 254 },
  { name: "phone", label: "Phone", maxLength: 40 },
  { name: "instagram", label: "Instagram", maxLength: 100, placeholder: "@handle" },
  { name: "city", label: "City", maxLength: 100 },
  { name: "interests", label: "Interests", list: true, placeholder: "Comma separated, e.g. earrings, necklaces" },
];

export const RETAILER_FIELDS: FieldSpec[] = [
  { name: "business", label: "Business name", required: true, maxLength: 200 },
  { name: "location", label: "Location", maxLength: 200 },
  { name: "category", label: "Category", maxLength: 100, placeholder: "e.g. Boutique" },
  { name: "contact", label: "Contact person", maxLength: 200 },
  { name: "email", label: "Email", maxLength: 254 },
  { name: "phone", label: "Phone", maxLength: 40 },
  { name: "instagram", label: "Instagram", maxLength: 100 },
  { name: "website", label: "Website", maxLength: 300 },
  { name: "qualification", label: "Notes", kind: "textarea", maxLength: 1000 },
];

export const TASK_FIELDS: FieldSpec[] = [
  { name: "title", label: "Task", required: true, maxLength: 200 },
  { name: "priority", label: "Priority", kind: "select", options: [["medium", "Medium"], ["high", "High"], ["low", "Low"]] },
  { name: "due", label: "Due", maxLength: 60, placeholder: "Today, Tomorrow, This week or 2026-12-01", date: { words: ["today", "tomorrow", "this week", "unscheduled"] } },
];

/** Most recent first. A very long list would make the pick-list unusable, so it is capped; the CSV import finds people by email instead. */
export const PICK_LIMIT = 500;

export function orderFields(customers: { id: string; name: string; email: string }[], retailers: { id: string; business: string; location: string }[]): FieldSpec[] {
  return [
    { name: "customerId", label: "Customer", kind: "select", options: [["", "None"], ...customers.slice(0, PICK_LIMIT).map((c): [string, string] => [c.id, c.email ? `${c.name} (${c.email})` : c.name])] },
    { name: "retailerId", label: "Retailer", kind: "select", options: [["", "None"], ...retailers.slice(0, PICK_LIMIT).map((r): [string, string] => [r.id, r.location ? `${r.business}, ${r.location}` : r.business])] },
    { name: "channel", label: "Channel", kind: "select", options: ORDER_CHANNELS.map((c): [string, string] => [c, c]) },
    { name: "status", label: "Status", kind: "select", options: ORDER_STATUSES.map((s): [string, string] => [s, s]) },
    { name: "total", label: "Total (₹)", required: true, numeric: true, placeholder: "e.g. 1499" },
    { name: "orderedAt", label: "Order date", placeholder: "YYYY-MM-DD, blank = today", date: {} },
  ];
}
