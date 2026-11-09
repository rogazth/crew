// The pieces a settings page of a thing (a workspace, a bot) is built from: a titled section, a field kept when its
// edit ends, and the destructive action at the page's foot.
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

export function Section({ title, aside, children }: { title?: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="mb-7 last:mb-0">
      {title && (
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <h3 className="text-[13px] font-medium">{title}</h3>
          {aside && <span className="flex items-center gap-1 text-[12px] text-text-muted tabular-nums">{aside}</span>}
        </div>
      )}
      {children}
    </section>
  );
}

/** The page's last word, on its own and to the right: removing the thing. */
export function DangerAction({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <Section>
      <div className="flex justify-end">
        <button
          type="button"
          onClick={onClick}
          className="rounded-md text-[13px] font-medium text-danger outline-none hover:opacity-80 focus-visible:ring-2 focus-visible:ring-focus/50"
        >
          {children}
        </button>
      </div>
    </Section>
  );
}

/** A field kept when the edit ends: Enter (when `single`) or a blur; Escape puts it back. */
export function Kept({
  value,
  onKeep,
  single = false,
  autoFocus = false,
  placeholder,
  className,
  onEmpty,
  onTyping,
}: {
  value: string;
  onKeep: (text: string) => void;
  single?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
  className: string;
  onEmpty?: () => void;
  /** Each keystroke's text while it is edited, null once the edit ends. */
  onTyping?: (text: string | null) => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const discard = useRef(false);
  const field = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    if (autoFocus) field.current?.focus();
  }, [autoFocus]);
  return (
    <textarea
      ref={field}
      rows={1}
      spellCheck={!single}
      value={text ?? value}
      placeholder={placeholder}
      onFocus={() => setText(value)}
      onChange={(event) => {
        const next = single ? event.target.value.replace(/\n/g, " ") : event.target.value;
        setText(next);
        onTyping?.(next);
      }}
      onBlur={() => {
        const next = (text ?? value).trim();
        const keep = !discard.current;
        discard.current = false;
        setText(null);
        onTyping?.(null);
        if (!keep) return;
        if (!next) return onEmpty?.();
        if (next !== value.trim()) onKeep(next);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" || (single && event.key === "Enter" && !event.shiftKey)) {
          event.preventDefault();
          event.stopPropagation();
          discard.current = event.key === "Escape";
          event.currentTarget.blur();
        }
      }}
      className={`resize-none outline-none transition-colors [field-sizing:content] placeholder:text-placeholder ${/(^|\s)bg-/.test(className) ? "" : "bg-transparent"} ${className}`}
    />
  );
}
