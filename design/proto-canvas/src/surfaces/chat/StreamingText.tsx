import { memo, useEffect, useRef } from "react";

/**
 * Word-by-word fade for the streaming reply.
 *
 * Each word is its own span, mounted once: the CSS animation runs on mount and
 * never again, so a settled paragraph cannot re-animate when a later token
 * arrives. The fade length tracks how fast tokens are arriving — slow models
 * get a longer fade, a burst gets a short one.
 */
export const StreamingText = memo(function StreamingText({ text }: { text: string }) {
  const seen = useRef({ at: 0, gap: 220 });
  const now = performance.now();
  if (seen.current.at > 0) {
    const delta = now - seen.current.at;
    seen.current.gap = seen.current.gap * 0.7 + Math.min(600, delta) * 0.3;
  }
  seen.current.at = now;

  useEffect(() => () => {
    seen.current = { at: 0, gap: 220 };
  }, []);

  const words = text.match(/\S+\s*|\s+/g) ?? [];
  const fade = Math.round(Math.min(420, Math.max(120, seen.current.gap * 3)));

  return (
    <p className="whitespace-pre-wrap break-words" style={{ ["--fade" as string]: `${fade}ms` }}>
      {words.map((word, index) => (
        <span key={index} className="word-in">
          {word}
        </span>
      ))}
    </p>
  );
});
