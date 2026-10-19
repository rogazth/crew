// The pieces every settings page is built from: the page frame (title + one line), cards of rows, the Careful card,
// soft status chips, a progress bar, a copy button, toasts, and the jump that
// lands the nav's search on a single row.
import { CheckIcon, CopyIcon, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Alert, Button, Card, IconButton, Toggle } from "../../chrome/kit";

/** The raised level: a hairline and a soft drop, the chat cards' recipe. */
export const RAISED =
  "bg-surface shadow-[0_0_0_1px_var(--color-hairline),0_1px_2px_oklch(0%_0_0/0.04),0_10px_28px_-14px_oklch(0%_0_0/0.18)]";

/* ── Page frame ─────────────────────────────────────────────────────── */

export function SettingsPage({
  title,
  description,
  actions,
  wide = false,
  hideHeader = false,
  children,
}: {
  title: string;
  /** Only where the page needs telling how it works; most need no line under the title. */
  description?: string | undefined;
  actions?: ReactNode;
  wide?: boolean;
  /** A page that draws its own top, like About's hero. */
  hideHeader?: boolean;
  children: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  useJumpLanding(root);
  // Two boxes: the sheet clips the outer one, so the scroll lives inside it.
  return (
    <div className="h-full">
      {/* No scroll anchoring: a page that reorders cards above the fold (Usage) would be dragged along with them. */}
      <div ref={root} className="@container h-full overflow-y-auto [overflow-anchor:none]">
      <div className={`mx-auto flex ${wide ? "max-w-[920px]" : "max-w-[720px]"} flex-col gap-7 px-10 pt-12 pb-28`}>
        <header className={`flex items-center gap-4 px-1 ${hideHeader ? "sr-only" : ""}`}>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h1 className="text-[22px] leading-7 font-semibold tracking-[-0.02em]">{title}</h1>
            {description && <p className="text-text-muted">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
        </header>
        {children}
      </div>
      </div>
    </div>
  );
}

/** A titled card of rows. `action` sits at the right end of the title line. */
export function Group({
  title,
  description,
  action,
  id,
  children,
}: {
  title?: string;
  description?: string;
  action?: ReactNode;
  id?: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2" data-setting={id}>
      {(title || action) && (
        <div className="flex min-h-6 items-end gap-3 px-2.5">
          <div className="flex min-w-0 flex-1 flex-col">
            {title && <h2 className="text-[12px] font-medium text-text-muted">{title}</h2>}
            {description && <p className="text-[12px] text-text-muted">{description}</p>}
          </div>
          {action}
        </div>
      )}
      <Card>{children}</Card>
    </section>
  );
}

/** A heading over things that are not rows: provider cards, theme cards. */
export function Heading({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex min-h-6 items-end gap-3 px-2.5">
      <div className="flex min-w-0 flex-1 flex-col">
        <h2 className="text-[12px] font-medium text-text-muted">{title}</h2>
        {description && <p className="text-[12px] text-text-muted">{description}</p>}
      </div>
      {action}
    </div>
  );
}

export function Row({
  id,
  label,
  description,
  children,
}: {
  id?: string;
  label: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div data-setting={id} className="flex min-h-11 items-center gap-6 py-2.5">
      <div className="min-w-0 flex-1">
        <p>{label}</p>
        {description && <p className="text-[12px] text-text-muted">{description}</p>}
      </div>
      {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  );
}

export function ToggleRow({
  id,
  ...props
}: {
  id?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  description?: string;
}) {
  return (
    <div data-setting={id}>
      <Toggle {...props} />
    </div>
  );
}

/** What cannot be undone, or goes around a safety, lives in its own card at the foot. */
export function Careful({ title = "Careful", children }: { title?: string | null; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      {title && <h2 className="px-2.5 text-[12px] font-medium text-text-muted">{title}</h2>}
      <div className="rounded-xl bg-danger/6 px-4 ring-1 ring-danger/15 [&>*+*]:border-t [&>*+*]:border-danger/10">
        {children}
      </div>
    </section>
  );
}

/* ── Small parts ────────────────────────────────────────────────────── */

export type Tone = "success" | "info" | "warning" | "danger" | "neutral" | "accent";

const TONES: Record<Tone, string> = {
  success: "bg-success/12 text-success",
  info: "bg-info/12 text-info",
  warning: "bg-warning/14 text-warning",
  danger: "bg-danger/10 text-danger",
  neutral: "bg-fill text-text-muted",
  accent: "bg-accent/12 text-accent",
};

const DOTS: Record<Tone, string> = {
  success: "bg-success",
  info: "bg-info",
  warning: "bg-warning",
  danger: "bg-danger",
  neutral: "bg-text-muted",
  accent: "bg-accent",
};

/** A state in its soft form: tinted ground, coloured ink. */
export function Chip({ tone, dot = true, children }: { tone: Tone; dot?: boolean; children: ReactNode }) {
  return (
    <span className={`inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full px-2 text-[11px] font-medium ${TONES[tone]}`}>
      {dot && <span className={`size-1.5 rounded-full ${DOTS[tone]}`} />}
      {children}
    </span>
  );
}

/**
 * A notice in HeroUI's alert shape: a neutral card, the tone only in the
 * icon's soft disc, a title, a line under it, and at most one action. The
 * card never takes the tone's colour, so a notice reads as information, not
 * as an alarm, and only the disc says how much it matters.
 */
export function Callout({
  tone = "accent",
  icon: Glyph,
  spinning = false,
  title,
  description,
  action,
  className = "",
}: {
  tone?: Tone;
  icon: LucideIcon;
  spinning?: boolean;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div role="status" className={`flex items-center gap-3 rounded-xl bg-surface p-3 shadow-[0_0_0_1px_var(--color-hairline)] ${className}`}>
      <span className={`grid size-8 shrink-0 place-items-center rounded-full ${TONES[tone]}`}>
        <Glyph className={`size-4 ${spinning ? "animate-spin motion-reduce:animate-none" : ""}`} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{title}</p>
        {description && <p className="truncate text-[12px] text-text-muted">{description}</p>}
      </div>
      {action}
    </div>
  );
}

export function ProgressBar({ value, className = "" }: { value: number; className?: string }) {
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value * 100)}
      className={`h-1.5 overflow-hidden rounded-full bg-selected ${className}`}
    >
      <div
        className="h-full rounded-full bg-accent transition-[width] duration-200 ease-out motion-reduce:transition-none"
        style={{ width: `${Math.max(2, value * 100)}%` }}
      />
    </div>
  );
}

