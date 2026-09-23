import { Checkbox, Radio } from "@cloudflare/kumo";
import { useEffect, useRef, useState } from "react";
import type { Answers, Block, Question } from "../../lib/blocks";
import {
  EMPTY_PICK,
  allAnswered,
  answered,
  choose as chooseIn,
  optionLetter,
  questionKey,
  shapeAnswers,
  type Pick,
  type Picks,
} from "../../lib/question";

type Props = {
  block: Block;
  /** Only the newest open card listens for A/B/C and Enter; the rest are scrolled-past history. */
  hot?: boolean;
  onAnswer: (requestId: number, answers: Answers | null) => void;
};

/** One question at a time; Submit sends the whole set the way Claude Code expects it. */
export function QuestionCard({ block, hot = false, onAnswer }: Props) {
  const ask = block.question;
  const [step, setStep] = useState(0);
  const [picks, setPicks] = useState<Picks>({});
  const card = useRef<HTMLDivElement>(null);

  const questions = ask?.questions ?? [];
  const current = questions[step];
  const pick = current ? (picks[current.question] ?? EMPTY_PICK) : EMPTY_PICK;
  const last = step === questions.length - 1;
  const complete = allAnswered(questions, picks);

  const set = (next: Pick) => {
    if (!current) return;
    setPicks((prev) => ({ ...prev, [current.question]: next }));
  };

  const choose = (label: string) => {
    if (!current) return;
    set(chooseIn(pick, label, current.multiSelect));
  };

  const submit = () => {
    if (!ask || !complete) return;
    onAnswer(ask.requestId, shapeAnswers(questions, picks));
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
      const action = questionKey(event, {
        typing,
        inCard: card.current?.contains(target) ?? false,
        answered: answered(picks[current.question]),
        options: current.options.length,
      });
      if (!action) return;
      event.preventDefault();
      if (action.kind === "dismiss") onAnswer(ask!.requestId, null);
      else if (action.kind === "advance") advance();
      else choose(current.options[action.index]!.label);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  });

  if (!ask || !current) return null;

  return (
    <div ref={card} tabIndex={-1} className="crew-card my-1.5 outline-none">
      {questions.length > 1 && (
        <div className="flex gap-1">
          {questions.map((q, index) => (
            <button
              key={q.question}
              type="button"
              onClick={() => setStep(index)}
              className={`h-6 rounded-md px-2 text-[12px] leading-4 transition-colors ${
                index === step ? "bg-card text-text" : "text-text-muted hover:text-text"
              } ${answered(picks[q.question]) && index !== step ? "line-through decoration-hairline" : ""}`}
            >
              {q.header}
            </button>
          ))}
        </div>
      )}
      <p className="font-medium">{current.question}</p>
      <Options key={current.question} question={current} chosen={pick.chosen} onChoose={choose} />
      <input
        value={pick.other}
        onChange={(event) => set({ ...pick, other: event.target.value })}
        placeholder={current.multiSelect ? "Anything else" : "Something else"}
        className="crew-field"
      />
      <div className="flex items-center justify-end gap-1.5">
        <button type="button" onClick={() => onAnswer(ask.requestId, null)} className="crew-btn">
          Dismiss
        </button>
        {last ? (
          <button type="button" disabled={!complete} onClick={submit} className="crew-btn crew-btn-primary">
            Submit
          </button>
        ) : (
          <button type="button" disabled={!answered(pick)} onClick={advance} className="crew-btn crew-btn-primary">
            Next
          </button>
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
          <Checkbox
            key={option.label}
            checked={picked.has(option.label)}
            onCheckedChange={() => onChoose(option.label)}
            label={<OptionLabel option={option} index={index} />}
          />
        ))}
      </div>
    );
  }
  return (
    <Radio.Group value={chosen[0] ?? ""} onValueChange={(next) => onChoose(String(next))} className="crew-options">
      <Radio.Legend className="sr-only">{question.question}</Radio.Legend>
      {question.options.map((option, index) => (
        <Radio.Item key={option.label} value={option.label} label={<OptionLabel option={option} index={index} />} />
      ))}
    </Radio.Group>
  );
}

function OptionLabel({ option, index }: { option: Question["options"][number]; index: number }) {
  return (
    <span className="flex items-start gap-2">
      <kbd className="crew-keycap mt-px">{optionLetter(index)}</kbd>
      <span className="flex min-w-0 flex-col">
        <span>{option.label}</span>
        {option.description && <span className="text-[12px] leading-4 text-text-muted">{option.description}</span>}
      </span>
    </span>
  );
}
