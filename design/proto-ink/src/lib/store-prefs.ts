import { useCallback, useState } from "react";

const NS = "ink:";

export function readPref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(NS + key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function writePref<T>(key: string, value: T) {
  try {
    localStorage.setItem(NS + key, JSON.stringify(value));
  } catch {
    /* private mode; preferences are a convenience, not state we depend on */
  }
}

export function usePref<T>(key: string, fallback: T): [T, (next: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => readPref(key, fallback));
  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const resolved = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
        writePref(key, resolved);
        return resolved;
      });
    },
    [key],
  );
  return [value, set];
}
