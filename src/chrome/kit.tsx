import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Select as BaseSelect } from "@base-ui/react/select";
import { Switch } from "@base-ui/react/switch";
import { CaretUpDownIcon, CheckIcon, CircleNotchIcon, type Icon } from "@phosphor-icons/react";
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  KeyboardEvent,
  ReactNode,
  Ref,
  RefObject,
  TextareaHTMLAttributes,
} from "react";
import { Kbd } from "./Kbd";

/**
 * Crew's own controls. Every floating surface, field and row reads from the
 * same few tokens the sidebar and the palette use, so a sheet, a menu and a
 * settings page look like one app instead of three libraries.
 */

/** A floating surface: palette, dialog, menu. */
export const SURFACE = "rounded-xl bg-kumo-control text-kumo-default shadow-2xl ring ring-kumo-line";

/** A menu or popover panel, and one row in it. */
export const PANEL =
  "max-h-[70vh] min-w-48 origin-(--transform-origin) overflow-y-auto rounded-xl bg-kumo-control p-1 text-kumo-default shadow-lg ring ring-kumo-line outline-none transition-[opacity,scale] duration-100 data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0";
export const ROW =
  "flex h-8 w-full cursor-default items-center gap-2 rounded-md px-2 text-left whitespace-nowrap outline-none select-none data-highlighted:bg-hover data-popup-open:bg-hover";

