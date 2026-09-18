import { useEffect, useMemo, useState } from "react";
import type { Block, Question } from "@crew/fixtures";
import { cx } from "@/lib/cx";
import { threadOf } from "@/lib/source";
import { Icon } from "@/lib/icon";
import { useHotQuestion } from "./context";
import { Button, Checkbox, Input, Kbd, Radio, RadioGroup } from "@/ui";

const LETTERS = "ABCDEFGHIJ";

export function QuestionCard({ block, sessionId }: { block: Block; sessionId: string }) {
  const spec = block.question;
  const hot = useHotQuestion() === block.id;
  const [at, setAt] = useState(0);
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState(false);

  const questions = useMemo(() => spec?.questions ?? [], [spec]);
  const settled = Boolean(spec?.answers || spec?.dismissed);
  const current: Question | undefined = questions[at];

  const answerOf = (question: Question): string => {
    const chosen = picked[question.question] ?? [];
    const free = other[question.question]?.trim();
    return [...chosen, ...(free ? [free] : [])].join(", ");
  };

  const answered = (question: Question) => answerOf(question).length > 0;

  const toggle = (question: Question, label: string) => {
    setPicked((prev) => {
      const held = prev[question.question] ?? [];
      if (question.multiSelect) {
        return {
          ...prev,
          [question.question]: held.includes(label)
            ? held.filter((item) => item !== label)
            : [...held, label],
        };
      }
      return { ...prev, [question.question]: [label] };
    });
  };

  const submit = () => {
    if (!spec) return;
    const answers: Record<string, string> = {};
    for (const question of questions) {
      const value = answerOf(question);
      if (value) answers[question.question] = value;
    }
    void threadOf(sessionId).answer(spec.requestId, Object.keys(answers).length ? answers : null);
  };

  const dismiss = () => {
    if (spec) void threadOf(sessionId).answer(spec.requestId, null);
  };

  const last = at === questions.length - 1;

  useEffect(() => {
    if (!hot || settled || !current) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const node = event.target as HTMLElement | null;
      if (node && (node.tagName === "TEXTAREA" || node.tagName === "INPUT")) return;
      const letter = LETTERS.indexOf(event.key.toUpperCase());
      if (letter >= 0 && letter < current.options.length) {
        event.preventDefault();
        toggle(current, current.options[letter]!.label);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        if (last) submit();
        else setAt((value) => Math.min(value + 1, questions.length - 1));
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        dismiss();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  if (!spec) return null;

  if (settled) {
    const entries = Object.entries(spec.answers ?? {});
    return (
      <div data-block={block.id} className="flex flex-col">
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="group flex h-[18px] min-w-0 items-center gap-1.5 rounded-sm pr-1 text-left transition-colors hover:bg-[var(--fill-quaternary)]"
        >
          <span className="flex size-3.5 shrink-0 items-center justify-center">
            <Icon name="message" size={12} className="text-icon-tertiary" />
          </span>
          <span className="min-w-0 truncate text-small text-tertiary">
            {spec.dismissed
              ? `Question dismissed: ${questions[0]?.header ?? ""}`
              : `Question: ${entries.map(([, value]) => value).join(" · ")}`}
          </span>
          <Icon
            name={expanded ? "chevronUp" : "chevronDown"}
            size={12}
            className="shrink-0 text-icon-tertiary opacity-0 transition-opacity group-hover:opacity-100"
          />
        </button>
        {expanded && (
          <div className="my-1 flex flex-col gap-1.5 rounded-md bg-[var(--fill-quaternary)] p-2">
            {questions.map((question) => (
              <div key={question.question}>
                <p className="text-small text-tertiary">{question.question}</p>
                <p className="text-body text-secondary">
                  {spec.answers?.[question.question] ?? "— dismissed"}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (!current) return null;
  const chosen = picked[current.question] ?? [];

  return (
    <div
      data-block={block.id}
      className={cx(
        "my-1.5 overflow-hidden rounded-card bg-chrome",
        hot ? "shadow-[inset_0_0_0_1px_var(--attention-stroke)]" : "hairline",
      )}
    >
      {questions.length > 1 && (
        <div className="flex items-center gap-1 border-b border-[var(--stroke-tertiary)] px-2 py-1.5">
          {questions.map((question, index) => (
            <button
              key={question.question}
              type="button"
              onClick={() => setAt(index)}
              className={cx(
                "h-5 rounded-sm px-2 text-micro transition-colors duration-[var(--dur-1)]",
                index === at
                  ? "bg-[var(--fill-secondary)] text-primary"
                  : "text-tertiary hover:bg-[var(--fill-tertiary)]",
                answered(question) && index !== at && "line-through decoration-[var(--stroke-primary)]",
              )}
            >
              {question.header}
            </button>
          ))}
          <span className="ml-auto text-micro text-quaternary tnum">
            {at + 1} / {questions.length}
          </span>
        </div>
      )}

      <div className="flex flex-col gap-2 px-3 py-2.5">
        <p className="text-body text-primary">{current.question}</p>
        <div className="flex flex-col gap-1">
          {current.multiSelect ? (
            current.options.map((option, index) => (
              <Option
                key={option.label}
                letter={LETTERS[index]!}
                label={option.label}
                {...(option.description ? { description: option.description } : {})}
                selected={chosen.includes(option.label)}
                onSelect={() => toggle(current, option.label)}
                control={
                  <Checkbox
                    checked={chosen.includes(option.label)}
                    onCheckedChange={() => toggle(current, option.label)}
                  />
                }
              />
            ))
          ) : (
            <RadioGroup
              value={chosen[0] ?? ""}
              onValueChange={(next) => toggle(current, next)}
              className="flex flex-col gap-1"
            >
              {current.options.map((option, index) => (
                <Option
                  key={option.label}
                  letter={LETTERS[index]!}
                  label={option.label}
                  {...(option.description ? { description: option.description } : {})}
                  selected={chosen[0] === option.label}
                  onSelect={() => toggle(current, option.label)}
                  control={<Radio value={option.label} />}
                />
              ))}
            </RadioGroup>
          )}
        </div>
        <Input
          size="lg"
          placeholder="Something else…"
          value={other[current.question] ?? ""}
          onChange={(event) =>
            setOther((prev) => ({ ...prev, [current.question]: event.target.value }))
          }
        />
      </div>

      <div className="flex items-center gap-2 border-t border-[var(--stroke-tertiary)] px-3 py-2">
        <Button size="sm" onClick={dismiss} trailing={hot ? <Kbd className="ml-1">Esc</Kbd> : undefined}>
          Dismiss
        </Button>
        <span className="flex-1" />
        {!last && (
          <Button size="sm" onClick={() => setAt((value) => value + 1)}>
            Next
          </Button>
        )}
        <Button
          size="sm"
          tone="primary"
          onClick={submit}
          trailing={hot ? <Kbd className="ml-1 bg-[var(--fill-secondary)]">⏎</Kbd> : undefined}
        >
          Submit
        </Button>
      </div>
    </div>
  );
}

function Option({
  letter,
  label,
  description,
  selected,
  onSelect,
  control,
}: {
  letter: string;
  label: string;
  description?: string;
  selected: boolean;
  onSelect: () => void;
  control: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cx(
        "flex items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors duration-[var(--dur-1)]",
        selected ? "bg-[var(--fill-tertiary)]" : "hover:bg-[var(--fill-quaternary)]",
      )}
    >
      <span className="mt-px flex shrink-0 items-center gap-2">
        <kbd
          className={cx(
            "flex size-4 items-center justify-center rounded-xs font-sans text-micro leading-none",
            selected
              ? "bg-[var(--accent-fill)] text-[var(--accent)]"
              : "bg-[var(--fill-tertiary)] text-quaternary",
          )}
        >
          {letter}
        </kbd>
        {control}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-body text-primary">{label}</span>
        {description && <span className="block text-small text-tertiary">{description}</span>}
      </span>
    </button>
  );
}
