const FIELD = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day of week", min: 0, max: 7 },
];

/** Null when valid; a sentence naming the bad field otherwise. */
export function cronError(expression: string): string | null {
  const parts = expression.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "An expression is required.";
  if (parts.length !== 5) return `Five fields expected, got ${parts.length}.`;
  for (let i = 0; i < 5; i += 1) {
    const spec = FIELD[i]!;
    for (const chunk of parts[i]!.split(",")) {
      const [range, step] = chunk.split("/");
      if (step !== undefined && !/^\d+$/.test(step)) return `Bad step in ${spec.name}.`;
      if (range === "*") continue;
      const bounds = range!.split("-");
      if (bounds.length > 2) return `Bad range in ${spec.name}.`;
      for (const bound of bounds) {
        if (!/^\d+$/.test(bound)) return `Bad value "${bound}" in ${spec.name}.`;
        const n = Number(bound);
        if (n < spec.min || n > spec.max) {
          return `${spec.name} must be ${spec.min}–${spec.max}.`;
        }
      }
    }
  }
  return null;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export const dayName = (index: number): string => DAY_NAMES[index] ?? String(index);

export function clockLabel(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}
