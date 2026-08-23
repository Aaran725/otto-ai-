import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

/** Server-side Supabase client for Server Components / Route Handlers —
 * reads and writes the session via Next's cookie store so auth state stays
 * in sync with the browser client. Server Components can't write cookies,
 * so the setAll there is wrapped in a try/catch and relies on middleware to
 * actually persist the refreshed session. */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
          } catch (err) {
            // Expected when called from a Server Component render (cookies
            // are read-only there) — middleware refreshes the session cookie
            // instead. Logged rather than fully silent so a *real* failure
            // (e.g. in a Route Handler, where writes should succeed) is
            // still visible instead of silently dropping the session.
            console.error("[supabase/server] cookie setAll failed:", err instanceof Error ? err.message : err);
          }
        },
      },
    }
  );
}