export function ProgressRing({ value, className = "size-6" }: { value: number; className?: string }) {
  const r = 9;
  const c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 24 24" className={`-rotate-90 ${className}`} aria-hidden>
      <circle cx="12" cy="12" r={r} fill="none" strokeWidth="2.5" className="stroke-selected" />
      <circle
        cx="12"
        cy="12"
        r={r}
        fill="none"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - value)}
        className="stroke-accent transition-[stroke-dashoffset] duration-200"
      />
    </svg>
  );
}

export function CopyButton({ text, label = "Copy", className = "size-7" }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const timer = window.setTimeout(() => setDone(false), 1400);
    return () => window.clearTimeout(timer);
  }, [done]);
  return (
    <IconButton
      icon={done ? CheckIcon : CopyIcon}
      label={done ? "Copied" : label}
      title={done ? "Copied" : label}
      className={`${className} ${done ? "text-success hover:text-success" : ""}`}
      onClick={() => {
        void navigator.clipboard?.writeText(text).catch(() => {});
        setDone(true);
      }}
    />
  );
}

/* ── Toasts: what needs no answer ───────────────────────────────────── */

type ToastItem = { id: number; text: string; tone: Tone };
let toasts: ToastItem[] = [];
let toastSeq = 0;
const toastListeners = new Set<() => void>();
const emitToasts = () => toastListeners.forEach((listener) => listener());

