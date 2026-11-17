/** The only Places transport that exists in this phase: a scripted fake. It never touches a network. An unscripted request throws, so a
 *  test fails loudly if the client makes a call nobody expected. */
import type { PlacesRawResponse, PlacesRequest, PlacesTransport } from "@/lib/prospecting/places";

export type Step =
  | { status: number; headers?: Record<string, string>; body?: unknown }
  | { throws: Error }
  | { hang: true }
  | ((req: PlacesRequest) => PlacesRawResponse | Promise<PlacesRawResponse>);

export class FakePlacesTransport implements PlacesTransport {
  readonly requests: Omit<PlacesRequest, "signal">[] = [];
  aborted = 0;
  constructor(private readonly script: Step[]) {}
  get calls(): number { return this.requests.length; }

  async send(req: PlacesRequest): Promise<PlacesRawResponse> {
    const { signal, ...rest } = req;
    this.requests.push(rest);
    const step = this.script.shift();
    if (!step) throw new Error("FakePlacesTransport: unscripted request");
    if (typeof step === "function") return step(req);
    if ("throws" in step) throw step.throws;
    if ("hang" in step) return new Promise<PlacesRawResponse>((_, reject) => { signal.addEventListener("abort", () => { this.aborted += 1; reject(new Error("aborted")); }); });
    return { status: step.status, headers: step.headers ?? {}, body: step.body ?? {} };
  }
}

export const ok = (body: unknown): Step => ({ status: 200, body });
export const err = (status: number, body: unknown = {}, headers: Record<string, string> = {}): Step => ({ status, body, headers });

/** A search page in the wire shape Places (New) uses, built from invented entries. */
export function wirePlace(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, displayName: { text: `Test Shop ${id}`, languageCode: "en" }, formattedAddress: "Test Road, Indore, Madhya Pradesh",
    addressComponents: [{ longText: "Indore", shortText: "Indore", types: ["locality"] }, { longText: "Madhya Pradesh", shortText: "MP", types: ["administrative_area_level_1"] }],
    location: { latitude: 22.7, longitude: 75.8 }, types: ["jewelry_store", "store"], primaryType: "jewelry_store", businessStatus: "OPERATIONAL", ...extra,
  };
}
