/** Runs docs/security_hardening_live_check.sql (the script meant for the STAGING project) against an in-process Postgres.
 *  This proves the script itself works and that every check passes against the real migrations' SQL. It is NOT a hosted run:
 *  the hosted result has to be produced by pasting the script into the staging SQL editor (docs/STAGING_SETUP_AND_VERIFICATION.md). */
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

const stub = `
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create schema auth;
  create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
`;

describe("the staging check script (local, in-process Postgres; not a hosted run)", () => {
  it("every check in docs/security_hardening_live_check.sql passes against the foundation + hardening migrations", async () => {
    const db = new PGlite();
    try {
      await db.exec(stub);
      await db.exec(readFileSync("supabase/migrations/20261101000000_foundation.sql", "utf8"));
      await db.exec(readFileSync("supabase/migrations/20261104000000_security_hardening.sql", "utf8"));
      const results = await db.exec(readFileSync("docs/security_hardening_live_check.sql", "utf8"));
      const report = results.filter((r) => r.rows.length > 1).at(-1)!.rows as { section: string; test: string; result: string; actual: string }[];
      const failed = report.filter((r) => r.result === "FAIL");
      expect(failed.map((r) => `${r.section}: ${r.test} -> ${r.actual}`)).toEqual([]);
      expect(report[0].test).toMatch(/^ALL \d+ CHECKS PASSED$/);
      expect(report.length).toBeGreaterThan(50);
      // the script ends with ROLLBACK: nothing it created may remain
      expect((await db.query("select count(*)::int n from public.content_items")).rows[0]).toEqual({ n: 0 });
      expect((await db.query("select count(*)::int n from auth.users")).rows[0]).toEqual({ n: 0 });
    } finally { await db.close(); }
  });
});
