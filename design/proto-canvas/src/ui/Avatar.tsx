import { memo } from "react";
import BoringAvatar from "boring-avatars";
import type { SessionStatus } from "@crew/fixtures";
import { avatarPalette } from "@/lib/identity";
import { useLook } from "@/lib/store";
import { cx } from "@/lib/cx";

export type AvatarProps = {
  seed: string;
  size?: number;
  /** Pass a status to reserve and draw the ring; omit it for a bare mark. */
  status?: SessionStatus;
  variant?: "beam" | "marble" | "bauhaus";
  square?: boolean;
  className?: string;
  title?: string;
  /** Unread letters waiting in this agent's box. */
  badge?: number;
};

const RING_GAP = 4;

const MASK = "radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 2px))";

/**
 * The single swap point for the avatar generator. Everything else in the app
 * asks for `<Avatar seed={name} />` and never learns which library drew it.
 *
 * It reads theme through `useLook()` rather than the whole store, so four
 * hundred of them do not re-render when an unrelated piece of state moves.
 */
export const Avatar = memo(function Avatar({
  seed,
  size = 28,
  status,
  variant = "beam",
  square = false,
  className,
  title,
  badge,
}: AvatarProps) {
  const { dark, agentTheme } = useLook();
  const colors = avatarPalette(agentTheme === "mono" ? "mono" : seed, dark);
  const box = status === undefined ? size : size + RING_GAP * 2;

  return (
    <span
      className={cx("relative inline-flex shrink-0 items-center justify-center", className)}
      style={{ width: box, height: box }}
      title={title ?? seed}
    >
      <BoringAvatar name={seed} size={size} variant={variant} colors={colors} square={square} />
      {status !== undefined && status !== "idle" && status !== "done" && (
        <span
          aria-hidden
          className={cx(
            "pointer-events-none absolute inset-0 rounded-full",
            status === "working" && "ring-working",
          )}
          style={
            status === "working"
              ? { mask: MASK, WebkitMask: MASK }
              : { border: `2px solid ${status === "error" ? "var(--status-error)" : "var(--status-attention)"}` }
          }
        />
      )}
      {badge !== undefined && badge > 0 && (
        <span
          className="absolute -right-1 -top-1 grid min-w-[15px] place-items-center rounded-full border-2 border-[var(--base)] px-[3px] text-2xs font-bold leading-[13px]"
          style={{ background: "var(--status-attention)", color: "oklch(0.25 0.05 70)" }}
          title={`${badge} waiting`}
        >
          {badge}
        </span>
      )}
      {status === "done" && (
        <span
          aria-hidden
          className="absolute rounded-full border-2 border-[var(--base)]"
          style={{ width: 10, height: 10, right: 0, bottom: 0, background: "var(--status-unread)" }}
        />
      )}
      {status === "needs-input" && badge === undefined && (
        <span
          aria-hidden
          className="absolute rounded-full border-2 border-[var(--base)]"
          style={{ width: 10, height: 10, right: -1, bottom: -1, background: "var(--status-attention)" }}
        />
      )}
    </span>
  );
});

export function AvatarStack({ seeds, size = 20 }: { seeds: string[]; size?: number }) {
  const shown = seeds.slice(0, 3);
  return (
    <span className="inline-flex shrink-0 items-center">
      {shown.map((seed, i) => (
        <span
          key={seed}
          className="rounded-full ring-2 ring-[var(--raised)]"
          style={{ marginLeft: i === 0 ? 0 : -size / 3, zIndex: shown.length - i }}
        >
          <Avatar seed={seed} size={size} />
        </span>
      ))}
      {seeds.length > shown.length && (
        <span className="ml-1 text-xs text-ink-52">+{seeds.length - shown.length}</span>
      )}
    </span>
  );
}
