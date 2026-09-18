import { memo, type CSSProperties } from "react";
import { identityFor } from "@crew/fixtures";
import { cx } from "@/lib/cx";
import { Icon } from "@/lib/icon";
import { providerOf } from "@crew/fixtures";

export type AvatarProps = {
  seed: string;
  size?: number;
  className?: string;
  /** Terminals are not agents; they get a glyph instead of a monogram. */
  kind?: "agent" | "terminal";
  title?: string;
};

/**
 * The identity mark. `identityFor` owns the seed→hue mapping, so the same agent
 * draws the same tile everywhere: sidebar, tab, palette, agent-letter rail.
 */
export const Avatar = memo(function Avatar({
  seed,
  size = 20,
  className,
  kind = "agent",
  title,
}: AvatarProps) {
  const identity = identityFor(seed);
  const style = {
    "--tint": `oklch(var(--avatar-l) var(--avatar-c) ${identity.hue})`,
    width: size,
    height: size,
    borderRadius: size <= 18 ? 5 : size <= 28 ? 7 : 10,
    fontSize: Math.max(8, Math.round(size * 0.42)),
  } as CSSProperties;

  if (kind === "terminal") {
    return (
      <span
        title={title ?? seed}
        style={{ ...style, width: size, height: size }}
        className={cx(
          "inline-flex shrink-0 items-center justify-center bg-[var(--fill-tertiary)] text-tertiary",
          className,
        )}
      >
        <Icon name="terminal" size={Math.round(size * 0.62)} />
      </span>
    );
  }

  return (
    <span
      title={title ?? seed}
      aria-hidden
      style={style}
      className={cx(
        "inline-flex shrink-0 select-none items-center justify-center",
        "bg-[color-mix(in_oklch,var(--tint)_20%,var(--surface-canvas))]",
        "text-[color-mix(in_oklch,var(--tint)_88%,var(--ink))]",
        "font-[var(--weight-strong)] tracking-[0.02em]",
        "shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--tint)_22%,transparent)]",
        className,
      )}
    >
      {identity.initials}
    </span>
  );
});

/**
 * Provider marks are monograms, not logos — one icon set means no second icon
 * set, and a wordmark is a second icon set wearing a hat.
 */
export const ProviderMark = memo(function ProviderMark({
  provider,
  size = 16,
  className,
}: {
  provider: string;
  size?: number;
  className?: string;
}) {
  const label = providerOf(provider)?.label ?? provider;
  return (
    <span
      title={label}
      aria-hidden
      style={{ width: size, height: size, borderRadius: size <= 16 ? 4 : 6, fontSize: Math.max(8, Math.round(size * 0.55)) }}
      className={cx(
        "inline-flex shrink-0 select-none items-center justify-center",
        "bg-[var(--fill-tertiary)] font-[var(--weight-strong)] uppercase leading-none text-tertiary",
        className,
      )}
    >
      {label[0]}
    </span>
  );
});
