import type { Session, SessionKind } from "./types";

/** What the sidebar hides. Empty lists mean "show everything", so the default is free. */
export type SessionFilters = {
  hiddenKinds: SessionKind[];
  hiddenProviders: string[];
};

export const NO_FILTERS: SessionFilters = { hiddenKinds: [], hiddenProviders: [] };

export function hasFilters(filters: SessionFilters): boolean {
  return filters.hiddenKinds.length > 0 || filters.hiddenProviders.length > 0;
}

export function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

export function applyFilters(sessions: Session[], filters: SessionFilters): Session[] {
  if (!hasFilters(filters)) return sessions;
  return sessions.filter(
    (session) =>
      !filters.hiddenKinds.includes(session.kind) &&
      !filters.hiddenProviders.includes(session.provider),
  );
}
