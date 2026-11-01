"use client";

import { useActionState } from "react";
import { signInAction, type LoginState } from "./actions";

const initial: LoginState = { error: null };

export function LoginForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState(signInAction, initial);
  return (
    <form action={action} noValidate>
      <input type="hidden" name="next" value={next} />
      <div className="field">
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" autoComplete="username" required maxLength={254} />
      </div>
      <div className="field">
        <label htmlFor="password">Password</label>
        <input id="password" name="password" type="password" autoComplete="current-password" required maxLength={200} />
      </div>
      {state.error && <p role="alert" style={{ color: "var(--danger)", fontSize: 13, marginBottom: 12 }}>{state.error}</p>}
      <button className="btn primary" type="submit" disabled={pending} style={{ width: "100%" }}>
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
