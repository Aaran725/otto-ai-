"use client";

import { createContext, useContext, useEffect, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { createClient } from "./client";

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({ user: null, loading: true, signOut: async () => {} });

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const supabase = createClient();

    // getSession() reads the (possibly chunked) session cookie locally —
    // no network round-trip, so it can't silently hang the way getUser()'s
    // server verification call could (that was leaving `loading` stuck
    // true forever on any transient failure, with the sign-in button never
    // updating even though the session cookie was actually there).
    supabase.auth
      .getSession()
      .then(({ data, error }) => {
        if (error) console.error("[auth] getSession failed:", error.message);
        setUser(data.session?.user ?? null);
        setLoading(false);
      })
      .catch((err) => {
        console.error("[auth] getSession threw:", err instanceof Error ? err.message : err);
        setLoading(false);
      });

    // Keeps `user` in sync across sign-in/out and token refresh, including
    // tab-to-tab changes (e.g. signing out in one tab reflects in another).
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
      setLoading(false);
    });

    return () => listener.subscription.unsubscribe();
  }, []);

  async function signOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    setUser(null);
  }

  return <AuthContext.Provider value={{ user, loading, signOut }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
