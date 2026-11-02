/**
 * Where a setting lives. `global` follows the user across machines, `env` is
 * one machine's, `device` belongs to the computer the window runs on.
 */
export type SettingScope = "global" | "env" | "device";

export type SettingDef<T> = {
  key: string;
  scope: SettingScope;
  fallback: T;
  /** What a stored value means. `null` is the default; a value it cannot read must come back as `fallback`. */
  parse: (raw: string | null) => T;
  /** What to store: `null` for the default, so it is a choice other machines hear about too. */
  format: (value: T) => string | null;
};

export function defineSetting<T>(def: SettingDef<T>): SettingDef<T> {
  return def;
}
