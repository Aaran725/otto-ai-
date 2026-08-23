"use client";

import { createBrowserClient } from "@supabase/ssr";

/** Browser-side Supabase client — reads the session from cookies, subject
 * to Row Level Security for every query (no service-role key ever ships to
 * the client). Created lazily so it's safe to import from any client
 * component. */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
