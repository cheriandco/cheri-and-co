/** A fake `fetch` that answers like Amazon would, from the DOCUMENTATION-DERIVED fixtures in tests/fixtures/amazon. These are not Amazon
 *  sandbox responses; they prove our code handles the documented shapes. */
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { SpApiClient } from "@/lib/amazon/client";
import type { AmazonPublicConfig } from "@/lib/amazon/config";

const fx = (name: string) => JSON.parse(readFileSync(`tests/fixtures/amazon/${name}.json`, "utf8")) as Record<string, unknown>;
const tsv = () => readFileSync("tests/fixtures/amazon/listings-report.tsv", "utf8");
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });

export interface FakeOptions {
  /** Path fragments that answer 429 with a very long retry-after. */
  throttle?: string[];
  /** Orders pages by pagination token ("" = first page). Defaults to the orders fixture alone. */
  orderPages?: Record<string, unknown>;
  /** Report statuses returned by successive getReport calls. */
  reportStatuses?: string[];
  /** Path fragments that answer 403. */
  forbid?: string[];
}

export function fakeAmazon(opts: FakeOptions = {}) {
  const calls: { method: string; url: string; headers: Record<string, string> }[] = [];
  let reportPolls = 0;
  const statuses = opts.reportStatuses ?? ["DONE"];
  const orders = fx("orders");
  const pages = opts.orderPages ?? { "": orders };

  const handler = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const u = new URL(url);
    calls.push({ method: init?.method ?? "GET", url, headers: (init?.headers ?? {}) as Record<string, string> });
    if (opts.throttle?.some((p) => u.pathname.includes(p))) return json({ errors: [{ code: "QuotaExceeded", message: "slow down" }] }, 429, { "retry-after": "3600" });
    if (opts.forbid?.some((p) => u.pathname.includes(p))) return json({ errors: [{ code: "Unauthorized", message: "Access to requested resource is denied." }] }, 403);
    if (u.hostname.endsWith(".amazonaws.com")) return new Response(gzipSync(tsv()));
    const p = u.pathname;
    if (p === "/sellers/v1/marketplaceParticipations") return json(fx("marketplace"));
    if (p === "/orders/2026-01-01/orders") return json(pages[u.searchParams.get("paginationToken") ?? ""] ?? { orders: [], pagination: {} });
    if (p.startsWith("/listings/2021-08-01/items/")) return json(fx("listings"));
    if (p === "/catalog/2022-04-01/items") return json(fx("catalog"));
    if (p === "/fba/inventory/v1/summaries") {
      const inv = fx("inventory");
      if (u.searchParams.get("nextToken")) return json({ payload: { inventorySummaries: [{ sellerSku: "SKU-9", totalQuantity: 2, inventoryDetails: { fulfillableQuantity: 2 } }] }, pagination: {} });
      return json(inv);
    }
    if (p === "/reports/2021-06-30/reports" && (init?.method ?? "GET") === "POST") return json({ reportId: "R1" });
    if (p === "/reports/2021-06-30/reports/R1") {
      const status = statuses[Math.min(reportPolls++, statuses.length - 1)];
      return json({ reportId: "R1", reportType: "GET_MERCHANT_LISTINGS_DATA", processingStatus: status, ...(status === "DONE" ? { reportDocumentId: "D1" } : {}) });
    }
    if (p === "/reports/2021-06-30/documents/D1") return json({ reportDocumentId: "D1", url: "https://bucket.s3.amazonaws.com/doc?X-Amz-Signature=abc", compressionAlgorithm: "GZIP" });
    return json({ errors: [{ code: "NotFound", message: "no such route in the fake" }] }, 404);
  };

  const config = { baseUrl: "https://sandbox.sellingpartnerapi-eu.amazon.com", marketplaceId: "A21TJRUUN4KGV", environment: "sandbox" } as unknown as AmazonPublicConfig;
  const tokens = { getAccessToken: async () => "Atza|TEST-ACCESS", invalidate: () => {} };
  const client = new SpApiClient({ config, tokens, fetchImpl: handler as unknown as typeof fetch, sleep: async () => {}, random: () => 0 });
  return { client, calls };
}
