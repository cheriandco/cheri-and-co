/** CLASS P entry point: details a PERSON entered from an INDEPENDENT source (specification section 6.4).
 *
 *  This is the only input the (future) acceptance step may take for retailer contact details. `GoogleTransient` is a different branded
 *  type, so passing Google content here is a compile error; `google_places` is not a valid source and is refused at run time as well.
 *  Nothing is built on top of this yet: acceptance, the form and the database are later phases. */

/** Closed list. `google_places` is deliberately absent. */
export const INDEPENDENT_SOURCE_TYPES = ["owner_submitted", "own_website", "own_social_page", "direct_enquiry", "referral", "trade_show_or_card", "trade_directory_permitted", "existing_crm"] as const;
export type IndependentSourceType = (typeof INDEPENDENT_SOURCE_TYPES)[number];
/** Decision R7 default: a third-party directory is NOT enabled until the owner and counsel confirm its terms allow the use. */
export const ENABLED_SOURCE_TYPES: readonly IndependentSourceType[] = INDEPENDENT_SOURCE_TYPES.filter((t) => t !== "trade_directory_permitted");

declare const humanBrand: unique symbol;
export interface HumanEnteredContactFields {
  businessName: string;
  phone?: string;
  email?: string;
  website?: string;
  address?: string;
  sourceType: IndependentSourceType;
  /** A URL on the business's own page, or a dated note such as "spoke to owner on 12 Nov". Required. */
  sourceReference: string;
  /** The person who attests the details did not come from Google Maps content. */
  attestedBy: string;
  attestedAt: string;
}
export type HumanEnteredContact = Readonly<HumanEnteredContactFields> & { readonly [humanBrand]: true };

export class HumanContactError extends Error {
  constructor(message: string) { super(message); this.name = "HumanContactError"; }
}

/** Validates and seals person-entered details. The messages are fixed and never echo the input. */
export function humanEnteredContact(input: {
  businessName: string; phone?: string; email?: string; website?: string; address?: string;
  sourceType: string; sourceReference: string; attestedBy: string; attested: boolean; attestedAt?: string;
}): HumanEnteredContact {
  if (!(ENABLED_SOURCE_TYPES as readonly string[]).includes(input.sourceType)) throw new HumanContactError("That is not an allowed independent source type.");
  if (!input.attested) throw new HumanContactError("The attestation is required.");
  if (!input.attestedBy.trim()) throw new HumanContactError("The attesting person is required.");
  if (!input.sourceReference.trim()) throw new HumanContactError("A source reference is required.");
  if (!input.businessName.trim()) throw new HumanContactError("A business name is required.");
  const clean = (v?: string) => { const t = v?.trim(); return t ? t : undefined; };
  const sealed: HumanEnteredContactFields = {
    businessName: input.businessName.trim(), phone: clean(input.phone), email: clean(input.email), website: clean(input.website), address: clean(input.address),
    sourceType: input.sourceType as IndependentSourceType, sourceReference: input.sourceReference.trim(), attestedBy: input.attestedBy.trim(),
    attestedAt: input.attestedAt ?? new Date().toISOString(),
  };
  return Object.freeze(sealed) as HumanEnteredContact;
}

/** Type-level demonstration of the firewall: this accepts person-entered details only. (Used by a compile-time test.) */
export function acceptsHumanContactOnly(contact: HumanEnteredContact): string {
  return contact.sourceType;
}
