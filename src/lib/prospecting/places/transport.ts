/** The seam between the Places client and the network. THIS PHASE CONTAINS NO REAL TRANSPORT: the only implementation lives in tests
 *  (a scripted fake). A real one would be a separate, explicitly approved piece of work (Phase 8: needs R3, R4 and R5), would hold the
 *  API key itself, and is the only code allowed to contain Google's host name. The client never sees a credential. */

export type PlacesOperation = "searchText" | "placeDetails";

export interface PlacesRequest {
  operation: PlacesOperation;
  method: "GET" | "POST";
  /** Relative path only, for example `/v1/places:searchText`. The transport owns the host. */
  path: string;
  /** The exact `X-Goog-FieldMask` value. */
  fieldMask: string;
  body?: Record<string, unknown>;
  /** Aborted when the client's timeout fires. A transport should honour it. */
  signal: AbortSignal;
}

export interface PlacesRawResponse {
  status: number;
  /** Lower-case header names. */
  headers: Record<string, string>;
  body: unknown;
}

export interface PlacesTransport {
  send(request: PlacesRequest): Promise<PlacesRawResponse>;
}

export const SEARCH_PATH = "/v1/places:searchText";
export const detailsPath = (placeId: string): string => `/v1/places/${encodeURIComponent(placeId)}`;

export interface SearchQuery {
  textQuery: string;
  /** 1 to 20. */
  pageSize?: number;
  pageToken?: string;
  /** ISO 3166-1 alpha-2, default "IN". */
  regionCode?: string;
  languageCode?: string;
}

/** Composes a search phrase from a configured term and city, for example ("fashion jewellery", "Indore"). */
export function buildTextQuery(term: string, city: string): string {
  return `${term.trim()} in ${city.trim()}`.replace(/\s+/g, " ");
}
