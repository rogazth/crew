import { useEffect, useMemo, useState } from "react";
import type { Block, Question } from "@crew/fixtures";
import { cx } from "@/lib/cx";
import { Button } from "@/ui/Button";
import { Check, RadioPick } from "@/ui/Toggle";
import { Icon } from "@/ui/Icon";
import { Input } from "@/ui/Input";
import { Kbd } from "@/ui/Kbd";
import { isTypingTarget, useChat } from "./context";

const LETTERS = "ABCDEFGH";

export function QuestionCard({ block }: { block: Block }) {
  const { runtime, hotQuestion } = useChat();
  const state = block.question;
  const questions = useMemo<Question[]>(() => state?.questions ?? [], [state]);
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState("");

  const settled = Boolean(state?.answers) || Boolean(state?.dismissed);
  const hot = !settled && state !== undefined && state.requestId === hotQuestion;
  const current = questions[index];

  const pick = (label: string) => {
    if (!current) return;
    setAnswers((held) => {
      const chosen = held[current.question] ?? [];
      if (current.multiSelect) {
        return {
          ...held,
          [current.question]: chosen.includes(label) ? chosen.filter((c) => c !== label) : [...chosen, label],
        };
      }
      return { ...held, [current.question]: [label] };
    });
  };

  const submit = () => {
    if (!state) return;
    const payload: Record<string, string> = {};
    for (const question of questions) {
      const chosen = answers[question.question] ?? [];
      if (chosen.length) payload[question.question] = chosen.join(", ");
    }
    if (other.trim() && current) payload[current.question] = other.trim();
    runtime.answer(state.requestId, Object.keys(payload).length ? payload : null);
  };

  const advance = () => {
    if (index < questions.length - 1) setIndex(index + 1);
    else submit();
  };

  useEffect(() => {
    if (!hot || !current) return;
    const onKey = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;
      if (event.key === "Enter") {
        event.preventDefault();
        advance();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        if (state) runtime.answer(state.requestId, null);
        return;
      }
      const letter = event.key.toUpperCase();
      const at = LETTERS.indexOf(letter);
      if (at >= 0 && at < current.options.length) {
        event.preventDefault();
        pick(current.options[at]!.label);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // No dependency list on purpose: the handler closes over the current
    // question index and the answers picked so far, and both change per key.
  });

  if (!state) return null;

  if (settled) {
    const given = state.answers ? Object.values(state.answers) : [];
    return (
      <div className="inline-flex h-7 max-w-full items-center gap-2 rounded-chip bg-raised px-2 text-sm el-1">
        <Icon name="listTree" size={13} className="shrink-0 text-ink-38" />
        <span className="min-w-0 truncate text-ink-52">
          {state.dismissed ? "Question dismissed" : `Question: ${given.join(" · ")}`}
        </span>
      </div>
    );
  }

  if (!current) return null;
  const chosen = answers[current.question] ?? [];

  return (
    <div
      className={cx(
        "w-full overflow-hidden rounded-card bg-raised el-2",
        hot && "shadow-[var(--e2),0_0_0_3px_var(--accent-soft)]",
      )}
    >
      {questions.length > 1 && (
        <div className="flex items-center gap-1 border-b border-[var(--line-soft)] px-2 py-1.5">
          {questions.map((question, at) => {
            const done = (answers[question.question] ?? []).length > 0;
            return (
              <button
                key={question.header}
                type="button"
                onClick={() => setIndex(at)}
                className={cx(
                  "rise-1 h-6 rounded-chip px-2 text-sm",
                  at === index ? "bg-accent-soft text-accent-text" : "text-ink-52 hover:text-ink",
                  done && at !== index && "line-through",
                )}
              >
                {question.header}
              </button>
            );
          })}
        </div>
      )}

      <div className="px-3.5 py-3">
        <p className="mb-2.5 text-base font-medium text-ink">{current.question}</p>

        {current.multiSelect ? (
          <div className="flex flex-col gap-1.5">
            {current.options.map((option, at) => (
              <label
                key={option.label}
                className="rise-1 flex cursor-pointer items-start gap-2.5 rounded-control bg-raised px-3 py-2.5 el-1 hover:bg-raised-2"
              >
                <Check checked={chosen.includes(option.label)} onChange={() => pick(option.label)} label={option.label} />
                <span className="min-w-0 flex-1">
                  <span className="block text-base text-ink">{option.label}</span>
                  {option.description && <span className="mt-0.5 block text-sm text-ink-52">{option.description}</span>}
                </span>
                <Kbd>{LETTERS[at]!}</Kbd>
              </label>
            ))}
          </div>
        ) : (
          <RadioPick
            value={chosen[0] ?? ""}
            onChange={pick}
            options={current.options.map((option, at) => ({
              value: option.label,
              label: option.label,
              keycap: LETTERS[at]!,
              ...(option.description ? { description: option.description } : {}),
            }))}
          />
        )}

        <div className="mt-2.5">
          <Input
            value={other}
            onChange={(event) => setOther(event.target.value)}
            placeholder="Something else…"
            className="h-8"
            leading={<Icon name="pencil" size={13} className="text-ink-38" />}
          />
        </div>
      </div>

      <div className="flex items-center gap-2 border-t border-[var(--line-soft)] px-3.5 py-2.5">
        <Button size="sm" variant="ghost" onClick={() => runtime.answer(state.requestId, null)} trailing={hot ? <Kbd>Esc</Kbd> : undefined}>
          Dismiss
        </Button>
        <span className="flex-1" />
        <span className="text-xs text-ink-38">
          {index + 1} of {questions.length}
        </span>
        <Button
          size="sm"
          variant="primary"
          onClick={advance}
          trailing={hot ? <Kbd tone="on-accent">⏎</Kbd> : undefined}
        >
          {index < questions.length - 1 ? "Next" : "Submit"}
        </Button>
      </div>
    </div>
  );
}
