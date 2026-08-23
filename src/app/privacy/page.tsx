import Link from "next/link";

export const metadata = { title: "Privacy Policy — Otto AI" };

export default function PrivacyPage() {
  return (
    <div className="mx-auto min-h-screen max-w-2xl px-6 py-16 text-otto-text">
      <Link href="/" className="otto-text-caption text-otto-gold hover:opacity-80">
        ← Back to Otto
      </Link>
      <h1 className="otto-text-display mt-6">Privacy Policy</h1>
      <p className="otto-text-caption mt-2 text-otto-text-faint">Last updated: August 23, 2026</p>

      <div className="otto-text-body mt-8 flex flex-col gap-5 text-otto-text-muted">
        <p>
          Otto AI (&ldquo;Otto,&rdquo; &ldquo;we&rdquo;) is a stock-research tool. This page explains what data we
          collect and how it&apos;s used, in plain language.
        </p>

        <section>
          <h2 className="otto-text-title mb-2 text-otto-text">What we collect</h2>
          <p>
            If you sign in, we collect your email address and, if you use Google sign-in, the basic profile
            information Google shares (name, email, profile photo). We use this only to identify your account —
            we don&apos;t use it for anything else, and we don&apos;t sell or share it with third parties for
            marketing.
          </p>
          <p className="mt-2">
            Once signed in, any stocks you add to your watchlist and every analysis Otto runs for you are stored
            against your account so they sync across devices. If you never sign in, this data stays only in your
            browser&apos;s local storage and is never sent to us.
          </p>
        </section>

        <section>
          <h2 className="otto-text-title mb-2 text-otto-text">Third-party data providers</h2>
          <p>
            Otto pulls real market and company data from Financial Modeling Prep, Finnhub, Alpaca Markets, the
            SEC&apos;s public EDGAR system, and FRED to build its analysis. Ticker symbols and company names you
            search for are sent to these providers to fetch data — no other personal information is shared with
            them.
          </p>
        </section>

        <section>
          <h2 className="otto-text-title mb-2 text-otto-text">Authentication</h2>
          <p>
            Sign-in is handled by Supabase Auth. Your password (if you use email sign-in) is never stored or seen
            by Otto directly — Supabase handles that securely. Session data is stored in your browser via cookies
            to keep you signed in.
          </p>
        </section>

        <section>
          <h2 className="otto-text-title mb-2 text-otto-text">Your data, your control</h2>
          <p>
            You can remove any stock from your watchlist at any time. To delete your account and all associated
            data entirely, contact us at the email below.
          </p>
        </section>

        <section>
          <h2 className="otto-text-title mb-2 text-otto-text">Contact</h2>
          <p>Questions about this policy: chowdherya0725@gmail.com</p>
        </section>
      </div>
    </div>
  );
}
