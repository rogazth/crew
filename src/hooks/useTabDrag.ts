import { useEffect, useRef, type RefObject } from "react";
import { Spring, frames, reducedMotion, type Tune } from "../lib/spring";

// Dragging a tab along its strip. The tab in hand is a copy stuck to the
// pointer; the tab itself folds shut where it was, and the room it needs opens
// where it would go, its neighbours stepping aside. Let go, the room is its
// place and the copy lands in it. Springs carry all of it, interruptible: a
// new target keeps the velocity.
//
// The strip marks its runs `data-drag-group` and each tab in them
// `data-drag-id`; a tab moves within its own run, never into another. Nothing
// re-renders while a tab is held: the order is saved once, on drop.

const TUNES = {
  // Folding, making room: a touch of give.
  drag: { stiffness: 460, damping: 36 },
  // The copy coming down onto its place: just past critical (ζ ≈ 1.05), so it never goes past it.
  land: { stiffness: 520, damping: 48 },
} satisfies Record<string, Tune>;

/** How far the pointer goes before a press is a drag, not a click. */
const PULL = 5;
/** The strip's gap between tabs. */
const GAP = 2;
/** Held this near a scrolling run's edge, the run scrolls under it. */
const EDGE = 36;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

// ── Making room ──────────────────────────────────────────────────────────

/** One sideways nudge per element: retargeted, it carries on from where it is. */
const nudges = new Map<HTMLElement, { spring: Spring; stop: (() => void) | null }>();

const shiftOf = (el: HTMLElement) => nudges.get(el)?.spring.x ?? 0;

function nudge(el: HTMLElement, to: number) {
  let n = nudges.get(el);
  if (!n) {
    if (to === 0) return;
    n = { spring: new Spring(0, to), stop: null };
    nudges.set(el, n);
  }
  n.spring.to = to;
  if (n.stop) return;
  const entry = n;
  entry.stop = frames((dt, stalled) => {
    if (stalled || reducedMotion()) entry.spring.snap();
    else entry.spring.step(dt, TUNES.drag);
    const done = entry.spring.settled(0.2);
    el.style.translate = done && entry.spring.to === 0 ? "" : `${entry.spring.x}px 0`;
    if (!done) return true;
    entry.stop = null;
    if (entry.spring.to === 0) nudges.delete(el);
    return false;
  });
}

function stopNudge(el: HTMLElement) {
  nudges.get(el)?.stop?.();
  nudges.delete(el);
  el.style.translate = "";
}

/** Put back `delta` px from where the layout has it, and spring home from there. */
function slideFrom(el: HTMLElement, delta: number) {
  if (Math.abs(delta) < 0.5) return;
  nudges.set(el, { spring: new Spring(delta, delta), stop: null });
  el.style.translate = `${delta}px 0`;
  nudge(el, 0);
}

/** The held tab's fold: one per element, so a new one takes over from wherever the last was. */
const folds = new WeakMap<HTMLElement, { spring: Spring; stop: () => void }>();
const FOLDED = ["overflow", "minWidth", "flexShrink", "width", "paddingLeft", "paddingRight", "opacity", "marginRight"] as const;

/** Folds a tab shut on a spring, padding and opacity with it, so its neighbours slide into the room it gives. */
function fold(el: HTMLElement, full: number) {
  folds.get(el)?.stop();
  const spring = new Spring(full, 0);
  const css = getComputedStyle(el);
  const pad = [parseFloat(css.paddingLeft), parseFloat(css.paddingRight)] as const;
  Object.assign(el.style, { overflow: "hidden", minWidth: "0", flexShrink: "0" });
  const stop = frames((dt, stalled) => {
    if (stalled || reducedMotion()) spring.snap();
    else spring.step(dt, TUNES.drag);
    const k = clamp(spring.x / full, 0, 1);
    el.style.width = `${Math.max(0, spring.x)}px`;
    el.style.paddingLeft = `${pad[0] * k}px`;
    el.style.paddingRight = `${pad[1] * k}px`;
    el.style.opacity = `${clamp(k * 1.4 - 0.2, 0, 1)}`;
    // The gap after it goes with it.
    el.style.marginRight = `${-GAP * (1 - k)}px`;
    return !spring.settled(0.2);
  });
  folds.set(el, { spring, stop });
}

