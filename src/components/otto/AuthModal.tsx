"use client";

import { useState } from "react";
import { clsx } from "clsx";
import { createClient } from "@/lib/supabase/client";

export function AuthModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkEmail, setCheckEmail] = useState(false);

  if (!open) return null;

  async function handleGoogle() {
    setError(null);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    });
    if (error) setError(error.message);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    const supabase = createClient();

    if (mode === "sign-up") {
      const { error } = await supabase.auth.signUp({
        email,
        password,
        options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
      });
      if (error) setError(error.message);
      else setCheckEmail(true);
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) setError(error.message);
      else onClose();
    }
    setPending(false);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
      <div className="otto-material-thick otto-elevation-floating w-full max-w-sm rounded-2xl border p-6">
        {checkEmail ? (
          <div className="flex flex-col items-center gap-3 py-4 text-center">
            <p className="otto-text-title text-otto-text">Check your inbox</p>
            <p className="otto-text-body text-otto-text-muted">
              We sent a confirmation link to <span className="text-otto-text">{email}</span>. Click it to finish signing up.
            </p>
            <button
              onClick={onClose}
              className="otto-text-caption mt-2 rounded-full border border-otto-border px-4 py-1.5 text-otto-text-muted hover:text-otto-text"
            >
              Close
            </button>
          </div>
        ) : (
          <>
            <div className="mb-5 flex items-center justify-between">
              <p className="otto-text-title text-otto-text">{mode === "sign-in" ? "Sign in" : "Create account"}</p>
              <button onClick={onClose} aria-label="Close" className="otto-text-caption text-otto-text-faint hover:text-otto-text">
                ✕
              </button>
            </div>

            <button
              onClick={handleGoogle}
              className="otto-text-caption flex w-full items-center justify-center gap-2 rounded-full border border-otto-border bg-white/[0.04] py-2.5 font-medium text-otto-text hover:border-otto-text-faint"
            >
              <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true">
                <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.7-6.1 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.1 8.1 3.1l5.7-5.7C34.6 6 29.6 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.5-.4-3.5z" />
                <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.5 15.9 18.9 13 24 13c3.1 0 5.9 1.1 8.1 3.1l5.7-5.7C34.6 6 29.6 4 24 4 16.3 4 9.6 8.3 6.3 14.7z" />
                <path fill="#4CAF50" d="M24 44c5.5 0 10.4-1.9 14.3-5.1l-6.6-5.4C29.6 35.4 26.9 36.3 24 36.3c-5.2 0-9.6-3.3-11.2-7.9l-6.6 5.1C9.5 39.7 16.2 44 24 44z" />
                <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.2 4.2-4.1 5.5l6.6 5.4C39.9 36.6 44 30.9 44 24c0-1.3-.1-2.5-.4-3.5z" />
              </svg>
              Continue with Google
            </button>

            <div className="my-4 flex items-center gap-3">
              <div className="h-px flex-1 bg-otto-border-soft" />
              <span className="otto-text-caption text-otto-text-faint">or</span>
              <div className="h-px flex-1 bg-otto-border-soft" />
            </div>

            <form onSubmit={handleSubmit} className="flex flex-col gap-3">
              <input
                type="email"
                required
                placeholder="Email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="otto-text-body rounded-full border border-otto-border bg-otto-bg-raised px-4 py-2.5 text-otto-text placeholder:text-otto-text-faint focus:outline-none focus:border-otto-text-faint"
              />
              <input
                type="password"
                required
                minLength={6}
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="otto-text-body rounded-full border border-otto-border bg-otto-bg-raised px-4 py-2.5 text-otto-text placeholder:text-otto-text-faint focus:outline-none focus:border-otto-text-faint"
              />
              {error && <p className="otto-text-caption text-otto-bear">{error}</p>}
              <button
                type="submit"
                disabled={pending}
                className="otto-text-caption mt-1 rounded-full bg-otto-gold py-2.5 font-medium text-otto-bg transition-opacity hover:opacity-90 disabled:opacity-40"
              >
                {pending ? "Please wait…" : mode === "sign-in" ? "Sign in" : "Sign up"}
              </button>
            </form>

            <p className="otto-text-caption mt-4 text-center text-otto-text-faint">
              {mode === "sign-in" ? "New to Otto?" : "Already have an account?"}{" "}
              <button
                onClick={() => {
                  setMode(mode === "sign-in" ? "sign-up" : "sign-in");
                  setError(null);
                }}
                className={clsx("font-medium text-otto-gold hover:opacity-80")}
              >
                {mode === "sign-in" ? "Sign up" : "Sign in"}
              </button>
            </p>
          </>
        )}
      </div>
    </div>
  );
}
