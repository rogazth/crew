import { Checkbox } from "@base-ui/react/checkbox";
import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { ArrowLeftIcon, ArrowRightIcon, MessageCircleQuestionIcon } from "lucide-react";
import { Button } from "../../chrome/kit";
import { Kbd } from "../../chrome/Kbd";
import { SETTLED_TILE } from "./approvalIcon";
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
  const other = useRef<HTMLInputElement>(null);

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
      // A card under an open thread is not on screen: the keys are the thread's. In a thread, Esc goes back, it never decides.
      if (card.current?.closest("[inert]")) return;
      if (event.key === "Escape" && card.current?.closest("[data-agent-view]")) return;
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
      } else if (index === current.options.length && event.key.length === 1) {
        event.preventDefault();
        other.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  });

  if (!ask || !current) return null;

  const many = questions.length > 1;
  return (
    <div ref={card} tabIndex={-1} className="crew-card my-2 outline-none">
      <QuestionHead question={current} />
      <div className="crew-options flex flex-col">
        <Options key={current.question} question={current} chosen={pick.chosen} onChoose={choose} />
        <label className={CHOICE}>
          <span className="crew-keycap" {...(pick.other.trim() ? { "data-checked": "" } : {})}>
            {LETTERS[current.options.length] ?? "·"}
          </span>
          <input
            ref={other}
            value={pick.other}
            onChange={(event) => set({ ...pick, other: event.target.value })}
            placeholder={current.multiSelect ? "Anything else…" : "Something else…"}
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-placeholder"
          />
        </label>
      </div>
      <div className="flex items-center gap-1.5">
        {many ? (
          <span className="flex items-center gap-0.5 text-[12.5px] text-text-muted tabular-nums">
            <button
              type="button"
              aria-label="Previous question"
              disabled={step === 0}
              onClick={() => setStep(step - 1)}
              className="grid size-6 place-items-center rounded-md transition-colors enabled:hover:bg-hover enabled:hover:text-text disabled:opacity-40"
            >
              <ArrowLeftIcon className="size-3.5" />
            </button>
            {step + 1} / {questions.length}
            <button
              type="button"
              aria-label="Next question"
              disabled={last}
              onClick={() => setStep(step + 1)}
              className="grid size-6 place-items-center rounded-md transition-colors enabled:hover:bg-hover enabled:hover:text-text disabled:opacity-40"
            >
              <ArrowRightIcon className="size-3.5" />
            </button>
          </span>
        ) : null}
        <span className="flex-1" />
        <Button className="h-7 px-2.5" {...(hot ? { keys: "esc" } : {})} onClick={() => onAnswer(ask.requestId, null)}>
          Skip
        </Button>
        <Button
          variant="primary"
          className="h-7 px-2.5"
          disabled={last ? !complete : !answered(pick)}
          onClick={last ? submit : advance}
        >
          {last ? "Send" : "Continue"}
          {hot && <Kbd keys="↵" className="border-white/20 bg-white/10 text-current! opacity-80" />}
        </Button>
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
  // The letter is the control: it fills when its choice is picked, so the row needs no radio of its own.
  if (question.multiSelect) {
    const picked = new Set(chosen);
    return (
      <div role="group" aria-label={question.question} className="contents">
        {question.options.map((option, index) => (
          <label key={option.label} className={CHOICE}>
            <Checkbox.Root
              checked={picked.has(option.label)}
              onCheckedChange={() => onChoose(option.label)}
              className="crew-keycap outline-none focus-visible:ring-2 focus-visible:ring-focus/50"
            >
              {LETTERS[index] ?? "·"}
            </Checkbox.Root>
            <OptionLabel option={option} />
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
      className="contents"
    >
      {question.options.map((option, index) => (
        <label key={option.label} className={CHOICE}>
          <Radio.Root value={option.label} className="crew-keycap outline-none focus-visible:ring-2 focus-visible:ring-focus/50">
            {LETTERS[index] ?? "·"}
          </Radio.Root>
          <OptionLabel option={option} />
        </label>
      ))}
    </RadioGroup>
  );
}

/** One choice: a row that lights when hovered, its letter on the left. */
const CHOICE =
  "flex cursor-pointer items-start gap-2.5 rounded-lg ring-1 ring-hairline transition-colors hover:bg-hover has-data-checked:bg-card has-data-checked:ring-border-strong";

function OptionLabel({ option }: { option: Question["options"][number] }) {
  return (
    <span className="flex min-w-0 flex-col">
      <span>{option.label}</span>
      {option.description && <span className="text-[12px] leading-4 text-text-muted">{option.description}</span>}
    </span>
  );
}

/** Which of a question's options an answer names, and what it said besides them ("Other"). */
function picked(question: Question, answer: string | undefined): { chosen: Set<string>; other: string } {
  if (!answer) return { chosen: new Set(), other: "" };
  const labels = question.options.map((option) => option.label);
  if (labels.includes(answer)) return { chosen: new Set([answer]), other: "" };
  const parts = answer.split(", ");
  const chosen = new Set(parts.filter((part) => labels.includes(part)));
  return { chosen, other: parts.filter((part) => !labels.includes(part)).join(", ") };
}

/**
 * A question already answered, as the card it was: every question at once,
 * the choices that went back filled, nothing left to press. Skipped, nothing
 * is filled and the head says so.
 */
export function AnsweredQuestions({ block }: { block: Block }) {
  const ask = block.question;
  if (!ask) return null;
  const skipped = ask.dismissed === true;
  // One question is the card's title. Several share one head, "Questions", and each is a line over its choices, drawn tighter.
  const many = ask.questions.length > 1;
  return (
    <div className="crew-card my-2" data-answered-card>
      {many ? (
        <div className="flex items-center gap-2.5">
          <span className={`grid size-7 shrink-0 place-items-center rounded-lg ${SETTLED_TILE}`}>
            <MessageCircleQuestionIcon className="size-4" />
          </span>
          <span className="min-w-0 flex-1 font-medium">Questions</span>
          {skipped ? <span className="shrink-0 text-[12.5px] text-text-muted">Skipped</span> : null}
        </div>
      ) : null}
      {ask.questions.map((question) => {
        const { chosen, other } = picked(question, skipped ? undefined : ask.answers?.[question.question]);
        return (
          <div key={question.question} className={`flex flex-col ${many ? "gap-1.5" : "gap-3"}`}>
            {many ? (
              <p className="flex items-baseline gap-2 text-[13.5px] leading-[19px]">
                <span className="min-w-0">{question.question}</span>
                {question.multiSelect ? <span className="shrink-0 text-[12px] text-text-muted">Multiple</span> : null}
              </p>
            ) : (
              <QuestionHead question={question} settled {...(skipped ? { note: "Skipped" } : {})} />
            )}
            <div className="crew-options flex flex-col" {...(many ? { "data-compact": "" } : {})}>
              {question.options.map((option, index) => (
                <label key={option.label} data-static {...(chosen.has(option.label) ? {} : { "data-dim": "" })} className={CHOICE}>
                  <span className="crew-keycap" {...(chosen.has(option.label) ? { "data-checked": "" } : {})}>
                    {LETTERS[index] ?? "·"}
                  </span>
                  <OptionLabel option={option} />
                </label>
              ))}
              {other ? (
                <label data-static className={CHOICE}>
                  <span className="crew-keycap" data-checked="">
                    {LETTERS[question.options.length] ?? "·"}
                  </span>
                  <span className="min-w-0">{other}</span>
                </label>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * The question is the card's title: no "Question" above it to say what it
 * plainly is. "Multiple" when it takes more than one choice.
 */
function QuestionHead({ question, note, settled = false }: { question: Question; note?: string; settled?: boolean }) {
  const aside = note ?? (question.multiSelect ? "Multiple" : undefined);
  return (
    <div className="flex items-start gap-2.5">
      <span className={`grid size-7 shrink-0 place-items-center rounded-lg ${settled ? SETTLED_TILE : "bg-info/12 text-info"}`}>
        <MessageCircleQuestionIcon className="size-4" />
      </span>
      <span className="min-w-0 flex-1 pt-1 font-medium">{question.question}</span>
      {aside ? <span className="shrink-0 pt-1 text-[12.5px] text-text-muted">{aside}</span> : null}
    </div>
  );
}
