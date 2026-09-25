import { Checkbox } from "@base-ui/react/checkbox";
import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { CheckIcon, MessageCircleQuestionIcon } from "lucide-react";
import { Button } from "../../chrome/kit";
import { useEffect, useRef, useState } from "react";
import type { Answers, Block, Question } from "../../lib/blocks";

type Props = {
  block: Block;
  /** Only the newest open card listens for A/B/C and Enter; the rest are scrolled-past history. */
  hot?: boolean;
  onAnswer: (requestId: number, answers: Answers | null) => void;
};

type Pick = { chosen: string[]; other: string };
type Picks = Record<string, Pick>;

const LETTERS = "ABCDEFGHIJ";
const EMPTY: Pick = { chosen: [], other: "" };

function answered(pick: Pick | undefined): boolean {
  return pick !== undefined && (pick.chosen.length > 0 || pick.other.trim().length > 0);
}

/** One question at a time; Submit sends the whole set the way Claude Code expects it. */
export function QuestionCard({ block, hot = false, onAnswer }: Props) {
  const ask = block.question;
  const [step, setStep] = useState(0);
  const [picks, setPicks] = useState<Picks>({});
  const card = useRef<HTMLDivElement>(null);

  const questions = ask?.questions ?? [];
  const current = questions[step];
  const pick = current ? (picks[current.question] ?? EMPTY) : EMPTY;
  const last = step === questions.length - 1;
  const complete = questions.every((q) => answered(picks[q.question]));

  const set = (next: Pick) => {
    if (!current) return;
    setPicks((prev) => ({ ...prev, [current.question]: next }));
  };

  const choose = (label: string) => {
    if (!current) return;
    if (current.multiSelect) {
      const chosen = pick.chosen.includes(label) ? pick.chosen.filter((item) => item !== label) : [...pick.chosen, label];
      set({ ...pick, chosen });
    } else {
      set({ ...pick, chosen: [label] });
    }
  };

  const submit = () => {
    if (!ask || !complete) return;
    const answers: Answers = {};
    for (const q of questions) {
      const p = picks[q.question] ?? EMPTY;
      const parts = [...p.chosen];
      if (p.other.trim()) parts.push(p.other.trim());
      answers[q.question] = parts.join(", ");
    }
    onAnswer(ask.requestId, answers);
  };

  const advance = () => {
    if (last) submit();
    else setStep(step + 1);
  };

  // The composer owns focus otherwise, and letters typed there are a draft, not an answer.
  useEffect(() => {
    if (hot) card.current?.focus();
  }, [hot]);

  // Letters pick, Enter advances, Escape dismisses: a keyboard answers without a click.
  useEffect(() => {
    if (!hot || !current) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target?.matches("input, textarea, [contenteditable]") ?? false;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onAnswer(ask!.requestId, null);
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        if (typing && !card.current?.contains(target)) return;
        if (answered(picks[current.question])) {
          event.preventDefault();
          advance();
        }
        return;
      }
      if (typing) return;
      const index = LETTERS.indexOf(event.key.toUpperCase());
      if (index >= 0 && index < current.options.length && event.key.length === 1) {
        event.preventDefault();
        choose(current.options[index]!.label);
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  });

  if (!ask || !current) return null;

  return (
    <div ref={card} tabIndex={-1} className="crew-card my-2 outline-none">
      <div className="flex items-center gap-2.5">
        <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-warning/15 text-warning">
          <MessageCircleQuestionIcon className="size-4" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="font-semibold">{current.question}</span>
          <span className="text-[12px] text-text-muted">
            {questions.length > 1 ? `Question ${step + 1} of ${questions.length}` : "Waiting for your answer"}
            {current.multiSelect ? " · pick any" : ""}
          </span>
        </div>
      </div>
      {questions.length > 1 && (
        <div className="flex gap-1">
          {questions.map((q, index) => (
            <button
              key={q.question}
              type="button"
              onClick={() => setStep(index)}
              className={`flex h-6 items-center gap-1 rounded-full px-2.5 text-[12px] leading-4 transition-colors ${
                index === step ? "bg-accent text-inverse" : "text-text-muted ring-1 ring-hairline hover:text-text"
              }`}
            >
              {answered(picks[q.question]) && index !== step ? <CheckIcon className="size-3" /> : null}
              {q.header}
            </button>
          ))}
        </div>
      )}
      <Options key={current.question} question={current} chosen={pick.chosen} onChoose={choose} />
      <input
        value={pick.other}
        onChange={(event) => set({ ...pick, other: event.target.value })}
        placeholder={current.multiSelect ? "Anything else" : "Something else"}
        className="h-9 rounded-xl bg-canvas px-3 text-[13px] ring-1 ring-border outline-none placeholder:text-placeholder focus:ring-border-strong"
      />
      <div className="flex items-center gap-1.5">
        <span className="flex-1 text-[11.5px] text-text-muted">
          {hot ? `${LETTERS[0]}–${LETTERS[current.options.length - 1]} to pick · ↵ ${last ? "to send" : "for next"} · esc to dismiss` : ""}
        </span>
        <Button variant="ghost" className="h-7 px-2.5" onClick={() => onAnswer(ask.requestId, null)}>
          Dismiss
        </Button>
        {last ? (
          <Button variant="primary" className="h-7 px-2.5" disabled={!complete} onClick={submit}>
            Send answer
          </Button>
        ) : (
          <Button variant="primary" className="h-7 px-2.5" disabled={!answered(pick)} onClick={advance}>
            Next
          </Button>
        )}
      </div>
    </div>
  );
}

