import type { Metadata } from "next";
import Image from "next/image";
import { safeNext } from "@/lib/auth/paths";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const { next } = await searchParams;
  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 16 }}>
      <div className="card" style={{ width: "100%", maxWidth: 380 }}>
        <div style={{ background: "var(--rose-soft)", borderRadius: 12, padding: "14px 18px", marginBottom: 20, display: "flex", justifyContent: "center" }}>
          <Image src="/brand/cheri-and-co-wordmark.png" alt="Cheri & Co." width={150} height={44} priority style={{ height: "auto", width: 150 }} />
        </div>
        <h1 style={{ fontSize: 22, marginBottom: 4 }}>Sign in</h1>
        <p className="muted" style={{ fontSize: 13, marginBottom: 18 }}>Access is by invitation. Contact your administrator for an account.</p>
        <LoginForm next={safeNext(Array.isArray(next) ? next[0] : next)} />
      </div>
    </main>
  );
}
