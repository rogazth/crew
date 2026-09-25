/** The daemon reads the same key: whole days, absent keeps sessions forever. */
export const RETENTION_KEY = "sessions:retention";

export type Retention = "never" | "7" | "30" | "90";

export const RETENTION_CHOICES: { value: Retention; label: string }[] = [
  { value: "never", label: "Never" },
  { value: "7", label: "After 7 days" },
  { value: "30", label: "After 30 days" },
  { value: "90", label: "After 90 days" },
];

export function parseRetention(raw: string | null): Retention {
  const value = raw?.trim();
  return RETENTION_CHOICES.find((choice) => choice.value === value)?.value ?? "never";
}

