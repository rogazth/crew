import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Menu } from "@base-ui/react/menu";
import { Select as BaseSelect } from "@base-ui/react/select";
import { Switch as BaseSwitch } from "@base-ui/react/switch";
import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import { CheckIcon, ChevronDownIcon, ChevronsUpDownIcon, LoaderCircleIcon, type LucideIcon as Icon } from "lucide-react";
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  KeyboardEvent,
  ReactElement,
  ReactNode,
  Ref,
  RefObject,
  TextareaHTMLAttributes,
} from "react";
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Kbd } from "./Kbd";

/**
 * Crew's own controls. Every floating surface, field and row reads from the
 * same few tokens the sidebar and the palette use, so a sheet, a menu and a
 * settings page look like one app instead of three libraries.
 */

/** A floating surface: palette, dialog, menu. */
export const SURFACE = "rounded-float bg-surface text-text shadow-float";

/** A popover's card and its open and close motion, sized by whoever uses it. */
export const POPOVER =
  "origin-(--transform-origin) rounded-xl bg-surface text-text shadow-float outline-none transition-[opacity,scale] duration-100 data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0";

/** A menu or popover panel, and one row in it. */
export const PANEL = `max-h-[70vh] min-w-40 max-w-80 overflow-y-auto p-1 ${POPOVER}`;
export const ROW =
  "flex h-8 w-full cursor-default items-center gap-2 rounded-lg px-2 text-left whitespace-nowrap outline-none select-none data-highlighted:bg-hover data-popup-open:bg-hover";

/** A field that opens a list or a picker: the Select's trigger, and the time and date pickers'. */
export const TRIGGER =
  "flex h-8 items-center gap-2 rounded-md bg-canvas px-2.5 text-left ring ring-border outline-none focus-visible:ring-[1.5px] focus-visible:ring-focus/50 data-popup-open:ring-focus/50";

/** A trigger that is a row's value, at its right end: the value and a chevron, no field around them. */
export const ROW_VALUE =
  "flex h-8 items-center gap-1.5 rounded-md px-2 text-text-muted outline-none transition-colors hover:bg-hover hover:text-text focus-visible:ring-2 focus-visible:ring-focus/50 data-popup-open:bg-hover data-popup-open:text-text";

/** A trigger that is a word in a sentence (Shortcuts-style): plain text that fades to the link's blue on hover, no chevron, its popup opening under it. */
export const TOKEN =
  "inline-flex items-center rounded-sm font-medium text-text outline-none transition-colors duration-150 hover:text-link focus-visible:ring-2 focus-visible:ring-focus/50 data-popup-open:text-link";

const CONTROL =
  "w-full rounded-md bg-canvas px-2.5 ring ring-border outline-none transition-shadow placeholder:text-placeholder focus:ring-[1.5px] focus:ring-focus/50 disabled:opacity-50 aria-invalid:ring-danger/60";

/** A label over a control, with a line of help or an error under it. */
export function Field({
  label,
  hint,
  error,
  children,
  className = "",
}: {
  label: string;
  hint?: string | undefined;
  error?: string | null | undefined;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={`flex flex-col gap-1.5 ${className}`}>
      <span className="text-[12px] font-medium text-text-muted">{label}</span>
      {children}
      {error ? (
        <span data-error className="text-[12px] text-danger">{error}</span>
      ) : (
        hint && <span className="text-[12px] text-text-muted">{hint}</span>
      )}
    </label>
  );
}

export function TextInput({ className = "", ref, ...rest }: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  return <input ref={ref} spellCheck={false} {...rest} className={`${CONTROL} h-8 ${className}`} />;
}

export function TextArea({ className = "", ref, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { ref?: Ref<HTMLTextAreaElement> }) {
  return <textarea ref={ref} {...rest} className={`${CONTROL} min-h-20 resize-y py-2 leading-relaxed ${className}`} />;
}

type Variant = "primary" | "secondary" | "ghost" | "danger";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent text-inverse hover:bg-accent-hover",
  secondary: "bg-card text-text ring-1 ring-hairline hover:bg-hover",
  ghost: "text-icon hover:bg-hover hover:text-text",
  danger: "bg-danger text-white hover:bg-danger/90",
};

