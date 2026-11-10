// The pieces a settings page of a thing (a workspace, a bot) is built from: a titled section, a field kept when its
// edit ends, a card of rules, and the destructive action at the page's foot.
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { IconButton } from "./kit";
import type { useRules } from "../hooks/useRules";
import { newRuleRow } from "../lib/rules";

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
  label,
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
  /** What it is called to assistive tech, where nothing on screen names it. */
  label?: string;
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
      aria-label={label}
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

/**
 * Rules, one a row in a card, as useRules reads and writes them: each edited
 * where it reads, removed on hover or when emptied, and one more added at the end.
 */
export function RulesCard({ rules: { rows, error, commit } }: { rules: ReturnType<typeof useRules> }) {
  const [adding, setAdding] = useState(false);
  return (
    <>
      <div className="rounded-xl bg-card px-4 [&>*+*]:border-t [&>*+*]:border-hairline">
        {rows === null && !error && <p className="py-3 text-[13px] text-text-muted">Reading…</p>}
        {rows?.map((row) => (
          <div key={row.key} className="group flex items-start gap-3 py-2">
            <Kept
              single
              label="Rule"
              value={row.text}
              onKeep={(text) => void commit(rows.map((other) => (other.key === row.key ? { ...other, text } : other)))}
              onEmpty={() => void commit(rows.filter((other) => other.key !== row.key))}
              className="min-w-0 flex-1 py-1 text-[13px] leading-[18px]"
            />
            <IconButton
              icon={Trash2Icon}
              label="Remove rule"
              className="size-7 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
              onClick={() => void commit(rows.filter((other) => other.key !== row.key))}
            />
          </div>
        ))}
        {rows &&
          (adding ? (
            <div className="py-2">
              <Kept
                autoFocus
                single
                label="New rule"
                value=""
                placeholder="Never deploy on Fridays"
                onKeep={(text) => {
                  setAdding(false);
                  void commit([...rows, { ...newRuleRow(), text }]);
                }}
                onEmpty={() => setAdding(false)}
                className="w-full py-1 text-[13px] leading-[18px]"
              />
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="flex h-11 w-full items-center gap-2 text-[13px] text-text-muted hover:text-text"
            >
              <PlusIcon className="size-4" /> Add a rule
            </button>
          ))}
      </div>
      {error && <p className="mt-1.5 text-[12px] text-danger">{error}</p>}
    </>
  );
}
