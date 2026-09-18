import clsx from "clsx";
import { useEffect, useState } from "react";
import type { Block, Question } from "@crew/fixtures";
import { Button, Checkbox, Input, Kbd, Radio } from "@/ui";

const LETTERS = "ABCDEFGHIJ";

/**
 * One question at a time, with a header strip to move between them. Letters
 * pick, Enter advances, Escape dismisses — the card is answerable without a
 * mouse, which is the whole point of asking in the transcript.
 */
export function QuestionCard({
  block,
  hot,
  onAnswer,
}: {
  block: Block;
  hot: boolean;
  onAnswer: (answers: Record<string, string> | null) => void;
}) {
  const questions = block.question?.questions ?? [];
  const [at, setAt] = useState(0);
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});

  const question = questions[at];

  const toggle = (option: string) => {
    if (!question) return;
    setPicked((held) => {
      const current = held[question.question] ?? [];
      if (!question.multiSelect) return { ...held, [question.question]: [option] };
      return {
        ...held,
        [question.question]: current.includes(option)
          ? current.filter((x) => x !== option)
          : [...current, option],
      };
    });
  };

  const collect = (): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const entry of questions) {
      const chosen = [...(picked[entry.question] ?? [])];
      const free = other[entry.question]?.trim();
      if (free) chosen.push(free);
      if (chosen.length) out[entry.question] = chosen.join(", ");
    }
    return out;
  };

  const answeredCount = questions.filter(
    (entry) => (picked[entry.question]?.length ?? 0) > 0 || other[entry.question]?.trim(),
  ).length;
  const last = at === questions.length - 1;
  const ready = (picked[question?.question ?? ""]?.length ?? 0) > 0 || Boolean(other[question?.question ?? ""]?.trim());

  useEffect(() => {
    if (!hot || !question) return;
    const onKey = (event: KeyboardEvent) => {
      const node = event.target as HTMLElement | null;
      if (node && /^(input|textarea)$/i.test(node.tagName)) return;
      const letter = LETTERS.indexOf(event.key.toUpperCase());
      if (letter >= 0 && letter < question.options.length) {
        event.preventDefault();
        toggle(question.options[letter]!.label);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        if (last) onAnswer(collect());
        else setAt((held) => Math.min(questions.length - 1, held + 1));
      }
      if (event.key === "Escape") {
        event.preventDefault();
        onAnswer(null);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  if (!question) return null;

  return (
    <div
      className={clsx(
        "mt-1 overflow-hidden rounded-[var(--r)] border bg-raised",
        hot ? "border-amber" : "border-rule",
      )}
    >
      <div className="flex items-stretch border-b border-rule">
        {questions.map((entry, index) => {
          const done =
            (picked[entry.question]?.length ?? 0) > 0 || Boolean(other[entry.question]?.trim());
          return (
            <button
              key={entry.question}
              type="button"
              onClick={() => setAt(index)}
              className={clsx(
                "flex items-center gap-1.5 border-r border-rule px-2 py-1 font-mono text-xs",
                index === at ? "bg-ink text-on-ink" : "text-ink-3 hover:text-ink",
                done && index !== at && "line-through",
              )}
            >
              <span className="opacity-60">{index + 1}</span>
              {entry.header}
            </button>
          );
        })}
        <span className="ml-auto flex items-center px-2 font-mono text-xs text-ink-4">
          {answeredCount}/{questions.length}
        </span>
      </div>

      <div className="flex flex-col gap-2 px-2 py-2">
        <p className="text-md text-ink">{question.question}</p>
        <Options
          question={question}
          picked={picked[question.question] ?? []}
          onToggle={toggle}
        />
        <label className="flex items-center gap-2">
          <span className="shrink-0 font-mono text-xs text-ink-4">Something else</span>
          <Input
            value={other[question.question] ?? ""}
            onChange={(event) => setOther({ ...other, [question.question]: event.target.value })}
            placeholder="Type an answer of your own"
          />
        </label>
      </div>

      <div className="flex items-center gap-2 border-t border-rule px-2 py-1.5">
        <Button variant="ghost" onClick={() => onAnswer(null)} kbd={hot ? <Kbd>Esc</Kbd> : undefined}>
          Dismiss
        </Button>
        {at > 0 ? <Button onClick={() => setAt(at - 1)}>Back</Button> : null}
        <Button
          variant="primary"
          className="ml-auto"
          disabled={!ready && last}
          onClick={() => (last ? onAnswer(collect()) : setAt(at + 1))}
          kbd={hot ? <Kbd className="border-on-ink/40 text-on-ink">⏎</Kbd> : undefined}
        >
          {last ? "Submit" : "Next"}
        </Button>
      </div>
    </div>
  );
}

function Options({
  question,
  picked,
  onToggle,
}: {
  question: Question;
  picked: string[];
  onToggle: (label: string) => void;
}) {
  return (
    <div role={question.multiSelect ? "group" : "radiogroup"} className="flex flex-col">
      {question.options.map((option, index) => {
        const checked = picked.includes(option.label);
        return (
          <button
            key={option.label}
            type="button"
            role={question.multiSelect ? "checkbox" : "radio"}
            aria-checked={checked}
            onClick={() => onToggle(option.label)}
            className={clsx(
              "flex items-baseline gap-2 rounded-[var(--r)] px-1 py-1 text-left transition-colors duration-[var(--fast)]",
              checked ? "bg-accent-wash" : "hover:bg-sunken",
            )}
          >
            <Kbd className="translate-y-[1px]">{LETTERS[index]}</Kbd>
            {/* The whole row is the control, so the mark is presentational — a
                nested button here is invalid HTML and React says so out loud. */}
            {question.multiSelect ? (
              <Checkbox readOnly checked={checked} label={option.label} className="translate-y-[2px]" />
            ) : (
              <Radio readOnly checked={checked} label={option.label} className="translate-y-[2px]" />
            )}
            <span className="min-w-0">
              <span className="text-md text-ink">{option.label}</span>
              {option.description ? (
                <span className="block text-sm text-ink-3">{option.description}</span>
              ) : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** An answered card is one line: the question, and what was chosen. */
export function AnsweredQuestion({ block }: { block: Block }) {
  const question = block.question;
  if (!question) return null;
  const entries = Object.entries(question.answers ?? {});
  if (question.dismissed || entries.length === 0) {
    return <span className="text-md text-ink-3">Question dismissed</span>;
  }
  return (
    <span className="flex flex-col gap-0.5">
      {entries.map(([asked, answer]) => (
        <span key={asked} className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-md text-ink-3">{asked}</span>
          <span className="ml-auto shrink-0 font-mono text-sm text-ink">{answer}</span>
        </span>
      ))}
    </span>
  );
}
