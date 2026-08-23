import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/** Lands here after Google OAuth or an email confirmation/magic link —
 * exchanges the one-time code for a real session, then redirects into the
 * app. Both auth methods route through the same handler. */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/";

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  return NextResponse.redirect(`${origin}/auth/error`);
}
