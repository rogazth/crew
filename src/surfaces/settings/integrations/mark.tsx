// A connector's mark: its registry icon, else its publisher's favicon, else a
// monogram on a hue drawn from its name.
import { useState } from "react";
import type { Brand } from "./brand";

/** Where a logo can come from: the registry's icon, then the publisher's favicon through Google's resolver. */
function logosOf(brand: Brand): string[] {
  const favicon = brand.publisher.includes(".")
    ? [`https://www.google.com/s2/favicons?domain=${encodeURIComponent(brand.publisher)}&sz=128`]
    : [];
  return brand.logo ? [brand.logo, ...favicon] : favicon;
}

const hueOf = (id: string) => [...id].reduce((n, ch) => n + ch.charCodeAt(0) * 13, 0) % 360;

/** The real logo on paper when one loads, else a monogram on the brand's hue. */
export function ServiceMark({ brand, size = 32, className = "" }: { brand: Brand | undefined; size?: number; className?: string }) {
  const [failed, setFailed] = useState<string[]>([]);
  if (!brand) return <span className={`shrink-0 rounded-[28%] bg-fill ${className}`} style={{ width: size, height: size }} />;
  const logo = logosOf(brand).find((src) => !failed.includes(src));
  if (logo) {
    const fail = () => setFailed((now) => [...now, logo]);
    return (
      <span
        aria-hidden
        className={`relative grid shrink-0 place-items-center overflow-hidden rounded-[26%] bg-white after:absolute after:inset-0 after:rounded-[inherit] after:shadow-[inset_0_0_0_1px_oklch(0%_0_0/0.08)] ${className}`}
        style={{ width: size, height: size }}
      >
        <img
          src={logo}
          alt=""
          loading="lazy"
          className="size-full object-contain"
          onError={fail}
          // Google's resolver answers a miss with its own 16px globe, not a 404.
          onLoad={(event) => event.currentTarget.naturalWidth <= 16 && fail()}
        />
      </span>
    );
  }
  const glyph = brand.name.trim().charAt(0).toUpperCase() || "?";
  const hue = hueOf(brand.id);
  // Quiet on purpose: a tint of the hue and the letter in it, so a page of
  // unknown servers doesn't outshout the real logos beside them.
  return (
    <span
      aria-hidden
      className={`grid shrink-0 place-items-center rounded-[28%] font-semibold tracking-[-0.04em] shadow-[inset_0_0_0_1px_var(--color-hairline)] select-none ${className}`}
      style={{
        width: size,
        height: size,
        background: `color-mix(in oklch, oklch(62% 0.07 ${hue}) 16%, var(--color-surface))`,
        color: `oklch(52% 0.08 ${hue})`,
        fontSize: Math.round(size * 0.46),
      }}
    >
      {glyph}
    </span>
  );
}
