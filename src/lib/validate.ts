/** Minimal input validation for API routes (no extra dependency). */
import { ORDER_CHANNELS, ORDER_STATUSES } from "@/types";
import type { OrderChannel, OrderStatus, PipelineStage, Priority } from "@/types";

export const STAGES: PipelineStage[] = ["new", "qualified", "contacted", "interested", "negotiation", "won", "lost"];
export const PRIORITIES: Priority[] = ["high", "medium", "low"];

export const isStage = (v: unknown): v is PipelineStage => typeof v === "string" && (STAGES as string[]).includes(v);
export const isPriority = (v: unknown): v is Priority => typeof v === "string" && (PRIORITIES as string[]).includes(v);
export const str = (v: unknown, max = 500): string | null =>
  typeof v === "string" && v.trim().length > 0 && v.length <= max ? v.trim() : null;

export async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await req.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Optional text field: absent or blank is fine (null); present but over the limit is an error (undefined). */
const opt = (v: unknown, max: number): string | null | undefined =>
  v === undefined || v === null || (typeof v === "string" && v.trim() === "") ? null : str(v, max) ?? undefined;

export interface CustomerInput { name: string; instagram: string | null; phone: string | null; email: string | null; city: string | null; interests: string[] }
export interface RetailerInput { business: string; location: string | null; category: string | null; contact: string | null; email: string | null; phone: string | null; instagram: string | null; website: string | null; qualification: string | null }

export function parseCustomerInput(b: Record<string, unknown> | null): CustomerInput | null {
  const name = str(b?.name, 200);
  const [instagram, phone, email, city] = [opt(b?.instagram, 100), opt(b?.phone, 40), opt(b?.email, 254), opt(b?.city, 100)];
  const interests = b?.interests === undefined ? [] : Array.isArray(b.interests) && b.interests.length <= 20 && b.interests.every((i) => str(i, 60)) ? (b.interests as string[]).map((i) => i.trim()) : null;
  if (!name || instagram === undefined || phone === undefined || email === undefined || city === undefined || interests === null) return null;
  return { name, instagram, phone, email, city, interests };
}

export function parseRetailerInput(b: Record<string, unknown> | null): RetailerInput | null {
  const business = str(b?.business, 200);
  const f = [opt(b?.location, 200), opt(b?.category, 100), opt(b?.contact, 200), opt(b?.email, 254), opt(b?.phone, 40), opt(b?.instagram, 100), opt(b?.website, 300), opt(b?.qualification, 1000)] as const;
  if (!business || f.some((x) => x === undefined)) return null;
  const [location, category, contact, email, phone, instagram, website, qualification] = f as readonly (string | null)[];
  return { business, location, category, contact, email, phone, instagram, website, qualification };
}

export const PRODUCT_STATUSES = ["draft", "active", "low_stock", "archived"] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];
export interface ProductInput { sku: string; name: string; category: string | null; price: number | null; stock: number | null; status: ProductStatus; channels: string[] }

/** Optional number: blank is fine (null), anything else must be a finite number in range (undefined means invalid). */
function num(v: unknown, min: number, max: number, integer: boolean): number | null | undefined {
  if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) return null;
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) return undefined;
  return integer ? n : Math.round(n * 100) / 100;
}

/** The columns of `products`, nothing more. Limits match the table's check constraints (price numeric(10,2) >= 0, stock integer >= 0). */
export function parseProductInput(b: Record<string, unknown> | null): ProductInput | null {
  const sku = str(b?.sku, 64);
  const name = str(b?.name, 200);
  const category = opt(b?.category, 100);
  const price = num(b?.price, 0, 99_999_999.99, false);
  const stock = num(b?.stock, 0, 1_000_000_000, true);
  const status = b?.status === undefined || b.status === "" ? "draft" : b.status;
  const raw = b?.channels;
  const list = raw === undefined || raw === null ? [] : Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : null;
  const channels = list && list.length <= 20 && list.every((c) => typeof c === "string") ? [...new Set((list as string[]).map((c) => c.trim()).filter(Boolean))] : null;
  if (!sku || !name || category === undefined || price === undefined || stock === undefined || channels === null || channels.some((c) => c.length > 40)) return null;
  if (typeof status !== "string" || !(PRODUCT_STATUSES as readonly string[]).includes(status)) return null;
  return { sku, name, category, price, stock, status: status as ProductStatus, channels };
}

export interface OrderInput { customerId: string | null; retailerId: string | null; channel: OrderChannel; status: OrderStatus; total: number; lineItems: Record<string, unknown>[]; orderedAt: string | null }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isOrderStatus = (v: unknown): v is OrderStatus => typeof v === "string" && (ORDER_STATUSES as readonly string[]).includes(v);

/** Optional id: blank is null, a malformed value is invalid (undefined). The composite foreign key then proves it belongs to the same organisation. */
const optId = (v: unknown): string | null | undefined =>
  v === undefined || v === null || v === "" ? null : typeof v === "string" && UUID_RE.test(v) ? v : undefined;

/** The columns of `orders`, nothing more. total is numeric(12,2) >= 0 and defaults to 0; line_items is a JSON array whose item shape the table does not define. */
export function parseOrderInput(b: Record<string, unknown> | null): OrderInput | null {
  const customerId = optId(b?.customerId);
  const retailerId = optId(b?.retailerId);
  const channel = b?.channel;
  const status = b?.status === undefined || b.status === "" ? "new" : b.status;
  const total = b?.total === undefined || b.total === null || b.total === "" ? 0 : typeof b.total === "number" ? b.total : typeof b.total === "string" ? Number(b.total) : NaN;
  const items = b?.lineItems === undefined || b.lineItems === null ? [] : b.lineItems;
  const orderedAt = b?.orderedAt === undefined || b.orderedAt === null || b.orderedAt === "" ? null : b.orderedAt;
  if (customerId === undefined || retailerId === undefined) return null;
  if (typeof channel !== "string" || !(ORDER_CHANNELS as readonly string[]).includes(channel) || !isOrderStatus(status)) return null;
  if (!Number.isFinite(total) || total < 0 || total > 9_999_999_999.99) return null;
  if (!Array.isArray(items) || items.length > 100 || !items.every((i) => i !== null && typeof i === "object" && !Array.isArray(i)) || JSON.stringify(items).length > 20_000) return null;
  if (orderedAt !== null && (typeof orderedAt !== "string" || Number.isNaN(Date.parse(orderedAt)))) return null;
  return {
    customerId, retailerId, channel: channel as OrderChannel, status, total: Math.round(total * 100) / 100,
    lineItems: items as Record<string, unknown>[], orderedAt: orderedAt === null ? null : new Date(orderedAt as string).toISOString(),
  };
}