/** Whole again at once: its room is already open where it lands. */
function unfold(el: HTMLElement) {
  folds.get(el)?.stop();
  folds.delete(el);
  for (const prop of FOLDED) el.style[prop] = "";
}

const tabsIn = (group: HTMLElement) => [...group.querySelectorAll<HTMLElement>(":scope > [data-drag-id]")];

/** Where an element is laid out, a nudge not counting. */
const laidLeft = (el: HTMLElement) => el.getBoundingClientRect().left - shiftOf(el);

/** The tab whose middle is past `x`, as laid out, or null for the run's end. */
function tabBefore(group: HTMLElement, x: number, held: HTMLElement): string | null {
  for (const el of tabsIn(group)) {
    if (el === held) continue;
    if (x < laidLeft(el) + el.getBoundingClientRect().width / 2) return el.dataset.dragId!;
  }
  return null;
}

/** Tabs from `before` on, and whatever trails the run, step aside by `room`; the rest go home. */
function part(group: HTMLElement, held: HTMLElement, before: string | null | undefined, room: number) {
  let past = false;
  for (const el of group.children) {
    if (!(el instanceof HTMLElement) || el === held) continue;
    const id = el.dataset.dragId;
    if (id === undefined) {
      // What trails the tabs (the plus, a separator): the held tab's fold would pull it in.
      nudge(el, before === undefined ? 0 : room);
      continue;
    }
    if (before !== undefined && before !== null && id === before) past = true;
    nudge(el, before !== undefined && past ? room : 0);
  }
}

/** Where the room opens: at `before`'s place as laid out, or after the run's last tab. */
function gapAt(group: HTMLElement, held: HTMLElement, before: string | null) {
  const others = tabsIn(group).filter((el) => el !== held);
  const box = held.getBoundingClientRect();
  const target = before === null ? undefined : others.find((el) => el.dataset.dragId === before);
  if (target) return { left: laidLeft(target), top: box.top, height: box.height };
  const last = others[others.length - 1];
  const left = last ? laidLeft(last) + last.getBoundingClientRect().width + GAP : laidLeft(held);
  return { left, top: box.top, height: box.height };
}

/**
 * The empty box where the tab in hand would go: it pops in where the tabs
 * part, then glides after the room on a spring as it moves.
 */
class Slot {
  el: HTMLElement | null = null;
  x = new Spring(0);
  stop: (() => void) | null = null;

  show(gap: { left: number; top: number; height: number }, width: number) {
    if (!this.el) {
      this.el = document.createElement("div");
      this.el.className = "crew-tab-slot";
      document.body.append(this.el);
      this.x = new Spring(gap.left);
    }
    const el = this.el;
    el.style.top = `${gap.top}px`;
    el.style.height = `${gap.height}px`;
    el.style.width = `${width}px`;
    this.x.to = gap.left;
    el.style.transform = `translateX(${this.x.x}px)`;
    if (this.stop) return;
    this.stop = frames((dt, stalled) => {
      if (stalled || reducedMotion()) this.x.snap();
      else this.x.step(dt, TUNES.drag);
      el.style.transform = `translateX(${this.x.x}px)`;
      if (!this.x.settled(0.2)) return true;
      this.stop = null;
      return false;
    });
  }

  /** Gone at once: the tab is taking its place. */
  hide() {
    this.stop?.();
    this.stop = null;
    this.el?.remove();
    this.el = null;
  }
}

// ── The tab in hand ──────────────────────────────────────────────────────

