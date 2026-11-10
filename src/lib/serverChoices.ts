import { defineSetting } from "./settingsEngine/define";

/**
 * Whether each server the CLIs have is on in Crew, by its service's key (a
 * registry name, else its name): one choice for every machine. A server never
 * chosen keeps each copy's own switch. Connectors writes the choice to every
 * machine's daemon (surfaces/settings/integrations/providers.ts).
 */
export type ServerChoices = Readonly<Record<string, boolean>>;

const NONE: ServerChoices = {};

export function parseServerChoices(raw: string | null): ServerChoices {
  if (!raw) return NONE;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return NONE;
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"));
  } catch {
    return NONE;
  }
}

export const serverChoicesSetting = defineSetting<ServerChoices>({
  key: "app:server-choices",
  scope: "global",
  fallback: NONE,
  parse: parseServerChoices,
  format: (value) => (Object.keys(value).length === 0 ? null : JSON.stringify(value)),
});
