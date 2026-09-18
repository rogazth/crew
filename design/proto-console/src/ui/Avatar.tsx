import clsx from "clsx";
import { avatarDataUri, identityFor } from "@crew/fixtures";
import { monogramOf } from "@/lib/format";

/**
 * Identity, not decoration. The seed is the contract, so the same name always
 * draws the same mark.
 */
export function Avatar({
  seed,
  size = 20,
  className,
}: {
  seed: string;
  size?: number;
  className?: string;
}) {
  return (
    <img
      src={avatarDataUri(seed, size * 2)}
      alt=""
      width={size}
      height={size}
      style={{ width: size, height: size }}
      className={clsx("shrink-0 rounded-[var(--r)]", className)}
    />
  );
}

/** A provider is two mono letters in a tinted box. Never a logo. */
export function ProviderMark({
  provider,
  size = 14,
  className,
}: {
  provider: string;
  size?: number;
  className?: string;
}) {
  const hue = identityFor(provider).hue;
  return (
    <span
      title={provider}
      style={{
        width: size,
        height: size,
        fontSize: size <= 14 ? 8 : 9,
        background: `oklch(var(--id-bg-l) var(--id-c) ${hue} / var(--id-bg-a))`,
        color: `oklch(var(--id-l) var(--id-c) ${hue})`,
      }}
      className={clsx(
        "inline-grid shrink-0 place-items-center rounded-[var(--r)] font-mono leading-none tracking-tight",
        className,
      )}
    >
      {monogramOf(provider)}
    </span>
  );
}

/** A terminal is not a provider; it gets a glyph of its own. */
export function TerminalMark({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <span
      style={{ width: size, height: size, fontSize: size <= 14 ? 8 : 9 }}
      className={clsx(
        "inline-grid shrink-0 place-items-center rounded-[var(--r)] bg-sunken font-mono leading-none text-ink-3",
        className,
      )}
    >
      ›_
    </span>
  );
}
