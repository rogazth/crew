import { useEffect, useState } from "react";
import { imageSrc } from "../lib/attachments";

/** Resolves to the image's data URL, or `null` while loading or when the file is gone. */
export function useImageSrc(path: string): string | null {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setSrc(null);
    imageSrc(path)
      .then((url) => {
        if (!cancelled) setSrc(url);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [path]);
  return src;
}