export function Button({
  variant = "secondary",
  icon: Glyph,
  loading = false,
  className = "",
  children,
  ref,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  icon?: Icon;
  loading?: boolean;
  ref?: Ref<HTMLButtonElement>;
}) {
  return (
    <button
      ref={ref}
      type="button"
      {...rest}
      disabled={rest.disabled || loading}
      className={`inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md px-3 font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-focus/50 disabled:opacity-50 ${VARIANTS[variant]} ${className}`}
    >
      {loading ? <LoaderCircleIcon className="size-4 animate-spin" /> : Glyph && <Glyph className="size-4" />}
      {children}
    </button>
  );
}

/** A switch on the right of a row that says what it does. */
export function Toggle({
  checked,
  onChange,
  label,
  description,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  description?: string;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-4 py-2.5">
      <span className="flex min-w-0 flex-1 flex-col">
        <span>{label}</span>
        {description && <span className="text-[12px] text-text-muted">{description}</span>}
      </span>
      <Switch checked={checked} onChange={onChange} />
    </label>
  );
}

/** The Toggle's switch alone, for a row that has other controls; `label` names it when nothing visible does. */
export function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
}) {
  return (
    <BaseSwitch.Root
      checked={checked}
      onCheckedChange={onChange}
      aria-label={label}
      className="relative inline-flex h-5 w-8 shrink-0 items-center rounded-full bg-selected p-0.5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-focus/50 data-checked:bg-accent"
    >
      <BaseSwitch.Thumb className="size-4 rounded-full bg-canvas shadow-sm transition-transform data-checked:translate-x-3" />
    </BaseSwitch.Root>
  );
}

export type Option<T extends string> = { value: T; label: string; icon?: ReactNode; disabled?: boolean };

/** A dropdown whose list is one of our menus, not the platform's. */
export function Select<T extends string>({
  value,
  options,
  onChange,
  label,
  className = "w-44",
  variant = "field",
}: {
  value: T;
  options: Option<T>[];
  onChange: (value: T) => void;
  label: string;
  className?: string;
  /** "row": the value at a row's right end (ROW_VALUE), its list as wide as it needs. "token": a word in a sentence (TOKEN). */
  variant?: "field" | "row" | "token";
}) {
  const current = options.find((option) => option.value === value);
  const row = variant === "row";
  const token = variant === "token";
  return (
    <BaseSelect.Root value={value} onValueChange={(next) => next !== null && onChange(next as T)}>
      <BaseSelect.Trigger
        aria-label={label}
        className={token ? TOKEN : row ? ROW_VALUE : `${TRIGGER} ${className}`}
      >
        {current?.icon}
        <span className={row || token ? "truncate" : "min-w-0 flex-1 truncate"}>{current?.label ?? ""}</span>
        {token ? null : row ? <ChevronDownIcon className="size-3.5 shrink-0 text-icon" /> : <ChevronsUpDownIcon className="size-3.5 shrink-0 text-icon" />}
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner sideOffset={4} alignItemWithTrigger={false} align={row ? "end" : token ? "start" : "center"} className="z-50">
          <BaseSelect.Popup className={`${PANEL} ${row || token ? "min-w-44" : "w-(--anchor-width)"}`}>
            {options.map((option) => (
              <BaseSelect.Item key={option.value} value={option.value} className={ROW}>
                {option.icon}
                <BaseSelect.ItemText className="min-w-0 flex-1 truncate">{option.label}</BaseSelect.ItemText>
                <BaseSelect.ItemIndicator>
                  <CheckIcon className="size-4 shrink-0" />
                </BaseSelect.ItemIndicator>
              </BaseSelect.Item>
            ))}
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  );
}

