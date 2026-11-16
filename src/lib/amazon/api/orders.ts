/** Orders API v2026-01-01 (`searchOrders`). v0 is deprecated by Amazon.
 *
 *  PRIVACY: this module never sends `includedData`, so Amazon is never asked for buyer or recipient data, and the mapper copies only the
 *  named fields below. A response that contains `buyer`, `recipient` or anything else we did not name is dropped on the floor. */
import type { SpApiClient } from "../client";
import { int, iso, isRec, list, money, rec, round2, str } from "../parse";
import type { AmazonOrder, AmazonOrderItem } from "../types";

export interface OrdersPage { orders: AmazonOrder[]; nextToken: string | null; /** Orders dropped because a required field was missing. */ skipped: number }

export interface OrdersQuery {
  marketplaceId: string;
  lastUpdatedAfter: string;
  /** Must be at least two minutes before now (Amazon's rule); the sync uses five. */
  lastUpdatedBefore: string;
  paginationToken?: string | null;
}

export function mapOrderItem(raw: unknown): AmazonOrderItem | null {
  const r = rec(raw);
  const id = str(r.orderItemId, 64);
  if (!id) return null;
  const product = rec(r.product);
  const unit = money(rec(rec(product.price).unitPrice));
  return {
    orderItemId: id, asin: str(product.asin, 20), sellerSku: str(product.sellerSku, 80), title: str(product.title, 500),
    quantity: Math.max(0, int(r.quantityOrdered) ?? 0), unitPrice: unit.amount, currencyCode: unit.currency,
  };
}

export function mapOrder(raw: unknown, requestedMarketplaceId: string): AmazonOrder | null {
  const r = rec(raw);
  const orderId = str(r.orderId, 64);
  const createdTime = iso(r.createdTime);
  const lastUpdatedTime = iso(r.lastUpdatedTime);
  if (!orderId || !createdTime || !lastUpdatedTime) return null;
  const fulfillment = rec(r.fulfillment);
  const channel = rec(r.salesChannel);
  const by = str(fulfillment.fulfilledBy, 20);
  const items = list(r.orderItems).map(mapOrderItem).filter((i): i is AmazonOrderItem => i !== null);
  const priced = items.length > 0 && items.every((i) => i.unitPrice !== null);
  return {
    amazonOrderId: orderId,
    marketplaceId: str(channel.marketplaceId, 32) ?? requestedMarketplaceId,
    createdTime, lastUpdatedTime,
    fulfillmentStatus: str(fulfillment.fulfillmentStatus, 40) ?? "UNKNOWN",
    fulfilledBy: by === "MERCHANT" || by === "AMAZON" ? by : null,
    salesChannel: str(channel.channelName, 80),
    items,
    itemCount: items.length,
    unitCount: items.reduce((s, i) => s + i.quantity, 0),
    orderedValue: priced ? round2(items.reduce((s, i) => s + (i.unitPrice ?? 0) * i.quantity, 0)) : null,
    currencyCode: items.find((i) => i.currencyCode)?.currencyCode ?? null,
  };
}

export async function searchOrdersPage(client: SpApiClient, q: OrdersQuery): Promise<OrdersPage> {
  const { data } = await client.request("searchOrders", {
    path: "/orders/2026-01-01/orders",
    // No includedData on purpose (see the header comment). The same filters are sent with a pagination token, as Amazon requires.
    query: { lastUpdatedAfter: q.lastUpdatedAfter, lastUpdatedBefore: q.lastUpdatedBefore, marketplaceIds: [q.marketplaceId], maxResultsPerPage: 100, paginationToken: q.paginationToken ?? undefined },
  });
  const body = isRec(data) ? data : {};
  const rawOrders = list(body.orders);
  const orders = rawOrders.map((o) => mapOrder(o, q.marketplaceId)).filter((o): o is AmazonOrder => o !== null);
  return { orders, nextToken: str(rec(body.pagination).nextToken, 2000), skipped: rawOrders.length - orders.length };
}
