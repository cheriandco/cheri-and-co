/** Secret redaction. Anything that might reach a log, an error message, a database row or a response goes through `redact` first.
 *  Refresh tokens, client secrets, access tokens and presigned-URL signatures must never be written anywhere. */

const PATTERNS: RegExp[] = [
  /Atz[ra]\|[A-Za-z0-9_\-|.=+/]+/g, // LWA refresh ("Atzr|") and access ("Atza|") tokens
  /Bearer\s+[A-Za-z0-9_\-|.=+/]+/gi,
  /\b(client_secret|refresh_token|access_token|x-amz-access-token|authorization)(["'\s:=]+)[^"'\s&,}]+/gi,
  /([?&](?:X-Amz-Signature|X-Amz-Security-Token|X-Amz-Credential|Signature|AWSAccessKeyId)=)[^&\s"']+/gi,
];

/** Replaces known secret values (when at least 8 characters) and anything that looks like a token or signature. */
export function redact(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 8) out = out.split(s).join("[redacted]");
  out = out.replace(PATTERNS[0], "[redacted]").replace(PATTERNS[1], "Bearer [redacted]");
  out = out.replace(PATTERNS[2], (_m, key: string, sep: string) => `${key}${sep}[redacted]`);
  out = out.replace(PATTERNS[3], (_m, prefix: string) => `${prefix}[redacted]`);
  return out;
}

/** A short, safe message: redacted, single-line, truncated. */
export function safeMessage(text: unknown, secrets: readonly string[] = [], max = 300): string {
  const raw = typeof text === "string" ? text : text instanceof Error ? text.message : "";
  const clean = redact(raw, secrets).replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}