function Options({
  question,
  chosen,
  onChoose,
}: {
  question: Question;
  chosen: string[];
  onChoose: (label: string) => void;
}) {
  if (question.multiSelect) {
    const picked = new Set(chosen);
    return (
      <div role="group" aria-label={question.question} className="crew-options flex flex-col">
        {question.options.map((option, index) => (
          <label key={option.label} className={CHOICE}>
            <Checkbox.Root
              checked={picked.has(option.label)}
              onCheckedChange={() => onChoose(option.label)}
              className="mt-0.5 grid size-4 shrink-0 place-items-center rounded-[5px] ring-1 ring-border-strong outline-none focus-visible:ring-2 focus-visible:ring-focus/50 data-checked:bg-accent data-checked:ring-accent"
            >
              <Checkbox.Indicator>
                <CheckIcon className="size-3 text-inverse" />
              </Checkbox.Indicator>
            </Checkbox.Root>
            <OptionLabel option={option} index={index} />
          </label>
        ))}
      </div>
    );
  }
  return (
    <RadioGroup
      aria-label={question.question}
      value={chosen[0] ?? ""}
      onValueChange={(next) => onChoose(String(next))}
      className="crew-options flex flex-col"
    >
      {question.options.map((option, index) => (
        <label key={option.label} className={CHOICE}>
          <Radio.Root
            value={option.label}
            className="mt-0.5 grid size-4 shrink-0 place-items-center rounded-full ring-1 ring-border-strong outline-none focus-visible:ring-2 focus-visible:ring-focus/50 data-checked:bg-accent data-checked:ring-accent"
          >
            <Radio.Indicator className="size-1.5 rounded-full bg-inverse" />
          </Radio.Root>
          <OptionLabel option={option} index={index} />
        </label>
      ))}
    </RadioGroup>
  );
}

/** One choice: a row that lights when hovered, the control on its left. */
const CHOICE =
  "flex cursor-pointer items-start gap-2.5 rounded-lg ring-1 ring-hairline transition-colors hover:bg-hover has-data-checked:bg-card has-data-checked:ring-border-strong";

function OptionLabel({ option, index }: { option: Question["options"][number]; index: number }) {
  return (
    <span className="flex items-start gap-2">
      <kbd className="crew-keycap mt-px">{LETTERS[index] ?? "·"}</kbd>
      <span className="flex min-w-0 flex-col">
        <span>{option.label}</span>
        {option.description && <span className="text-[12px] leading-4 text-text-muted">{option.description}</span>}
      </span>
    </span>
  );
}
