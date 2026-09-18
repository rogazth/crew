import { useStore } from "@/lib/store";
import { cx } from "@/lib/cx";
import { Icon } from "@/ui/Icon";
import { Tip } from "@/ui/Tooltip";

/**
 * Which world the window is looking at. Fixtures stay quiet; a stress world or
 * a live daemon says so, because every other number on screen depends on it.
 */
export function SourceBadge() {
  const { sourceKind, sourceLabel, connected, loading } = useStore();
  const live = sourceKind === "live";
  if (sourceLabel === "Fixtures") return null;

  return (
    <Tip
      content={
        live
          ? connected
            ? "Connected to a real crewd over its own WebSocket."
            : "The daemon is not answering."
          : "Generated data, deterministic from a seed."
      }
    >
      <span
        className={cx(
          "flex h-7 shrink-0 items-center gap-1.5 rounded-chip px-2 text-xs font-medium el-1",
          live ? "bg-raised text-ink-70" : "bg-warn-soft text-[var(--warn)]",
        )}
      >
        <span
          className={cx("size-2 rounded-full", loading && "pulse-dot")}
          style={{
            background: live
              ? connected
                ? "var(--status-ok)"
                : "var(--status-error)"
              : "var(--status-attention)",
          }}
        />
        {sourceLabel}
        {live && !connected && <Icon name="circleAlert" size={12} />}
      </span>
    </Tip>
  );
}