export function toast(text: string, tone: Tone = "success") {
  const id = ++toastSeq;
  toasts = [...toasts.slice(-2), { id, text, tone }];
  emitToasts();
  window.setTimeout(() => {
    toasts = toasts.filter((item) => item.id !== id);
    emitToasts();
  }, 2600);
}

export function Toasts() {
  const items = useSyncExternalStore(
    (listener) => {
      toastListeners.add(listener);
      return () => toastListeners.delete(listener);
    },
    () => toasts,
  );
  return (
    <div className="pointer-events-none fixed bottom-16 left-1/2 z-[90] flex -translate-x-1/2 flex-col items-center gap-2">
      {items.map((item) => (
        <div
          key={item.id}
          className="flex h-10 items-center gap-2.5 rounded-xl bg-surface px-3.5 shadow-float motion-safe:animate-[settings-toast_180ms_var(--ease-out,ease-out)]"
        >
          <span className={`size-2 rounded-full ${DOTS[item.tone]}`} />
          <span>{item.text}</span>
        </div>
      ))}
      <style>{`@keyframes settings-toast { from { opacity: 0; transform: translateY(6px) scale(0.98); } }`}</style>
    </div>
  );
}

/* ── Confirm ────────────────────────────────────────────────────────── */

export type ConfirmAsk = { title: string; description: string; action: string; onConfirm: () => void };

export function ConfirmDialog({ ask, onClose }: { ask: ConfirmAsk | null; onClose: () => void }) {
  return (
    <Alert open={ask !== null} onDismiss={onClose} title={ask?.title ?? ""} description={ask?.description}>
      <div className="flex justify-end gap-2 px-4 pb-4">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="danger"
          onClick={() => {
            ask?.onConfirm();
            onClose();
          }}
        >
          {ask?.action}
        </Button>
      </div>
    </Alert>
  );
}

/* ── Jump: the nav's search lands on one row ────────────────────────── */

let target: string | null = null;
const jumpListeners = new Set<() => void>();

/** Asks the page that opens next to scroll to the row marked `data-setting={id}` and light it. */
export function requestJump(id: string | null) {
  target = id;
  jumpListeners.forEach((listener) => listener());
}

function useJumpLanding(root: React.RefObject<HTMLDivElement | null>) {
  const wanted = useSyncExternalStore(
    (listener) => {
      jumpListeners.add(listener);
      return () => jumpListeners.delete(listener);
    },
    () => target,
  );
  useEffect(() => {
    if (!wanted) return;
    const frame = requestAnimationFrame(() => {
      const el = root.current?.querySelector<HTMLElement>(`[data-setting="${CSS.escape(wanted)}"]`);
      target = null;
      if (!el) return;
      const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
      // Scrolls the page alone: scrollIntoView would nudge every ancestor, the window included.
      const scroller = root.current!;
      const offset = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      scroller.scrollTo({
        top: scroller.scrollTop + offset - scroller.clientHeight / 2 + el.offsetHeight / 2,
        behavior: still ? "auto" : "smooth",
      });
      if (still) return;
      const tint = "color-mix(in oklab, var(--color-accent) 14%, transparent)";
      el.animate(
        [
          { backgroundColor: tint, boxShadow: `0 0 0 6px ${tint}`, borderRadius: "8px" },
          { backgroundColor: tint, boxShadow: `0 0 0 6px ${tint}`, borderRadius: "8px", offset: 0.5 },
          { backgroundColor: "transparent", boxShadow: "0 0 0 6px transparent", borderRadius: "8px" },
        ],
        { duration: 1600, easing: "ease-out" },
      );
    });
    return () => cancelAnimationFrame(frame);
  }, [wanted, root]);
}
