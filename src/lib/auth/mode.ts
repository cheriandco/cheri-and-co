/** How the app treats visitors.
 *  - "demo" (default): the public sample demo. No sign-in, sample data only, nothing is stored in Supabase.
 *  - "required": every page and API call needs a verified Supabase session and an organisation membership.
 *  Anything other than the exact value "required" is demo, so the live demo keeps working with no configuration. */
export type AuthMode = "demo" | "required";

export const authMode = (): AuthMode => (process.env.AUTH_MODE?.trim() === "required" ? "required" : "demo");
export const authRequired = (): boolean => authMode() === "required";