/**
 * A copy of the tab, stuck to the pointer at the point it was grabbed: what is
 * left of the gap between where the tab was and the pointer closes on a stiff
 * spring, so it lifts off without a jump and then never trails. It leans into
 * its speed and lifts a little off the page. Landing, it leaves the pointer
 * with the pointer's velocity (no more than it can lose before its place, so
 * it never goes past it) and chases its place every frame; only once it is on
 * it does it hand over: the place is kept out of sight until then and shown in
 * the frame the copy goes, so there is only ever one of the tab.
 */
class Ghost {
  el = document.createElement("div");
  qx: number;
  qy: number;
  vx = 0;
  vy = 0;
  moved = performance.now();
  ox: Spring;
  oy: Spring;
  lift = new Spring(1, 1.035);
  lean = new Spring(0);
  x = new Spring(0);
  y = new Spring(0);
  target: HTMLElement | null = null;
  capped = false;
  landedAt = 0;
  stop: () => void;

  constructor(
    face: HTMLElement,
    readonly box: { w: number; h: number },
    from: { left: number; top: number },
    readonly grab: { dx: number; dy: number },
    pointer: { x: number; y: number },
  ) {
    this.qx = pointer.x;
    this.qy = pointer.y;
    this.ox = new Spring(from.left - (pointer.x - grab.dx), 0);
    this.oy = new Spring(from.top - (pointer.y - grab.dy), 0);
    this.el.className = "crew-tab-ghost";
    face.classList.add("crew-tab-ghost-face");
    this.el.append(face);
    document.body.append(this.el);
    this.paint(from.left, from.top);
    this.stop = frames((dt, stalled) => this.tick(dt, stalled));
  }

  /** Where its middle is, along the strip. */
  get middle() {
    return this.position().left + this.box.w / 2;
  }

  follow(x: number, y: number) {
    const now = performance.now();
    const dt = Math.max(0.004, (now - this.moved) / 1000);
    // Smoothed, so one jittery event does not throw it sideways.
    this.vx += ((x - this.qx) / dt - this.vx) * 0.4;
    this.vy += ((y - this.qy) / dt - this.vy) * 0.4;
    this.qx = x;
    this.qy = y;
    this.moved = now;
  }

  land(place: HTMLElement) {
    const { left, top } = this.position();
    this.x = new Spring(left);
    this.y = new Spring(top);
    this.x.v = this.vx;
    this.y.v = this.vy;
    this.target = place;
    // Out of sight from this frame on, before it can show beside the copy.
    place.style.visibility = "hidden";
    this.landedAt = performance.now();
    this.lift.to = 1;
    // Its shadow comes down to a tab's on the way, so the hand-over does not pop.
    this.el.setAttribute("data-landing", "");
  }

  /** The place shown, the copy gone: in one frame. */
  private handOver() {
    this.target?.style.removeProperty("visibility");
    this.el.remove();
  }

  private position() {
    return { left: this.qx - this.grab.dx + this.ox.x, top: this.qy - this.grab.dy + this.oy.x };
  }

  private tick(dt: number, stalled: boolean) {
    let left: number;
    let top: number;
    if (this.target) {
      const r = this.target.getBoundingClientRect();
      this.x.to = r.left;
      this.y.to = r.top;
      if (!this.capped) {
        // A throw carries it no further than it can stop in: past that it would overshoot its place.
        const reach = Math.sqrt(TUNES.land.stiffness);
        this.x.v = clamp(this.x.v, -reach * Math.abs(this.x.to - this.x.x), reach * Math.abs(this.x.to - this.x.x));
        this.y.v = clamp(this.y.v, -reach * Math.abs(this.y.to - this.y.x), reach * Math.abs(this.y.to - this.y.x));
        this.capped = true;
      }
      this.lean.to = 0;
      this.x.step(dt, TUNES.land);
      this.y.step(dt, TUNES.land);
      left = this.x.x;
      top = this.y.x;
      const arrived = Math.hypot(this.x.x - this.x.to, this.y.x - this.y.to) < 0.75;
      if (arrived || stalled || reducedMotion() || performance.now() - this.landedAt > 1600) {
        this.handOver();
        return false;
      }
    } else {
      // The pointer stopped: its speed runs down, and the lean with it.
      if (performance.now() - this.moved > 40) {
        this.vx *= 0.82;
        this.vy *= 0.82;
      }
      this.lean.to = clamp(this.vx / 160, -6, 6);
      this.ox.step(dt, { stiffness: 1100, damping: 66 });
      this.oy.step(dt, { stiffness: 1100, damping: 66 });
      ({ left, top } = this.position());
    }
    this.lift.step(dt, this.target ? TUNES.land : { stiffness: 520, damping: 30 });
    this.lean.step(dt, this.target ? TUNES.land : { stiffness: 340, damping: 26 });
    this.paint(left, top);
    return true;
  }

