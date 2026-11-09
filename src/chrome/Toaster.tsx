import { BellIcon, CheckIcon, CircleAlertIcon, MessageCircleQuestionIcon, ShieldQuestionIcon, SquareTerminalIcon, WifiIcon, type LucideIcon as Icon } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { toast, Toaster as Sonner, useSonner } from "sonner";
import type { NotificationSource } from "../lib/notifications";
import type { NotificationTarget } from "../lib/notify";
import { attachToasts, TOAST_MS, type ToastNews } from "../lib/toasts";
import type { Session } from "../lib/types";
import { BotAvatar } from "./BotAvatar";
import { ProviderIcon } from "./ProviderIcon";

const ICONS: Record<NotificationSource, Icon> = {
  "needs-input": MessageCircleQuestionIcon,
  approval: ShieldQuestionIcon,
  done: CheckIcon,
  error: CircleAlertIcon,
  process: SquareTerminalIcon,
  bell: BellIcon,
  connection: WifiIcon,
  test: BellIcon,
};

/** Inside the main panel's top right corner, and so clear of the tab bar above it, the window's drag region: the pointer stops reaching the page there. */
const TOP = 48;
const RIGHT = 16;
const WIDTH = 320;
/** Its rows are at least this tall (index.css), which puts Clear all under them. */
const ROW = 46;
const GAP = 5;
const VISIBLE = 3;
/** A press that moves further than this was a swipe, not a click. */
const CLICK_SLOP = 4;

const STYLE = { "--width": `${WIDTH}px`, "--border-radius": "12px" } as CSSProperties;

function Face({ news, session }: { news: ToastNews; session: Session | undefined }) {
  const Glyph = ICONS[news.source];
  if (session?.kind === "bot") return <BotAvatar seed={session.id} bare className="size-[18px]" />;
  if (session) return <ProviderIcon provider={session.provider} className="size-4" />;
  return <Glyph aria-hidden className={`size-3.5 ${news.source === "error" || news.source === "process" ? "text-danger" : "text-icon"}`} />;
}

const rowOf = (target: EventTarget) => (target instanceof Element ? target.closest("[data-sonner-toast]") : null);

/**
 * News of another session while Crew is in front, on sonner: it owns the stack,
 * the fan-out on hover, the newest three showing, the older ones moving up, and
 * the swipe left or right that dismisses one, and the timer that pauses while
 * the stack is hovered. News of the same thing replaces the last, and comes down
 * once that thing is seen. A click opens the session; Clear all, under the
 * stack, dismisses every one.
 */
export function Toaster({ onOpen, sessions }: { onOpen: (target: NotificationTarget) => void; sessions: Session[] }) {
  const { toasts } = useSonner();
  // Sonner's own hover ends at the stack; this one also holds it open over Clear all.
  const [hovered, setHovered] = useState(false);
  const [live, setLive] = useState(0);
  const area = useRef<HTMLDivElement>(null);
  const latest = useRef({ onOpen, sessions });
  const targets = useRef(new Map<string, NotificationTarget | null>());
  const pressedAt = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    latest.current = { onOpen, sessions };
  });

  // Rows sonner has started removing: they move the stack at once, and leave `toasts` only later.
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    const count = () => setLive(el.querySelectorAll("[data-sonner-toast]:not([data-removed='true'])").length);
    const observer = new MutationObserver(count);
    observer.observe(el, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-removed"] });
    return () => observer.disconnect();
  }, []);

  // Nothing left to hold open, even if the pointer never left.
  if (toasts.length === 0 && hovered) setHovered(false);

  // Native, not React's: a row removed from under the pointer sends React no mouseleave, and the stack would stay open.
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    const enter = () => setHovered(true);
    const leave = () => setHovered(false);
    el.addEventListener("mouseenter", enter);
    el.addEventListener("mouseleave", leave);
    return () => {
      el.removeEventListener("mouseenter", enter);
      el.removeEventListener("mouseleave", leave);
    };
  }, []);

  useEffect(() => {
    const byKey = new Map<string, string>();
    let serial = 0;
    return attachToasts({
      show: (news) => {
        const id = `toast-${++serial}`;
        const sessionId = news.target?.sessionId;
        const key = news.key ?? sessionId;
        if (key) {
          // One per thing it is news of: the latest replaces the last and comes to the front.
          const last = byKey.get(key);
          if (last) toast.dismiss(last);
          byKey.set(key, id);
        }
        targets.current.set(id, news.target);
        const session = latest.current.sessions.find((candidate) => candidate.id === sessionId);
        // Who it is about, and a line of what they said.
        toast(news.title, {
          id,
          testId: id,
          ...(news.body ? { description: news.body } : { className: "toast-title-only" }),
          icon: <Face news={news} session={session} />,
          duration: news.duration ?? TOAST_MS[news.source],
          onDismiss: () => forget(key, id),
          onAutoClose: () => forget(key, id),
        });
      },
      close: (match) => {
        for (const [key, id] of byKey) {
          if (!match(key)) continue;
          byKey.delete(key);
          toast.dismiss(id);
        }
      },
    });

    function forget(key: string | undefined, id: string) {
      targets.current.delete(id);
      if (key && byKey.get(key) === id) byKey.delete(key);
    }
  }, []);

  const open = (row: Element | null) => {
    const id = row instanceof HTMLElement ? row.dataset.testid : undefined;
    if (!id) return;
    const target = targets.current.get(id);
    targets.current.delete(id);
    toast.dismiss(id);
    if (target) latest.current.onOpen(target);
  };

  const seen = Math.min(live, VISIBLE);

  return (
    <div
      ref={area}
      data-toaster
      // Only listens for its rows, which sonner makes focusable.
      role="presentation"
      onPointerDownCapture={(event) => {
        pressedAt.current = { x: event.clientX, y: event.clientY };
      }}
      onClick={(event) => {
        const from = pressedAt.current;
        if (from && Math.hypot(event.clientX - from.x, event.clientY - from.y) > CLICK_SLOP) return;
        open(rowOf(event.target));
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") open(rowOf(event.target));
      }}
    >
      <Sonner position="top-right" hotkey={[]} expand={hovered} visibleToasts={VISIBLE} gap={GAP} swipeDirections={["left", "right"]} offset={{ top: TOP, right: RIGHT }} style={STYLE} />
      {hovered && live > 1 && (
        // Its strip starts where the stack ends, so the pointer never leaves on the way, and moves when the stack does.
        <div
          className="fixed z-50 flex justify-end"
          style={{ top: TOP + seen * ROW + (seen - 1) * GAP, right: RIGHT, width: WIDTH, paddingTop: GAP, transition: "top 400ms ease" }}
        >
          <button
            type="button"
            className="toast-clear"
            onClick={() => {
              toast.dismiss();
              setHovered(false);
            }}
          >
            Clear all
          </button>
        </div>
      )}
    </div>
  );
}
