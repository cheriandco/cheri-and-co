/** DEMO ONLY. Process-local, in-memory stand-in for a database. Nothing here is persistent or shared with anything.
 *
 *  Every visitor who changes something gets their own private copy of the sample data, found through a random
 *  cookie (no personal data, no account). One visitor's approvals, tasks and pipeline moves are never visible to
 *  another visitor. Copies expire after a couple of hours and are capped in number. Replace with Supabase queries
 *  inside the services once the production build is approved. */
import { cookies } from "next/headers";
import { isLive, requireAccess } from "@/lib/auth/access";
import { loadLiveStore } from "./live";
import { activities, approvals, deals, retailers, tasks } from "@/mocks/data";
import { socialPosts } from "@/mocks/social-samples";
import type { Activity, Approval, AuditEntry, Deal, Retailer, Task } from "@/types";
import type { SocialPost } from "@/types/social";

export interface Store {
  approvals: Approval[];
  tasks: Task[];
  deals: Deal[];
  audit: AuditEntry[];
  social: SocialPost[];
  retailers: Retailer[];
  /** Newest first. Agent and human actions in this visitor's demo session. */
  activity: Activity[];
  /** "agent:ref" -> approval id, so a suggestion shows its status instead of a second button. */
  links: Record<string, string>;
}

const seed = (): Store => ({
  approvals: structuredClone(approvals),
  tasks: structuredClone(tasks),
  deals: structuredClone(deals),
  audit: [],
  social: structuredClone(socialPosts),
  retailers: structuredClone(retailers),
  activity: structuredClone(activities),
  links: {},
});

const COOKIE = "cheri_demo_visitor";
const TTL_MS = 2 * 60 * 60 * 1000;
const MAX_VISITORS = 300;
const ID_PATTERN = /^[0-9a-f-]{36}$/;

const g = globalThis as unknown as {
  __imiStore?: Store;
  __demoVisitors?: Map<string, { store: Store; touched: number }>;
};

/** The untouched sample data. Served to visitors who have not changed anything, and never modified while the app
 *  serves requests. (Unit tests run outside a request and use it directly as their working copy.) */
export const store: Store = (g.__imiStore ??= seed());
const visitors = (g.__demoVisitors ??= new Map());

function prune(now: number) {
  for (const [id, v] of visitors) if (now - v.touched > TTL_MS) visitors.delete(id);
  while (visitors.size >= MAX_VISITORS) {
    const oldest = visitors.keys().next().value;
    if (oldest === undefined) break;
    visitors.delete(oldest);
  }
}

/** What the current visitor should see: their own copy if they have one, otherwise the pristine sample data. */
export async function readStore(): Promise<Store> {
  const user = await requireAccess("data:read"); // data-layer check: a page that skipped the layout or proxy still cannot read
  if (isLive(user)) return loadLiveStore(); // a live organisation reads its own database rows, never the sample data
  try {
    const id = (await cookies()).get(COOKIE)?.value;
    const mine = id && ID_PATTERN.test(id) ? visitors.get(id) : undefined;
    if (mine) { mine.touched = Date.now(); return mine.store; }
  } catch { /* no request context (unit tests): fall through to the default copy */ }
  return store;
}

/** The current visitor's private copy, created on their first change. Never returns the shared sample data while
 *  serving a request, so a visitor's change cannot reach anyone else. */
export async function writableStore(): Promise<Store> {
  const user = await requireAccess("data:read"); // who may change what is decided per route (deny); this blocks anonymous access
  // The sample store is a demo toy. A live organisation's writes go to the database through ./live, never here.
  if (isLive(user)) throw new Error("This action is not connected to the database yet");
  let jar: Awaited<ReturnType<typeof cookies>>;
  try {
    jar = await cookies();
  } catch {
    if (process.env.NODE_ENV === "test") return store;
    throw new Error("Demo changes need a request context");
  }
  const now = Date.now();
  const existing = jar.get(COOKIE)?.value;
  const id = existing && ID_PATTERN.test(existing) ? existing : crypto.randomUUID();
  let mine = visitors.get(id);
  if (!mine) { prune(now); mine = { store: seed(), touched: now }; }
  mine.touched = now;
  visitors.delete(id); // re-insert so the oldest entry is the least recently used
  visitors.set(id, mine);
  jar.set(COOKIE, id, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: TTL_MS / 1000 });
  return mine.store;
}
