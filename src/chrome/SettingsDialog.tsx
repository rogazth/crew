// The settings of a thing in a dialog of its own, as a bot's open (BotDialog.tsx): centred, the window sinking a
// touch under it (useSettingsDialog), headed by the thing's face and name, its few pages as pill tabs under that.
// And the pieces its pages are built from that a settings page (SettingsSection.tsx) does not already have.
import { PencilIcon, XIcon } from "lucide-react";
import { useEffect, useState, type DragEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Tabs } from "@base-ui/react/tabs";
import { IconButton, PillTabs, SURFACE } from "./kit";
import { Kept } from "./SettingsSection";

export type DialogPage<K extends string> = {
  key: K;
  label: string;
  /** How many it holds, beside the label, as Commands counts its tabs. */
  count?: number;
};

/**
 * The frame: backdrop; the dialog headed by what it is (its face and its name,
 * `heading`, both edited right there), the pages as small pill tabs under that
 * heading when there is more than one, the page under them, and `footer` held
 * at its foot. The pills sit below the name on purpose: the thing is the
 * heading, the pages are a detail of it.
 */
export function SettingsDialog<K extends string>({
  label,
  heading,
  face,
  leaving,
  backdropRef,
  panelRef: panel,
  pages,
  page,
  onPage,
  onLeave,
  footer,
  renderPage,
}: {
  label: string;
  /** What it is called, the dialog's heading: a DialogName, or a field typed into for a thing being made. */
  heading: ReactNode;
  /** Its face beside the name: an EditableFace, small. */
  face: ReactNode;
  leaving: boolean;
  backdropRef: RefObject<HTMLDivElement | null>;
  panelRef: RefObject<HTMLDivElement | null>;
  pages: DialogPage<K>[];
  page: K;
  onPage: (page: K) => void;
  onLeave: () => void;
  footer?: ReactNode;
  renderPage: (page: K) => ReactNode;
}) {
  // Modal: the window under it takes no focus and no clicks while it is up, so Tab cannot leave it for
  // what it covers; once it goes, the focus goes back to what had it. Before the panel takes the focus.
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const app = document.querySelector<HTMLElement>("[data-app]");
    const made = app !== null && !app.inert;
    if (made) app.inert = true;
    return () => {
      if (made) app.inert = false;
      if (before?.isConnected) before.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    const el = panel.current;
    if (el && !el.contains(document.activeElement)) el.focus();
  }, [panel]);

  return createPortal(
    <div role="presentation" className={`fixed inset-0 z-50 ${leaving ? "pointer-events-none" : ""}`} onMouseDown={onLeave}>
      <div ref={backdropRef} className="absolute inset-0 bg-(--backdrop)" />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        inert={leaving}
        // Its top runs under the tab bar's window drag, which would take the clicks meant for it.
        data-tauri-drag-region="false"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          // A menu opened from here is portaled out but its keys bubble through React: its Escape is its own.
          if (event.key !== "Escape" || event.defaultPrevented || !event.currentTarget.contains(event.target as Node)) return;
          event.stopPropagation();
          onLeave();
        }}
        className={`absolute top-1/2 left-1/2 flex h-[600px] max-h-[86vh] w-[640px] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden outline-none ${SURFACE}`}
      >
        {/* Only the close stays put; the heading and the pills scroll away with the page. */}
        <IconButton icon={XIcon} label="Close" className="crew-float-ground absolute top-2.5 right-2.5 z-10 size-9" onClick={onLeave} />
        <Tabs.Root value={page} onValueChange={(next) => onPage(next as K)} className="min-h-0 flex-1 overflow-y-auto px-7 pt-6 pb-8">
          <header className="pr-8 pb-3">
            <div className="flex items-center gap-3.5">
              {face}
              {heading}
            </div>
            {/* Commands' tabs: the pill alone on the sheet, with a count where a page holds a list. */}
            {pages.length > 1 && (
              <PillTabs
                value={page}
                tabs={pages.map((item) => ({
                  key: item.key,
                  label: (
                    <>
                      {item.label}
                      {item.count !== undefined && <span className="text-[12px] tabular-nums opacity-60">({item.count})</span>}
                    </>
                  ),
                }))}
                className="mt-4 -ml-0.5"
              />
            )}
          </header>
          {pages.length > 1 ? (
            <Tabs.Panel value={page} className="pt-4 outline-none">
              {renderPage(page)}
            </Tabs.Panel>
          ) : (
            <div className="pt-4">{renderPage(page)}</div>
          )}
        </Tabs.Root>
        {/* No rule over it: what scrolls fades into it. */}
        {footer && (
          <div className="relative flex shrink-0 items-center justify-end gap-2 px-7 pt-1 pb-5 before:pointer-events-none before:absolute before:inset-x-0 before:-top-8 before:h-8 before:bg-gradient-to-t before:from-surface before:to-transparent">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

const NAME = "-mx-2 h-10 min-w-0 flex-1 rounded-lg px-2 py-1.5 text-[22px] leading-7 font-semibold tracking-[-0.02em] hover:bg-hover focus:bg-hover";

/** The heading of a thing that exists: its name, renamed where it reads and kept when the edit ends. */
export function DialogName({ value, onKeep }: { value: string; onKeep: (name: string) => void }) {
  return <Kept single label="Name" value={value} onKeep={onKeep} className={NAME} />;
}

/** The heading of a thing being made: its name, typed straight into. */
export function DialogNameDraft({
  value,
  onChange,
  placeholder,
  inputRef,
}: {
  value: string;
  onChange: (name: string) => void;
  placeholder: string;
  inputRef?: RefObject<HTMLInputElement | null>;
}) {
  return (
    <input
      ref={inputRef}
      autoFocus
      spellCheck={false}
      aria-label="Name"
      value={value}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
      className={`${NAME} bg-transparent outline-none transition-colors placeholder:font-normal placeholder:text-placeholder`}
    />
  );
}

/** A face that offers an edit when hovered: the face dims and a pencil shows over it. */
export function EditableFace({
  label,
  size = "size-[72px] rounded-[22px]",
  over = false,
  expanded,
  onClick,
  onDragOver,
  onDragLeave,
  onDrop,
  children,
}: {
  label: string;
  /** Its size and its corners. */
  size?: string;
  /** Something is dragged over it. */
  over?: boolean;
  /** What it opens is open: a picker shown under it. */
  expanded?: boolean;
  onClick: () => void;
  onDragOver?: (event: DragEvent) => void;
  onDragLeave?: () => void;
  onDrop?: (event: DragEvent) => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-expanded={expanded}
      onClick={onClick}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      // It clips its own corners, so the dimming cannot bleed past them.
      className={`group relative isolate shrink-0 overflow-hidden outline-none ${size} transition-shadow focus-visible:ring-2 focus-visible:ring-focus/50 ${
        over ? "ring-2 ring-accent ring-offset-2 ring-offset-surface" : ""
      }`}
    >
      {/* The face itself dims, not a layer over it: a scrim or a blur greys or whitens an icon's transparent corners. */}
      <span
        className={`block size-full transition-[filter] duration-150 ${
          over ? "brightness-[0.7]" : "group-hover:brightness-[0.7] group-focus-visible:brightness-[0.7]"
        }`}
      >
        {children}
      </span>
      <span
        aria-hidden
        className={`absolute inset-0 grid place-items-center text-white transition-opacity duration-150 [&>svg]:drop-shadow-[0_1px_2px_oklch(0%_0_0/0.5)] ${
          over ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
        }`}
      >
        <PencilIcon className="size-4" />
      </span>
    </button>
  );
}

/**
 * The instructions, with a count of what is typed in its bottom-right corner.
 * Kept when the edit ends; `draft`, for a thing being made, each keystroke is.
 */
export function InstructionsField({
  value,
  onKeep,
  placeholder,
  draft = false,
}: {
  value: string;
  onKeep: (text: string) => void;
  placeholder: string;
  draft?: boolean;
}) {
  const [typed, setTyped] = useState<string | null>(null);
  const count = (typed ?? value).length;
  const field = "block min-h-[132px] w-full pt-3.5 pb-7 text-[13.5px] leading-[21px]";
  return (
    <div className="relative rounded-xl bg-card px-4">
      {draft ? (
        <textarea
          aria-label="Instructions"
          value={value}
          placeholder={placeholder}
          onChange={(event) => onKeep(event.target.value)}
          className={`${field} resize-none bg-transparent outline-none [field-sizing:content] placeholder:text-placeholder`}
        />
      ) : (
        <Kept
          label="Instructions"
          value={value}
          onKeep={onKeep}
          onEmpty={() => value && onKeep("")}
          onTyping={setTyped}
          placeholder={placeholder}
          className={field}
        />
      )}
      <span className="pointer-events-none absolute right-3 bottom-2 text-[11px] text-text-muted tabular-nums">{count.toLocaleString("en-US")}</span>
    </div>
  );
}
