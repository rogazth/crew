import { useEffect, useState } from "react";

/** The time, moved forward every `everyMs` while `ticking`; frozen otherwise. */
export function useNow(everyMs: number, ticking = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs, ticking]);
  return now;
}