  private paint(left: number, top: number) {
    const s = this.el.style;
    s.width = `${this.box.w}px`;
    s.height = `${this.box.h}px`;
    s.transformOrigin = this.target ? "50% 50%" : `${this.grab.dx}px ${this.grab.dy}px`;
    s.transform = `translate3d(${left}px, ${top}px, 0) rotate(${this.lean.x}deg) scale(${this.lift.x})`;
  }

  dispose() {
    this.stop();
    this.handOver();
  }
}

// ── The hook ─────────────────────────────────────────────────────────────

type Options = {
  /** The run's new order, by `data-drag-id`; only called when it changed. */
  onReorder: (group: string, ids: string[]) => void;
  /** A tab came off: whatever hovers over the strip goes. */
  onStart?: () => void;
};

/** Tabs dragged along their runs inside `root`, as the top of this file says. */
export function useTabDrag(root: RefObject<HTMLElement | null>, options: Options) {
  const live = useRef(options);
  useEffect(() => {
    live.current = options;
  });

  useEffect(() => {
    const node = root.current;
    if (!node) return;
    type Held = { el: HTMLElement; group: HTMLElement; pointer: number; x0: number; y0: number; full: number; from: string | null };
    let held: Held | null = null;
    let ghost: Ghost | null = null;
    let before: string | null = null;
    let pointer = { x: 0, y: 0 };
    let scrolling: (() => void) | null = null;
    const slot = new Slot();
    const room = () => (held ? held.full + GAP : 0);

    /** The tab after `el` in its run, or null at its end. */
    const nextOf = (el: HTMLElement) => {
      for (let next = el.nextElementSibling; next; next = next.nextElementSibling) {
        if (next instanceof HTMLElement && next.dataset.dragId !== undefined) return next.dataset.dragId;
      }
      return null;
    };

    /** Where it would go now: the run parts there and the slot follows. */
    const aim = () => {
      if (!held || !ghost) return;
      before = tabBefore(held.group, ghost.middle, held.el);
      part(held.group, held.el, before, room());
      slot.show(gapAt(held.group, held.el, before), held.full);
    };

    const tear = (event: PointerEvent, h: Held) => {
      document.documentElement.dataset.tabDragging = "";
      live.current.onStart?.();
      h.el.setPointerCapture(h.pointer);
      const box = h.el.getBoundingClientRect();
      const face = h.el.cloneNode(true) as HTMLElement;
      for (const attr of ["data-drag-id", "data-tab-id", "id", "style"]) face.removeAttribute(attr);
      face.style.width = `${box.width}px`;
      // Held where it was grabbed along its length, by its middle across.
      const grab = { dx: clamp(h.x0 - box.left, 10, box.width - 10), dy: box.height / 2 };
      ghost = new Ghost(face, { w: box.width, h: box.height }, box, grab, { x: event.clientX, y: event.clientY });
      fold(h.el, h.full);
      // Near a scrolling run's ends, it scrolls, faster the nearer.
      scrolling = frames(() => {
        if (!held) return false;
        const g = held.group;
        if (g.scrollWidth > g.clientWidth) {
          const r = g.getBoundingClientRect();
          const speed = pointer.x < r.left + EDGE ? -(1 - (pointer.x - r.left) / EDGE) : pointer.x > r.right - EDGE ? 1 - (r.right - pointer.x) / EDGE : 0;
          if (speed !== 0) {
            g.scrollLeft += clamp(speed, -1, 1) * 12;
            aim();
          }
        }
        return true;
      });
      aim();
    };

    const down = (event: PointerEvent) => {
      if (event.button !== 0 || held) return;
      const target = event.target as Element;
      if (target.closest("input, textarea, [contenteditable]")) return;
      const el = target.closest<HTMLElement>("[data-drag-id]");
      const group = el?.parentElement;
      if (!el || !group?.hasAttribute("data-drag-group")) return;
      held = { el, group, pointer: event.pointerId, x0: event.clientX, y0: event.clientY, full: el.getBoundingClientRect().width, from: nextOf(el) };
    };

    const move = (event: PointerEvent) => {
      if (!held || event.pointerId !== held.pointer) return;
      pointer = { x: event.clientX, y: event.clientY };
      if (!ghost) {
        if (Math.hypot(event.clientX - held.x0, event.clientY - held.y0) <= PULL) return;
        tear(event, held);
      }
      ghost!.follow(event.clientX, event.clientY);
      aim();
    };

    const drop = (cancel: boolean) => {
      if (!held) return;
      const h = held;
      held = null;
      scrolling?.();
      scrolling = null;
      delete document.documentElement.dataset.tabDragging;
      if (!ghost) return;
      const g = ghost;
      ghost = null;
      if (h.el.hasPointerCapture(h.pointer)) h.el.releasePointerCapture(h.pointer);
      // The click that ends a drag is not a pick.
      const swallow = (event: MouseEvent) => {
        event.stopPropagation();
        event.preventDefault();
      };
      window.addEventListener("click", swallow, { capture: true, once: true });
      window.setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);

      const to = cancel ? h.from : before;
      const ids = tabsIn(h.group).flatMap((el) => (el === h.el ? [] : [el.dataset.dragId!]));
      const at = to === null ? ids.length : ids.indexOf(to);
      const id = h.el.dataset.dragId!;
      ids.splice(at < 0 ? ids.length : at, 0, id);
      const was = new Map<HTMLElement, number>();
      for (const el of h.group.children) if (el instanceof HTMLElement && el !== h.el) was.set(el, el.getBoundingClientRect().left);
      if (ids.join("\n") !== tabsIn(h.group).map((el) => el.dataset.dragId).join("\n")) live.current.onReorder(h.group.dataset.dragGroup!, ids);

      // Once the strip is in its new order: the tab takes the room the others made, they settle
      // around it from wherever they are, and the copy lands on it.
      const settle = (tries: number) =>
        requestAnimationFrame(() => {
          if (nextOf(h.el) !== to && tries > 0) return settle(tries - 1);
          unfold(h.el);
          for (const [el, left] of was) {
            stopNudge(el);
            slideFrom(el, left - el.getBoundingClientRect().left);
          }
          slot.hide();
          if (h.el.isConnected) g.land(h.el);
          else g.dispose();
        });
      settle(12);
    };

    const up = (event: PointerEvent) => {
      if (held && event.pointerId === held.pointer) drop(event.type === "pointercancel");
    };
    // Esc puts it back where it came from, and is nobody else's.
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !ghost) return;
      event.preventDefault();
      event.stopPropagation();
      drop(true);
    };
    // A favicon or an avatar would start the page's own drag and cancel the pointer.
    const native = (event: DragEvent) => {
      if ((event.target as Element | null)?.closest?.("[data-drag-id]")) event.preventDefault();
    };

    node.addEventListener("pointerdown", down);
    node.addEventListener("dragstart", native);
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
    window.addEventListener("keydown", key, true);
    return () => {
      node.removeEventListener("pointerdown", down);
      node.removeEventListener("dragstart", native);
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
      window.removeEventListener("keydown", key, true);
      scrolling?.();
      ghost?.dispose();
      slot.hide();
      if (held) unfold(held.el);
      delete document.documentElement.dataset.tabDragging;
    };
  }, [root]);
}
