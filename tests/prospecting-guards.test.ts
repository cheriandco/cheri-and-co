import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** Structural guards for Phases 2 and 3. They prove the module cannot reach a network, a database, a credential or a message channel,
 *  and that nothing in the existing application depends on it. */
const root = process.cwd();
const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : []; });
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const moduleDir = join(root, "src", "lib", "prospecting");
const files = walk(moduleDir);
const code = (f: string) => strip(readFileSync(f, "utf8"));
const rel = (f: string) => relative(root, f).replace(/\\/g, "/");

describe("the prospecting module is isolated", () => {
  it("exists with scoring and places folders", () => {
    expect(files.length).toBeGreaterThan(15);
    expect(existsSync(join(moduleDir, "scoring", "rubric.ts"))).toBe(true);
    expect(existsSync(join(moduleDir, "places", "client.ts"))).toBe(true);
  });
  it("contains no network code and no Google host name (the only transport is a test fake)", () => {
    for (const f of files) {
      const c = code(f);
      expect(c, rel(f)).not.toMatch(/\bfetch\s*\(/);
      expect(c, rel(f)).not.toMatch(/XMLHttpRequest|WebSocket|node:https?|from "https?"|axios|undici/);
      expect(c, rel(f)).not.toMatch(/googleapis|places\.google|goog-api-key|X-Goog-Api-Key/i);
    }
  });
  it("reads the environment only in places/config.ts, and only the kill switch", () => {
    for (const f of files) {
      const c = code(f);
      if (rel(f).endsWith("places/config.ts")) { expect(c).toContain("GOOGLE_PLACES_ENABLED"); expect(c).not.toMatch(/API_KEY|SECRET|TOKEN/i); continue; }
      expect(c, rel(f)).not.toMatch(/process\.env|import\.meta\.env|Deno\.env/);
    }
  });
  it("holds no credential, key-shaped string or API key option", () => {
    for (const f of files) expect(code(f), rel(f)).not.toMatch(/AIza[0-9A-Za-z_-]{20,}|apiKey|api_key|GOOGLE_PLACES_API_KEY/);
  });
  it("imports nothing from the database, the web framework or the existing application", () => {
    for (const f of files) {
      const imports = [...code(f).matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
      for (const i of imports) {
        expect(i, `${rel(f)} imports ${i}`).not.toMatch(/^next|^react|supabase|^@\/(services|app|components|mocks|lib\/(auth|amazon|supabase|agents|agent-logic|import))/);
        if (!i.startsWith(".")) expect(i, rel(f)).toMatch(/^node:|^@\/lib\/prospecting/);
      }
    }
  });
  it("scoring does not import the Places client or mappers; the client does not import scoring", () => {
    for (const f of files.filter((x) => rel(x).includes("/scoring/"))) expect(code(f), rel(f)).not.toMatch(/from "\.\.\/places|prospecting\/places/);
    for (const f of files.filter((x) => rel(x).includes("/places/"))) expect(code(f), rel(f)).not.toMatch(/from "\.\.\/scoring|prospecting\/scoring/);
  });
  it("has no way to send a message (no email, SMS, WhatsApp or webhook code)", () => {
    for (const f of files) expect(code(f), rel(f)).not.toMatch(/sendMessage|nodemailer|smtp|twilio|sendgrid|webhook|api\.whatsapp|graph\.facebook/i);
  });
  it("uses no `any` and no console output", () => {
    for (const f of files) { expect(code(f), rel(f)).not.toMatch(/:\s*any\b|\bas any\b|<any>/); expect(code(f), rel(f)).not.toMatch(/console\./); }
  });
  it("writes no SQL and touches no database table", () => {
    for (const f of files) expect(code(f), rel(f)).not.toMatch(/\bcreate table\b|\balter table\b|\.from\(\s*["'`]|\.rpc\(|\binsert into\b/i);
  });
  it("nothing in the existing application imports the module yet", () => {
    for (const f of walk(join(root, "src")).filter((x) => !x.startsWith(moduleDir))) expect(readFileSync(f, "utf8"), rel(f)).not.toMatch(/lib\/prospecting|from "@\/lib\/prospecting/);
  });
  it("adds no migration and no dependency", () => {
    const migrations = readdirSync(join(root, "supabase", "migrations")).sort();
    // The third file is the reviewed, NOT-yet-applied revoke of rls_auto_enable() EXECUTE. No ai_usage migration exists: AI spend limits use agent_activity.
    expect(migrations).toEqual(["20261101000000_foundation.sql", "20261111000000_amazon_intelligence.sql", "20261112000000_revoke_rls_auto_enable_execute.sql"]);
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    expect(Object.keys(pkg.dependencies).sort()).toEqual(["@supabase/ssr", "@supabase/supabase-js", "lucide-react", "next", "react", "react-dom"]);
    expect(Object.keys(pkg.devDependencies).sort()).toEqual(["@electric-sql/pglite", "@types/node", "@types/react", "@types/react-dom", "eslint", "eslint-config-next", "typescript", "vitest"]);
  });
  it(".env.example names only the kill switch (off) and holds no key value", () => {
    const env = readFileSync(join(root, ".env.example"), "utf8");
    expect(env).toMatch(/^GOOGLE_PLACES_ENABLED=false$/m);
    expect(env).not.toMatch(/NEXT_PUBLIC_GOOGLE/);
    expect(env).not.toMatch(/^GOOGLE_PLACES_API_KEY=\S+/m);
    expect(env).not.toMatch(/AIza/);
  });
});
