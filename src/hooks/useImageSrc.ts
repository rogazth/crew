import { useEffect, useState } from "react";
import { imageSrc } from "../lib/attachments";

/** Resolves to the image's data URL, or `null` while loading, when the file is gone, or for no path at all. */
export function useImageSrc(path: string): string | null {
  const [resolved, setResolved] = useState<{ path: string; src: string } | null>(null);
  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    imageSrc(path)
      .then((src) => {
        if (!cancelled) setResolved({ path, src });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [path]);
  return resolved?.path === path ? resolved.src : null;
}
