import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/** A callback whose identity never changes but whose body is always current. */
export function useEvent<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const held = useRef(fn);
  useLayoutEffect(() => {
    held.current = fn;
  });
  return useCallback((...args: A) => held.current(...args), []);
}

export function useOnClickOutside(
  refs: Array<React.RefObject<HTMLElement | null>>,
  onOutside: () => void,
  active = true,
): void {
  const handler = useEvent(onOutside);
  useEffect(() => {
    if (!active) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      for (const ref of refs) if (ref.current?.contains(target)) return;
      handler();
    };
    // Capture: a menu must close before the click lands on whatever is behind it.
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [active, handler, refs]);
}

export function useEscape(onEscape: () => void, active = true): void {
  const handler = useEvent(onEscape);
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        event.preventDefault();
        handler();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [active, handler]);
}

export type Side = "bottom" | "top" | "right" | "left";
export type Align = "start" | "center" | "end";

export type AnchorPoint = { x: number; y: number };

export type FloatOptions = {
  side?: Side;
  align?: Align;
  gap?: number;
  padding?: number;
  /** Match the anchor's width, for a select-style popover. */
  matchWidth?: boolean;
};

/**
 * Fixed-position placement against an element or a point, flipping to the other
 * side when it would leave the viewport. Enough for menus, popovers and sheets;
 * deliberately not a full floating-ui.
 */
export function useFloating(
  anchor: HTMLElement | AnchorPoint | null,
  open: boolean,
  options: FloatOptions = {},
): {
  ref: React.RefObject<HTMLDivElement | null>;
  style: React.CSSProperties;
} {
  const { side = "bottom", align = "start", gap = 4, padding = 8, matchWidth = false } = options;
  const ref = useRef<HTMLDivElement | null>(null);
  const [style, setStyle] = useState<React.CSSProperties>({
    position: "fixed",
    top: -9999,
    left: -9999,
    visibility: "hidden",
  });

  useLayoutEffect(() => {
    if (!open || !anchor) return;
    const place = () => {
      const node = ref.current;
      if (!node) return;
      const rect =
        anchor instanceof HTMLElement
          ? anchor.getBoundingClientRect()
          : ({ top: anchor.y, bottom: anchor.y, left: anchor.x, right: anchor.x, width: 0, height: 0 } as DOMRect);
      const box = node.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      let top = 0;
      let left = 0;
      let placedSide = side;
      if (side === "bottom" || side === "top") {
        const below = rect.bottom + gap;
        const above = rect.top - gap - box.height;
        placedSide = side === "bottom" && below + box.height > vh - padding && above > padding ? "top" : side;
        if (placedSide === "top" && above < padding && below + box.height <= vh - padding) placedSide = "bottom";
        top = placedSide === "bottom" ? below : rect.top - gap - box.height;
        left =
          align === "start" ? rect.left : align === "end" ? rect.right - box.width : rect.left + rect.width / 2 - box.width / 2;
      } else {
        const after = rect.right + gap;
        placedSide = side === "right" && after + box.width > vw - padding ? "left" : side;
        left = placedSide === "right" ? after : rect.left - gap - box.width;
        top =
          align === "start" ? rect.top : align === "end" ? rect.bottom - box.height : rect.top + rect.height / 2 - box.height / 2;
      }

      left = Math.max(padding, Math.min(left, vw - box.width - padding));
      top = Math.max(padding, Math.min(top, vh - box.height - padding));

      setStyle({
        position: "fixed",
        top: Math.round(top),
        left: Math.round(left),
        ...(matchWidth && rect.width ? { width: Math.round(rect.width) } : {}),
        maxHeight: Math.round(vh - top - padding),
      });
    };
    place();
    const onScroll = () => place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [anchor, open, side, align, gap, padding, matchWidth]);

  return { ref, style };
}

/**
 * Stick-to-bottom with a 16px threshold. Content that grows above the reader —
 * an image decoding, a font swapping, a fold opening — must not move their line,
 * so we pin the scroll offset from the bottom instead of the top.
 */
export function useStickToBottom(deps: unknown[]): {
  ref: React.RefObject<HTMLDivElement | null>;
  atBottom: boolean;
  toBottom: () => void;
} {
  const ref = useRef<HTMLDivElement | null>(null);
  const stuck = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

  const onScroll = useEvent(() => {
    const node = ref.current;
    if (!node) return;
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
    const next = distance <= 16;
    stuck.current = next;
    setAtBottom((held) => (held === next ? held : next));
  });

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.addEventListener("scroll", onScroll, { passive: true });
    return () => node.removeEventListener("scroll", onScroll);
  }, [onScroll]);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || !stuck.current) return;
    node.scrollTop = node.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new ResizeObserver(() => {
      if (stuck.current && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
    });
    for (const child of Array.from(node.children)) observer.observe(child);
    return () => observer.disconnect();
  }, []);

  const toBottom = useEvent(() => {
    const node = ref.current;
    if (!node) return;
    stuck.current = true;
    node.scrollTop = node.scrollHeight;
    setAtBottom(true);
  });

  return { ref, atBottom, toBottom };
}

export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** Roving list index with wrapping, shared by the palette, menus and pickers. */
export function useRovingIndex(
  length: number,
  reset: unknown,
): [number, (n: number) => void, (n: number) => void] {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    setIndex(0);
  }, [reset]);
  useEffect(() => {
    setIndex((held) => (held >= length ? Math.max(0, length - 1) : held));
  }, [length]);
  const move = useEvent((delta: number) => {
    if (length === 0) return;
    setIndex((held) => (((held + delta) % length) + length) % length);
  });
  return [index, move, setIndex];
}
