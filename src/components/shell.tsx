"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  BarChart3, Bell, Building2, CheckCircle2, ChevronDown, ClipboardList, Gem, LayoutDashboard,
  LogOut, Megaphone, Menu, MessageCircleHeart, Search, Settings, ShoppingBag, Store, Users, UsersRound, X,
} from "lucide-react";
import { Avatar, Butterfly } from "./ui";
import type { AppNotification, User } from "@/types";

const NAV = [
  [
    { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
    { href: "/b2c", label: "B2C Sales", icon: MessageCircleHeart },
    { href: "/b2b", label: "B2B Leads", icon: Building2 },
    { href: "/amazon", label: "Amazon Intelligence", icon: ShoppingBag },
    { href: "/content", label: "Content & Marketing", icon: Megaphone },
    { href: "/crm", label: "CRM & Sales Ops", icon: UsersRound },
    { href: "/approvals", label: "Approvals", icon: CheckCircle2, badge: true },
  ],
  [
    { href: "/products", label: "Products", icon: Gem },
    { href: "/customers", label: "Customers", icon: Users },
    { href: "/retailers", label: "Retailers", icon: Store },
    { href: "/tasks", label: "Tasks & Follow-ups", icon: ClipboardList },
    { href: "/reports", label: "Reports", icon: BarChart3 },
  ],
  [{ href: "/settings", label: "Settings", icon: Settings }],
] as const;

interface SearchItem { label: string; hint: string; href: string }

export function AppShell({ user, notifications, searchIndex, pending, children }: {
  user: User; notifications: AppNotification[]; searchIndex: SearchItem[]; pending: number; children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  return (
    <div className="shell">
      <aside className={`sidebar ${open ? "open" : ""}`} aria-label="Primary">
        <div className="brand">
          <div className="brand-name"><Butterfly size={22} />IMI TIARA</div>
          <div className="brand-sub">AI Commerce &amp; Business Operations</div>
        </div>
        <nav className="nav">
          {NAV.map((group, gi) => (
            <div key={gi} style={{ display: "contents" }}>
              {gi > 0 && <hr />}
              {group.map((n) => {
                const active = pathname === n.href || pathname.startsWith(n.href + "/");
                return (
                  <Link key={n.href} href={n.href} aria-current={active ? "page" : undefined} onClick={() => setOpen(false)}>
                    <n.icon size={18} strokeWidth={1.5} />
                    {n.label}
                    {"badge" in n && pending > 0 && <span className="count" aria-label={`${pending} pending`}>{pending}</span>}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="userbox">
          <Avatar name={user.name} />
          <div className="who"><b>{user.name}</b><span>{user.role}</span></div>
          <button aria-label="Account menu" title="Account menu"><ChevronDown size={16} /></button>
          <button aria-label="Sign out" title="Sign out"><LogOut size={16} /></button>
        </div>
      </aside>
      {open && <div className="scrim" onClick={() => setOpen(false)} aria-hidden />}
      <div className="main">
        <Topbar notifications={notifications} searchIndex={searchIndex} onMenu={() => setOpen(true)} />
        <main className="content" id="main">{children}</main>
      </div>
    </div>
  );
}

function Topbar({ notifications, searchIndex, onMenu }: { notifications: AppNotification[]; searchIndex: SearchItem[]; onMenu: () => void }) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [bellOpen, setBellOpen] = useState(false);
  const bellRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setSearchOpen(true); }
      if (e.key === "Escape") { setBellOpen(false); setSearchOpen(false); }
    };
    const onClick = (e: MouseEvent) => { if (bellRef.current && !bellRef.current.contains(e.target as Node)) setBellOpen(false); };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("mousedown", onClick); };
  }, []);

  return (
    <header className="topbar">
      <button className="icon-btn menu-btn" onClick={onMenu} aria-label="Open navigation"><Menu size={18} /></button>
      <button className="search-btn" onClick={() => setSearchOpen(true)} aria-label="Search">
        <Search size={16} /> Search customers, retailers, products… <kbd>Ctrl K</kbd>
      </button>
      <div className="spacer" />
      <div className="rel" ref={bellRef}>
        <button className="icon-btn" aria-label="Notifications" aria-expanded={bellOpen} onClick={() => setBellOpen((v) => !v)}>
          <Bell size={17} />{notifications.length > 0 && <span className="dot" />}
        </button>
        {bellOpen && (
          <div className="popover" role="dialog" aria-label="Notifications">
            <div className="section-head" style={{ padding: "8px 12px 0", marginBottom: 6 }}><h2 style={{ fontSize: 20 }}>Notifications</h2></div>
            {notifications.length === 0 && <p className="muted" style={{ padding: 12 }}>You’re all caught up.</p>}
            {notifications.map((n) => (
              <Link key={n.id} href={n.href} onClick={() => setBellOpen(false)}>
                <b>{n.title}</b><small>{n.detail} · {n.time}</small>
              </Link>
            ))}
          </div>
        )}
      </div>
      {searchOpen && <SearchCommand items={searchIndex} onClose={() => setSearchOpen(false)} />}
    </header>
  );
}

const PAGES: SearchItem[] = NAV.flat().map((n) => ({ label: n.label, hint: "Page", href: n.href }));

function SearchCommand({ items, onClose }: { items: SearchItem[]; onClose: () => void }) {
  const [q, setQ] = useState("");
  const router = useRouter();
  const results = useMemo(() => {
    const all = [...PAGES, ...items];
    const t = q.trim().toLowerCase();
    return (t ? all.filter((i) => i.label.toLowerCase().includes(t)) : all.slice(0, 8)).slice(0, 10);
  }, [q, items]);

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="dialog cmd" role="dialog" aria-label="Search" onMouseDown={(e) => e.stopPropagation()}>
        <input
          autoFocus placeholder="Search IMI TIARA…" aria-label="Search" value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && results[0]) { router.push(results[0].href); onClose(); } }}
        />
        <div style={{ marginTop: 8 }}>
          {results.length === 0 && <p className="muted" style={{ padding: 10 }}>No results for “{q}”.</p>}
          {results.map((r) => (
            <Link key={r.href + r.label} href={r.href} onClick={onClose}>
              <span>{r.label}</span><span className="muted">{r.hint}</span>
            </Link>
          ))}
        </div>
        <button className="btn ghost sm" onClick={onClose} style={{ marginTop: 8 }}><X size={14} /> Close</button>
      </div>
    </div>
  );
}
