import type { OttoAnalysis } from "@/lib/otto/schema";
import { HeroBanner } from "./HeroBanner";
import { ThesisCard } from "./ThesisCard";
import { MetricsTable } from "./MetricsTable";
import { FundamentalTrendChart } from "./FundamentalTrendChart";
import { SnowflakeChart } from "./SnowflakeChart";
import { Disclaimer } from "./Disclaimer";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="otto-material otto-elevation-raised rounded-2xl border p-6 sm:p-8">
      <h2 className="otto-text-label mb-5 text-otto-text-faint">
        {title}
      </h2>
      {children}
    </section>
  );
}

export function ResearchCard({ analysis }: { analysis: OttoAnalysis }) {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <HeroBanner analysis={analysis} />

      <Section title="Why Now">
        <p className="text-sm leading-relaxed text-otto-text-muted">{analysis.synthesis}</p>
      </Section>

      <Section title="Otto Snowflake">
        <SnowflakeChart snowflake={analysis.snowflake} />
      </Section>

      <Section title="Thesis">
        <ThesisCard catalysts={analysis.catalysts} risks={analysis.risks} />
      </Section>

      <Section title="Financial Metrics">
        <MetricsTable metrics={analysis.metrics} />
      </Section>

      <Section title="Revenue · Earnings · Free Cash Flow">
        <FundamentalTrendChart data={analysis.fundamentalTrend} />
      </Section>

      <Disclaimer className="px-1" />
    </div>
  );
}
