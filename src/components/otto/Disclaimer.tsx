export function Disclaimer({ className = "" }: { className?: string }) {
  return (
    <p className={`text-[10px] leading-relaxed text-otto-text-faint ${className}`}>
      Not financial advice. Informational only — investing involves risk of loss. Do your own research.
    </p>
  );
}