const CONTROL =
  "w-full rounded-md bg-kumo-base px-2.5 ring ring-kumo-line outline-none transition-shadow placeholder:text-placeholder focus:ring-[1.5px] focus:ring-kumo-focus/50 disabled:opacity-50 aria-invalid:ring-kumo-danger/60";

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
      <span className="text-[12px] font-medium text-kumo-subtle">{label}</span>
      {children}
      {error ? (
        <span className="text-[12px] text-kumo-danger">{error}</span>
      ) : (
        hint && <span className="text-[12px] text-kumo-subtle">{hint}</span>
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
  primary: "bg-kumo-brand text-kumo-inverse hover:bg-kumo-brand-hover",
  secondary: "bg-card text-kumo-default ring-1 ring-hairline hover:bg-hover",
  ghost: "text-kumo-subtle hover:bg-hover hover:text-kumo-default",
  danger: "bg-kumo-danger text-white hover:bg-kumo-danger/90",
};

/** `keys` is the chord that does the same, shown inside the button the way the footers show them. */
export function Button({
  variant = "secondary",
  icon: Glyph,
  keys,
  loading = false,
  className = "",
  children,
  ref,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  icon?: Icon;
  keys?: string;
  loading?: boolean;
  ref?: Ref<HTMLButtonElement>;
}) {
  const onDark = variant === "primary" || variant === "danger";
  return (
    <button
      ref={ref}
      type="button"
      {...rest}
      disabled={rest.disabled || loading}
      className={`inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md px-3 font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-kumo-focus/50 disabled:opacity-50 ${VARIANTS[variant]} ${className}`}
    >
      {loading ? <CircleNotchIcon className="size-4 animate-spin" /> : Glyph && <Glyph className="size-4" />}
      {children}
      {keys && <Kbd keys={keys} className={onDark ? "border-white/20 bg-white/10 text-current! opacity-80" : ""} />}
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
        {description && <span className="text-[12px] text-kumo-subtle">{description}</span>}
      </span>
      <Switch.Root
        checked={checked}
        onCheckedChange={onChange}
        className="relative inline-flex h-5 w-8 shrink-0 items-center rounded-full bg-selected p-0.5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-kumo-focus/50 data-checked:bg-kumo-brand"
      >
        <Switch.Thumb className="size-4 rounded-full bg-kumo-base shadow-sm transition-transform data-checked:translate-x-3" />
      </Switch.Root>
    </label>
  );
}

export type Option<T extends string> = { value: T; label: string; icon?: ReactNode };

/** A dropdown whose list is one of our menus, not the platform's. */
export function Select<T extends string>({
  value,
  options,
  onChange,
  label,
  className = "w-44",
}: {
  value: T;
  options: Option<T>[];
  onChange: (value: T) => void;
  label: string;
  className?: string;
}) {
  const current = options.find((option) => option.value === value);
  return (
    <BaseSelect.Root value={value} onValueChange={(next) => next !== null && onChange(next as T)}>
      <BaseSelect.Trigger
        aria-label={label}
        className={`flex h-8 items-center gap-2 rounded-md bg-kumo-base px-2.5 text-left ring ring-kumo-line outline-none focus-visible:ring-[1.5px] focus-visible:ring-kumo-focus/50 data-popup-open:ring-kumo-focus/50 ${className}`}
      >
        {current?.icon}
        <span className="min-w-0 flex-1 truncate">{current?.label ?? ""}</span>
        <CaretUpDownIcon className="size-3.5 shrink-0 text-kumo-subtle" />
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner sideOffset={4} alignItemWithTrigger={false} className="z-50">
          <BaseSelect.Popup className={`${PANEL} w-(--anchor-width)`}>
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
}: {
  value: T;
  options: Option<T>[];
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex h-8 items-center gap-0.5 rounded-md bg-card p-0.5">
      {options.map((option) => {
        const on = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(option.value)}
            className={`flex h-7 items-center gap-1.5 rounded-[5px] px-2.5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-kumo-focus/50 ${
              on ? "bg-kumo-base text-kumo-default shadow-sm" : "text-kumo-subtle hover:text-kumo-default"
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
  return (
    <div role="presentation" className="fixed inset-0 z-50" onMouseDown={onClose}>
      <div className="absolute inset-0 bg-black/20" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.stopPropagation();
          onClose();
        }}
        className={`absolute top-[14vh] left-1/2 flex max-h-[76vh] ${width} max-w-[calc(100vw-32px)] -translate-x-1/2 flex-col overflow-hidden ${SURFACE}`}
      >
        {children}
      </div>
    </div>
  );
}

/** What the keyboard does here, on the surface's bottom edge; `children` sit at its right end. */
export function Footer({ hints, children }: { hints: [string, string][]; children?: ReactNode }) {
  return (
    <div className="flex min-h-9 shrink-0 items-center gap-4 border-t border-kumo-line px-3 py-1.5 text-[11px] text-kumo-subtle">
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
  return <div className="px-2.5 pt-2 pb-1 text-[11px] text-kumo-subtle">{children}</div>;
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
      className={`inline-flex size-8 shrink-0 items-center justify-center rounded-md text-kumo-subtle outline-none transition-colors hover:bg-hover hover:text-kumo-default focus-visible:ring-2 focus-visible:ring-kumo-focus/50 disabled:opacity-50 ${className}`}
    >
      <Glyph className="size-4" />
    </button>
  );
}

/**
 * A question the app waits on, centred in the palette's frame. Focus stays in it
 * and goes back where it was after; Escape calls `onDismiss`, a press outside does nothing.
 * `children` is its Footer.
 */
export function Alert({
  open,
  onDismiss,
  title,
  description,
  initialFocus,
  onKeyDown,
  children,
}: {
  open: boolean;
  onDismiss: () => void;
  title: string;
  description?: ReactNode;
  /** Defaults to the first button, which is usually the safe answer. */
  initialFocus?: RefObject<HTMLElement | null> | undefined;
  onKeyDown?: ((event: KeyboardEvent<HTMLDivElement>) => void) | undefined;
  children?: ReactNode;
}) {
  return (
    <AlertDialog.Root open={open} onOpenChange={(next) => !next && onDismiss()}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-50 bg-black/20" />
        <AlertDialog.Popup
          initialFocus={initialFocus}
          onKeyDown={onKeyDown}
          className={`fixed top-1/2 left-1/2 z-50 flex w-[400px] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden outline-none transition-[opacity,scale] duration-100 data-starting-style:scale-95 data-starting-style:opacity-0 ${SURFACE}`}
        >
          <div className="flex flex-col gap-1.5 p-4">
            <AlertDialog.Title className="text-[14px] font-semibold">{title}</AlertDialog.Title>
            {description && (
              <AlertDialog.Description render={<div />} className="break-words text-kumo-subtle">
                {description}
              </AlertDialog.Description>
            )}
          </div>
          {children}
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
