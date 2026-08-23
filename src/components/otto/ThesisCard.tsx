export function ThesisCard({
  catalysts,
  risks,
}: {
  catalysts: readonly string[];
  risks: readonly string[];
}) {
  return (
    <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
      <div>
        <h3 className="otto-text-label mb-3 text-otto-bull">
          Growth Catalysts
        </h3>
        <ul className="space-y-2.5">
          {catalysts.map((c, i) => (
            <li key={i} className="flex gap-2.5 text-sm leading-relaxed text-otto-text">
              <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-otto-bull" />
              {c}
            </li>
          ))}
        </ul>
      </div>
      <div>
        <h3 className="otto-text-label mb-3 text-otto-bear">
          Key Risks
        </h3>
        <ul className="space-y-2.5">
          {risks.map((r, i) => (
            <li key={i} className="flex gap-2.5 text-sm leading-relaxed text-otto-text">
              <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-otto-bear" />
              {r}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
