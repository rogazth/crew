// A provider with no plan windows (opencode) reports what the last week cost.
import type { Reading } from "../lib/usageData";

function count(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}

/** Tokens and cost over the last seven days; nothing when the provider reports neither. */
export function Tokens({ reading }: { reading: Reading }) {
  if (reading.tokens === null && reading.cost === null) return null;
  return (
    <div className="flex items-baseline justify-between text-[12px]">
      <span>Last 7 days</span>
      <span className="text-text-muted tabular-nums">
        {reading.tokens !== null && `${count(reading.tokens)} tokens`}
        {reading.tokens !== null && reading.cost !== null && " · "}
        {reading.cost !== null && `$${reading.cost.toFixed(2)}`}
      </span>
    </div>
  );
}
