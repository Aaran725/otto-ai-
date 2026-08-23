import Link from "next/link";

export const metadata = { title: "Terms of Service — Otto AI" };

export default function TermsPage() {
  return (
    <div className="mx-auto min-h-screen max-w-2xl px-6 py-16 text-otto-text">
      <Link href="/" className="otto-text-caption text-otto-gold hover:opacity-80">
        ← Back to Otto
      </Link>
      <h1 className="otto-text-display mt-6">Terms of Service</h1>
      <p className="otto-text-caption mt-2 text-otto-text-faint">Last updated: August 23, 2026</p>

      <div className="otto-text-body mt-8 flex flex-col gap-5 text-otto-text-muted">
        <section>
          <h2 className="otto-text-title mb-2 text-otto-text">Not financial advice</h2>
          <p>
            Everything Otto AI produces — conviction scores, verdicts, price forecasts, catalysts, risks — is
            informational and generated from public data and automated analysis. It is not financial, investment,
            legal, or tax advice, and it is not a recommendation to buy or sell any security. Investing involves
            risk, including loss of principal. Do your own research and consult a licensed advisor before making
            investment decisions.
          </p>
        </section>

        <section>
          <h2 className="otto-text-title mb-2 text-otto-text">No guarantee of accuracy</h2>
          <p>
            Otto pulls data from third-party providers (Financial Modeling Prep, Finnhub, Alpaca, SEC EDGAR, FRED)
            and combines it with automated, model-generated analysis. This data can be delayed, incomplete, or
            wrong. We make no guarantee about the accuracy, completeness, or timeliness of anything shown in the
            app.
          </p>
        </section>

        <section>
          <h2 className="otto-text-title mb-2 text-otto-text">Your account</h2>
          <p>
            If you create an account, you&apos;re responsible for keeping your login credentials secure. You can
            stop using Otto and request account deletion at any time.
          </p>
        </section>

        <section>
          <h2 className="otto-text-title mb-2 text-otto-text">Acceptable use</h2>
          <p>
            Don&apos;t use Otto to scrape, resell, or redistribute its data/analysis at scale, and don&apos;t
            attempt to abuse, overload, or circumvent the service.
          </p>
        </section>

        <section>
          <h2 className="otto-text-title mb-2 text-otto-text">Changes</h2>
          <p>
            We may update these terms as the app changes. Continuing to use Otto after an update means you accept
            the revised terms.
          </p>
        </section>

        <section>
          <h2 className="otto-text-title mb-2 text-otto-text">Contact</h2>
          <p>Questions: chowdherya0725@gmail.com</p>
        </section>
      </div>
    </div>
  );
}