/** Two to four choices side by side, one lit. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  wide = false,
}: {
  value: T;
  options: Option<T>[];
  onChange: (value: T) => void;
  label: string;
  /** Fill the row, the options sharing it evenly. */
  wide?: boolean;
}) {
  return (
    <div role="radiogroup" aria-label={label} className={`${wide ? "flex" : "inline-flex"} h-8 items-center gap-0.5 rounded-md bg-card p-0.5`}>
      {options.map((option) => {
        const on = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={option.disabled}
            onClick={() => onChange(option.value)}
            className={`flex h-7 items-center justify-center gap-1.5 rounded-[5px] px-2.5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-focus/50 disabled:opacity-40 ${wide ? "flex-1" : ""} ${
              on ? "bg-canvas text-text shadow-sm" : "text-text-muted enabled:hover:text-text"
            }`}
          >
            {option.icon}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** A card of settings rows, hairlines between them. */
export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-xl bg-card px-4 [&>*+*]:border-t [&>*+*]:border-hairline ${className}`}>{children}</div>;
}

/** Overlays on screen: one that opens while another is still up takes its place over the same backdrop. */
let overlays = 0;
/** How long an overlay takes to leave; `.dialog-panel-out` plays for as long. */
const OVERLAY_LEAVE_MS = 140;

/** The palette's frame: a card under the top edge over a light scrim; a press outside or Escape closes it. */
export function Overlay({
  children,
  onClose,
  width = "w-[420px]",
  label,
}: {
  children: ReactNode;
  onClose: () => void;
  width?: string;
  label?: string;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  // Read before this one counts itself: the one it replaces is still mounted.
  const [swapped] = useState(() => overlays > 0);
  const [leaving, setLeaving] = useState(false);
  const leaveTimer = useRef(0);
  useLayoutEffect(() => {
    overlays++;
    return () => {
      overlays--;
      window.clearTimeout(leaveTimer.current);
    };
  }, []);
  // Opened from a button, focus is still back on the page: take it, so Escape
  // reaches the dialog. A field inside that focused itself keeps it.
  useEffect(() => {
    const el = dialog.current;
    if (el && !el.contains(document.activeElement)) el.focus();
  }, []);
  // A press outside or Escape plays the overlay out before it closes.
  const close = () => {
    if (leaving) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return onClose();
    setLeaving(true);
    leaveTimer.current = window.setTimeout(onClose, OVERLAY_LEAVE_MS);
  };
  // Portaled: an ancestor with a transform (the sidebar's sliding views) would
  // otherwise become the containing block for `fixed` and clip the dialog to it.
  return createPortal(
    <div role="presentation" className={`fixed inset-0 z-50 ${leaving ? "pointer-events-none" : ""}`} onMouseDown={close}>
      <div className={`absolute inset-0 bg-(--backdrop) ${leaving ? "dialog-backdrop-out" : swapped ? "" : "dialog-backdrop"}`} />
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.stopPropagation();
          close();
        }}
        className={`absolute top-[14vh] left-1/2 flex max-h-[76vh] ${width} max-w-[calc(100vw-32px)] -translate-x-1/2 flex-col overflow-hidden outline-none ${SURFACE} ${
          leaving ? "dialog-panel-out" : swapped ? "dialog-panel-swap" : "dialog-panel"
        }`}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

/** The surface's bottom edge: what the keyboard does here, if anything, and `children` at its right end. */
export function Footer({ hints = [], children }: { hints?: [string, string][]; children?: ReactNode }) {
  return (
    <div className="flex min-h-9 shrink-0 items-center gap-4 border-t border-border px-3 py-1.5 text-[11px] text-text-muted">
      {hints.map(([keys, label]) => (
        <span key={label} className="flex items-center gap-1.5">
          <Kbd keys={keys} /> {label}
        </span>
      ))}
      {children && <span className="ml-auto flex items-center gap-2">{children}</span>}
    </div>
  );
}

/** A quiet heading over a group of rows in a list surface. */
export function GroupHeader({ children }: { children: ReactNode }) {
  return <div data-group-header className="px-2.5 pt-2 pb-1 text-[11px] text-text-muted">{children}</div>;
}

/** A button that is only its glyph; `label` is its name, since there is no text to read. */
export function IconButton({
  icon: Glyph,
  label,
  className = "",
  ref,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { icon: Icon; label: string; ref?: Ref<HTMLButtonElement> }) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      {...rest}
      className={`inline-flex size-8 shrink-0 items-center justify-center rounded-md text-icon outline-none transition-colors hover:bg-hover hover:text-text focus-visible:ring-2 focus-visible:ring-focus/50 disabled:opacity-50 ${className}`}
    >
      <Glyph className="size-4" />
    </button>
  );
}

/**
 * A question the app waits on, centred in the palette's frame. Focus stays in it
 * and goes back where it was after; Escape calls `onDismiss`, a press outside does nothing.
 * `error` is what went wrong answering it, under the description. `children` is its Footer.
 */
export function Alert({
  open,
  onDismiss,
  title,
  description,
  error,
  initialFocus,
  onKeyDown,
  children,
}: {
  open: boolean;
  onDismiss: () => void;
  title: string;
  description?: ReactNode;
  error?: string | null | undefined;
  /** Defaults to the first button, which is usually the safe answer. */
  initialFocus?: RefObject<HTMLElement | null> | undefined;
  onKeyDown?: ((event: KeyboardEvent<HTMLDivElement>) => void) | undefined;
  children?: ReactNode;
}) {
  return (
    <AlertDialog.Root open={open} onOpenChange={(next) => !next && onDismiss()}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-50 bg-(--backdrop) transition-opacity duration-160 ease-(--ease-out) data-starting-style:opacity-0 data-ending-style:opacity-0 data-ending-style:duration-140 motion-reduce:transition-none" />
        <AlertDialog.Popup
          initialFocus={initialFocus}
          onKeyDown={onKeyDown}
          className={`fixed top-1/2 left-1/2 z-50 flex w-[400px] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden outline-none transition-[opacity,transform] duration-180 ease-(--ease-out) data-starting-style:opacity-0 data-starting-style:[transform:translateY(4px)_scale(0.995)] data-ending-style:opacity-0 data-ending-style:[transform:translateY(2px)] data-ending-style:duration-140 motion-reduce:transition-none ${SURFACE}`}
        >
          <div className="flex flex-col gap-1.5 p-4">
            <AlertDialog.Title className="text-[14px] font-semibold">{title}</AlertDialog.Title>
            {description && (
              <AlertDialog.Description render={<div />} className="break-words text-text-muted">
                {description}
              </AlertDialog.Description>
            )}
            {error && <div data-error className="text-[12px] break-words text-danger">{error}</div>}
          </div>
          {children}
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

/** A quiet label that shows after a beat over `render`, which becomes the trigger. */
export function Tooltip({
  content,
  side = "top",
  align = "center",
  delay = 400,
  render,
  children,
}: {
  content: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  delay?: number;
  render?: ReactElement;
  children?: ReactNode;
}) {
  return (
    <BaseTooltip.Root>
      <BaseTooltip.Trigger delay={delay} render={render}>{children}</BaseTooltip.Trigger>
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner side={side} align={align} sideOffset={6} className="z-50">
          <BaseTooltip.Popup className="max-w-72 origin-(--transform-origin) rounded-lg bg-accent px-2 py-1 text-[12px] leading-4 text-inverse shadow-float transition-[opacity,scale] duration-100 data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:opacity-0">
            {content}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
}

/** What a page's title is doing: the strip above the sheet echoes it once it has scrolled out of sight. */
export type PageHeading = { title: string; hidden: boolean };

/**
 * Where a page tells the strip about its title. Given by the sheet; a page
 * outside one (commands in a tab) has nobody to tell, and says nothing.
 */
export const PageHeadingContext = createContext<((heading: PageHeading | null) => void) | null>(null);

/**
 * Tells the strip whether `target` (the page's title) is out of sight in its
 * scroller. For a page that draws its own title instead of using `PageFrame`.
 */
export function usePageHeading(title: string, target: RefObject<HTMLElement | null>, enabled = true) {
  const report = useContext(PageHeadingContext);
  useEffect(() => {
    const el = target.current;
    if (!report || !el || !enabled) return;
    // The implicit root clips through the scroller, so a title scrolled under it no longer intersects.
    const observer = new IntersectionObserver(([entry]) => report({ title, hidden: !entry!.isIntersecting }));
    observer.observe(el);
    return () => {
      observer.disconnect();
      report(null);
    };
  }, [report, title, target, enabled]);
}

/** A step in the strip's trail: its name, and where a click on it goes, if anywhere. */
export type Crumb = string | { label: string; onClick: () => void };

/** Where a page deeper than its own top (a routine in Routines) tells the strip its trail. */
export const PageTrailContext = createContext<((trail: Crumb[] | null) => void) | null>(null);

/**
 * Puts `trail` in the strip while the caller is up, in place of the page's
 * own; a page outside the sheet has no strip, and says nothing.
 */
export function usePageTrail(trail: Crumb[]) {
  const report = useContext(PageTrailContext);
  // The clicks change every render; the trail only when its words do.
  const latest = useRef(trail);
  useLayoutEffect(() => {
    latest.current = trail;
  });
  const words = trail.map((part) => (typeof part === "string" ? part : part.label)).join("\u0000");
  useEffect(() => {
    if (!report) return;
    report(
      latest.current.map((part, index) =>
        typeof part === "string" ? part : { label: part.label, onClick: () => (latest.current[index] as Exclude<Crumb, string>).onClick() },
      ),
    );
    return () => report(null);
  }, [report, words]);
}

/**
 * The frame of every page on the sheet: settings, routines, integrations, and
 * commands in a tab. One title in one place, its actions beside it, and the
 * content under it, centred at `reading` width for forms or `wide` for lists
 * and grids. The strip above the sheet is the window's title bar, not this.
 */
export function PageFrame({
  title,
  subtitle,
  actions,
  width = "reading",
  hideHeader = false,
  scrollRef,
  children,
}: {
  title: string;
  /** Only where the page needs telling how it works; most need no line under the title. */
  subtitle?: ReactNode;
  actions?: ReactNode;
  width?: "reading" | "wide";
  /** A page that draws its own top, like About's hero; the title stays for screen readers. */
  hideHeader?: boolean;
  /** The scroller, for a page that scrolls to a row itself. */
  scrollRef?: Ref<HTMLDivElement>;
  children: ReactNode;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  // A hidden header is visually gone from the start; the page draws its own top.
  usePageHeading(title, heading, !hideHeader);
  // Two boxes: the sheet clips the outer one, so the scroll lives inside it.
  return (
    <div className="h-full">
      {/* No scroll anchoring: a page that reorders cards above the fold (Usage) would be dragged along with them. */}
      <div ref={scrollRef} className="@container h-full overflow-y-auto [overflow-anchor:none]">
        <div className={`mx-auto flex ${width === "wide" ? "max-w-[920px]" : "max-w-[720px]"} min-h-full flex-col gap-7 px-10 pt-12 pb-28`}>
          <header className={`flex items-center gap-4 px-1 ${hideHeader ? "sr-only" : ""}`}>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <h1 ref={heading} className="truncate text-[22px] leading-7 font-semibold tracking-[-0.02em]">{title}</h1>
              {subtitle && <p className="text-text-muted">{subtitle}</p>}
            </div>
            {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
          </header>
          {children}
        </div>
      </div>
    </div>
  );
}

/**
 * A filter that says its current value, Linear-style: a quiet pill that opens a
 * menu of choices. Lit once it narrows anything, so a glance says what is on.
 */
export function FilterChip<T extends string>({
  value,
  options,
  onChange,
  label,
  icon: Glyph,
  neutral,
}: {
  value: T;
  options: Option<T>[];
  onChange: (value: T) => void;
  label: string;
  icon?: Icon;
  /** The value that filters nothing; the chip stays quiet on it. */
  neutral?: T;
}) {
  const current = options.find((option) => option.value === value);
  const lit = neutral !== undefined && value !== neutral;
  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label={label}
        data-filter-chip
        {...(lit ? { "data-lit": "" } : {})}
        className={`flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[13px] font-medium outline-none ring-1 transition-colors focus-visible:ring-focus/50 data-popup-open:bg-hover ${
          lit ? "text-text ring-border-strong" : "text-text-muted ring-hairline hover:bg-hover hover:text-text"
        }`}
      >
        {current?.icon ?? (Glyph && <Glyph className="size-3.5 text-icon" />)}
        <span className="max-w-40 truncate">{current?.label ?? label}</span>
        <ChevronDownIcon className="size-3 opacity-60" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="start" sideOffset={6} className="z-50">
          <Menu.Popup className={PANEL}>
            <Menu.RadioGroup value={value} onValueChange={(next) => onChange(next as T)}>
              {options.map((option) => (
                <Menu.RadioItem key={option.value} value={option.value} closeOnClick className={ROW}>
                  {option.icon}
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  <Menu.RadioItemIndicator>
                    <CheckIcon className="size-4 shrink-0" />
                  </Menu.RadioItemIndicator>
                </Menu.RadioItem>
              ))}
            </Menu.RadioGroup>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
