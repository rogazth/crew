import { useState } from "react";
import type { Answers, Block, Question } from "../../lib/blocks";

type Props = {
  block: Block;
  onAnswer: (requestId: number, answers: Answers | null) => void;
};

type Picks = Record<string, { chosen: string[]; other: string }>;

const LETTERS = "ABCDEFGHIJ";

/** One question at a time; Submit sends the whole set the way Claude Code expects it. */
export function QuestionCard({ block, onAnswer }: Props) {
  const ask = block.question;
  const [step, setStep] = useState(0);
  const [picks, setPicks] = useState<Picks>({});
  if (!ask) return null;

  const { questions, requestId } = ask;
  const current = questions[step];
  if (!current) return null;
  const pick = picks[current.question] ?? { chosen: [], other: "" };
  const last = step === questions.length - 1;
  const answered = questions.every((q) => {
    const p = picks[q.question];
    return p && (p.chosen.length > 0 || p.other.trim());
  });

  const set = (next: { chosen: string[]; other: string }) =>
    setPicks((prev) => ({ ...prev, [current.question]: next }));

  const choose = (label: string) => {
    if (current.multiSelect) {
      const chosen = pick.chosen.includes(label)
        ? pick.chosen.filter((item) => item !== label)
        : [...pick.chosen, label];
      set({ ...pick, chosen });
    } else {
      set({ ...pick, chosen: [label] });
    }
  };

  const submit = () => {
    const answers: Answers = {};
    for (const q of questions) {
      const p = picks[q.question];
      if (!p) continue;
      const parts = [...p.chosen];
      if (p.other.trim()) parts.push(p.other.trim());
      answers[q.question] = parts.join(", ");
    }
    onAnswer(requestId, answers);
  };

  return (
    <div className="crew-prose my-1.5 flex flex-col gap-2 rounded-[10px] border border-hairline bg-canvas p-3">
      {questions.length > 1 && (
        <div className="flex gap-1">
          {questions.map((q, index) => (
            <button
              key={q.question}
              type="button"
              onClick={() => setStep(index)}
              className={`h-6 rounded-md px-2 text-[12px] leading-4 ${
                index === step ? "bg-card text-text" : "text-text-muted hover:text-text"
              }`}
            >
              {q.header}
            </button>
          ))}
        </div>
      )}
      <p className="font-medium">{current.question}</p>
      <Options question={current} chosen={pick.chosen} onChoose={choose} />
      <input
        value={pick.other}
        onChange={(event) => set({ ...pick, other: event.target.value })}
        placeholder="Other"
        className="h-7 rounded-md bg-card px-2 text-[12px] outline-none placeholder:text-placeholder"
      />
      <div className="flex justify-end gap-1.5">
        <button
          type="button"
          onClick={() => onAnswer(requestId, null)}
          className="h-6 rounded-md px-2 text-[12px] leading-4 text-text-muted hover:text-text"
        >
          Dismiss
        </button>
        {last ? (
          <button
            type="button"
            disabled={!answered}
            onClick={submit}
            className="crew-ink h-6 rounded-md px-2.5 text-[12px] leading-4 disabled:opacity-40"
          >
            Submit
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setStep(step + 1)}
            className="crew-ink h-6 rounded-md px-2.5 text-[12px] leading-4"
          >
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
  return (
    <div className="flex flex-col gap-0.5">
      {question.options.map((option, index) => {
        const on = chosen.includes(option.label);
        return (
          <button
            key={option.label}
            type="button"
            role={question.multiSelect ? "checkbox" : "radio"}
            aria-checked={on}
            onClick={() => onChoose(option.label)}
            className={`flex items-start gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-card ${on ? "bg-card" : ""}`}
          >
            <span
              className={`mt-px flex size-4 shrink-0 items-center justify-center rounded border text-[10px] leading-none ${
                on ? "crew-ink border-transparent" : "border-border-strong text-text-muted"
              }`}
            >
              {LETTERS[index] ?? "·"}
            </span>
            <span className="flex min-w-0 flex-col">
              <span>{option.label}</span>
              {option.description && <span className="text-[12px] leading-4 text-text-muted">{option.description}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** What was chosen, once the card has done its job. */
export function answerSummary(block: Block): string {
  const ask = block.question;
  if (!ask) return "";
  if (ask.dismissed) return "Dismissed";
  if (!ask.answers) return "";
  return ask.questions.map((q) => ask.answers?.[q.question] ?? "").filter(Boolean).join(" · ");
}
