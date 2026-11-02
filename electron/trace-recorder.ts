// For tests of the modules that write to main's trace: what they traced, as the file would hold it
// (the same sanitising), without a file. Used from a factory:
//
//     vi.mock("./trace", async () => (await import("./trace-recorder")).mockedTrace());
//     import { lines } from "./trace-recorder";
import { errorText, sanitizeFields, type TraceFields } from "../src/lib/trace";

export type Line = { level: "INFO" | "WARN" | "ERROR"; message: string; fields: Record<string, unknown> };

export const lines: Line[] = [];

export function named(message: string): Line[] {
  return lines.filter((line) => line.message === message);
}

export function mockedTrace() {
  const at = (level: Line["level"]) => (message: string, fields?: TraceFields) => {
    lines.push({ level, message, fields: sanitizeFields(fields) });
  };
  return { errorText, trace: { info: at("INFO"), warn: at("WARN"), error: at("ERROR"), window: () => {}, flush: () => {} } };
}
