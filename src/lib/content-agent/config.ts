/** Server-side configuration seam for the planned Anthropic Claude drafting. Claude drafting is NOT implemented:
 *  the template generator is the only generator. This module makes no network call, never reads ANTHROPIC_API_KEY
 *  (or any other key), and nothing here is sent to the browser. A Claude Team subscription does not include API
 *  access; live drafting needs an Anthropic Console API key and separate usage billing (see docs/API.md §1.4). */

export interface GeneratorChoice {
  generator: "template";
  /** True when the reserved Claude flag is switched on. It changes nothing except the note below. */
  claudeRequested: boolean;
  note?: string;
}

export function isClaudeRequested(env: Record<string, string | undefined> = process.env): boolean {
  return env.CONTENT_AGENT_USE_CLAUDE === "true";
}

/** Always returns the template generator today. When the flag is on it says so instead of silently ignoring it. */
export function chooseGenerator(env: Record<string, string | undefined> = process.env): GeneratorChoice {
  return isClaudeRequested(env)
    ? { generator: "template", claudeRequested: true, note: "Claude drafting is switched on but not built yet, so the template generator was used. No Claude API call was made." }
    : { generator: "template", claudeRequested: false };
}
