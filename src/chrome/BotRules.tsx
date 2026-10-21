import { PlusIcon, XIcon } from "lucide-react";
import { useRef } from "react";
import { Button, IconButton, TextArea } from "./kit";
import type { useBotRules } from "../hooks/useBotRules";
import { newRuleRow, rulesUsed } from "../lib/botRules";
import { dayName } from "../lib/time";

const count = (n: number) => n.toLocaleString("en-US");

/**
 * A bot's rules, a row per rule: the user's decisions about how it works,
 * apart from its description. The bot adds them too, with its rules tool,
 * citing the message where the user decided; that message shows under the
 * rule. Nothing for a bot being made; `rows` is null while they are read.
 */
export function BotRules({ rules }: { rules: ReturnType<typeof useBotRules> }) {
  const { shown, rows, cap, error, change: onChange } = rules;
  // A removed row takes its focused button with it, and focus on the page
  // leaves Escape out of the sheet: it goes to "Add rule" instead.
  const add = useRef<HTMLButtonElement>(null);
  if (!shown) return null;
  const used = rows ? rulesUsed(rows) : 0;
  const over = used > cap;
  return (
    <section aria-label="Rules" className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between">
        <span className="text-[12px] font-medium text-text-muted">Rules</span>
        {rows && (
          <span className={`text-[11.5px] tabular-nums ${over ? "text-danger" : "text-text-muted"}`}>
            {count(used)}/{count(cap)}
          </span>
        )}
      </div>
      {rows ? (
        <div className="flex flex-col gap-1.5">
          {rows.map((row) => (
            <div key={row.key} className="flex items-start gap-1">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <TextArea
                  rows={2}
                  aria-label={row.id === null ? "New rule" : `Rule ${row.id}`}
                  value={row.text}
                  className="min-h-0"
                  onChange={(event) =>
                    onChange(rows.map((other) => (other.key === row.key ? { ...other, text: event.target.value } : other)))
                  }
                />
                {row.cited && (
                  <span className="truncate px-1 text-[11.5px] text-text-muted" title={row.cited.excerpt}>
                    “{row.cited.excerpt}” · {dayName(row.cited.at)}
                  </span>
                )}
              </div>
              <IconButton
                icon={XIcon}
                label="Remove rule"
                onClick={() => {
                  add.current?.focus();
                  onChange(rows.filter((other) => other.key !== row.key));
                }}
              />
            </div>
          ))}
          <Button ref={add} variant="ghost" icon={PlusIcon} className="self-start" onClick={() => onChange([...rows, newRuleRow()])}>
            Add rule
          </Button>
        </div>
      ) : (
        !error && <span className="text-[12px] text-text-muted">Reading its rules…</span>
      )}
      {error ? (
        <span className="text-[12px] text-danger">{error}</span>
      ) : over ? (
        <span className="text-[12px] text-danger">Over the {count(cap)} characters rules hold: shorten or remove some.</span>
      ) : (
        <span className="text-[12px] text-text-muted">
          Your decisions about how it works. It adds them too, citing your message. Read every turn.
        </span>
      )}
    </section>
  );
}
