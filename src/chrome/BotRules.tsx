import { PlusIcon, Trash2Icon } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import type { useBotRules } from "../hooks/useBotRules";
import { newRuleRow, rulesUsed, type RuleRow } from "../lib/botRules";
import { AddRow, CardHead, PaneCard } from "./BotPaneParts";

const count = (n: number) => n.toLocaleString("en-US");

/** The least a cap may be (`crew_core::rules::CAP`): less, or nothing, is taken as this. */
const DEFAULT_CAP = 1500;

/**
 * A bot's rules, a card of them the way Connectors lists an account's tools.
 * The words edit in place and are written when the edit ends; the bot adds
 * rules too, with its rules tool.
 */
export function BotRules({ rules }: { rules: ReturnType<typeof useBotRules> }) {
  const { rows, cap, error, commit, setCap } = rules;
  // The rule being written: a row of its own at the end, stored only once it has words.
  const [draft, setDraft] = useState<RuleRow | null>(null);
  const used = rows ? rulesUsed(rows) : 0;

  return (
    <PaneCard label="Rules">
      <CardHead
        title="Rules"
        aside={
          rows ? (
            <span className={`flex items-center gap-1 ${used > cap ? "text-danger" : ""}`}>
              {count(used)} /
              <CapField cap={cap} onChange={(next) => void setCap(next)} />
            </span>
          ) : undefined
        }
      />
      {rows === null && !error && <p className="py-3 text-[12px] text-text-muted">Reading its rules…</p>}
      {rows?.map((row) => (
        <Rule
          key={row.key}
          row={row}
          onCommit={(text) => {
            void commit(text.trim() ? rows.map((other) => (other.key === row.key ? { ...other, text } : other)) : rows.filter((other) => other.key !== row.key));
          }}
          onRemove={() => void commit(rows.filter((other) => other.key !== row.key))}
        />
      ))}
      {rows && draft && (
        <Rule
          key={draft.key}
          row={draft}
          onCommit={(text) => {
            setDraft(null);
            if (text.trim()) void commit([...rows, { ...draft, text }]);
          }}
          onRemove={() => setDraft(null)}
        />
      )}
      {rows && !draft && (
        <AddRow onClick={() => setDraft(newRuleRow())}>
          <PlusIcon className="size-4 shrink-0" />
          Add a rule
        </AddRow>
      )}
      {error && <p className="py-2.5 text-[12px] text-danger">{error}</p>}
    </PaneCard>
  );
}

/**
 * One rule: its words, always a field. It is kept as the title is: when the
 * edit ends, Enter ends it too, and Escape puts back what is stored. A new
 * rule starts focused, two lines tall, and leaving it with no words drops it.
 */
function Rule({ row, onCommit, onRemove }: { row: RuleRow; onCommit: (text: string) => void; onRemove: () => void }) {
  const fresh = row.id === null;
  // Only while it is being edited does it hold its own words; otherwise it shows what is stored, the bot's rewording included.
  const [text, setText] = useState<string | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  // Set by Escape just before the blur it causes, which then keeps nothing.
  const discard = useRef(false);
  useLayoutEffect(() => {
    if (fresh) field.current?.focus();
  }, [fresh]);

  const end = () => {
    const keep = !discard.current;
    discard.current = false;
    const next = text ?? row.text;
    setText(null);
    if (fresh) return keep && next.trim() ? onCommit(next) : onRemove();
    if (keep && next.trim() !== row.text.trim()) onCommit(next);
  };

  return (
    <div data-rule className="group relative flex items-start gap-3 py-2.5 transition-opacity duration-150">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <textarea
          ref={field}
          rows={fresh ? 2 : 1}
          value={text ?? row.text}
          aria-label={fresh ? "New rule" : `Rule ${row.id}`}
          placeholder="Run the tests before saying it is done"
          onFocus={() => setText(row.text)}
          onChange={(event) => setText(event.target.value)}
          onBlur={end}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            // Escape drops a new rule and puts a stored one's words back.
            discard.current = event.key === "Escape";
            event.currentTarget.blur();
          }}
          className={`resize-none bg-transparent py-1 text-[13px] leading-[18px] break-words outline-none [field-sizing:content] placeholder:text-placeholder ${
            fresh ? "min-h-[44px]" : ""
          }`}
        />
      </div>
      {!fresh && (
        <button
          type="button"
          aria-label="Remove rule"
          title="Remove rule"
          onClick={onRemove}
          className="mt-px grid size-6 shrink-0 place-items-center rounded-md text-icon opacity-0 outline-none transition-opacity group-hover:opacity-100 hover:bg-selected hover:text-text focus-visible:opacity-100"
        >
          <Trash2Icon className="size-3.5" />
        </button>
      )}
    </div>
  );
}

/**
 * The cap, edited where it reads: the number itself, as the name is. Kept
 * when the edit ends, Escape puts it back. Left empty or under the default,
 * it is the default.
 */
function CapField({ cap, onChange }: { cap: number; onChange: (cap: number) => void }) {
  // The digits being typed, shown with the same comma as at rest, so focusing it moves nothing.
  const [typed, setTyped] = useState<string | null>(null);
  const discard = useRef(false);
  const end = () => {
    const next = Number.parseInt(typed ?? "", 10);
    const keep = !discard.current;
    discard.current = false;
    setTyped(null);
    if (!keep) return;
    const kept = Number.isFinite(next) ? Math.max(next, DEFAULT_CAP) : DEFAULT_CAP;
    if (kept !== cap) onChange(kept);
  };
  return (
    <input
      aria-label="Most characters its rules may hold"
      title="Most characters its rules may hold"
      inputMode="numeric"
      value={typed === null ? count(cap) : typed && count(Number(typed))}
      onFocus={(event) => {
        setTyped(String(cap));
        event.currentTarget.select();
      }}
      onChange={(event) => setTyped(event.target.value.replace(/\D/g, ""))}
      onBlur={end}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        discard.current = event.key === "Escape";
        event.currentTarget.blur();
      }}
      className="-mx-1 min-w-[3ch] rounded-md bg-transparent px-1 text-right tabular-nums outline-none transition-colors [field-sizing:content] hover:bg-hover focus:bg-hover"
    />
  );
}
