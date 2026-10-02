import { ArrowUpIcon, BotIcon, FolderPlusIcon, GlobeIcon, type LucideIcon as Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { CrewGlyph } from "../chrome/CrewGlyph";
import { AccessPicker, ModelControls } from "../chrome/ComposerControls";
import { useDefaultAgent } from "../hooks/useDefaultAgent";
import type { AgentChoice } from "../lib/providers";

type Props = {
  /** No project is open yet: the page greets a new user and shows the way in. */
  firstRun: boolean;
  /** A new session in home, with `text` as its first message, in what the chips say. */
  onAsk: (text: string, choice: AgentChoice) => void;
  onOpenFolder: () => void;
  onNewAgent: () => void;
  onOpenBrowser: () => void;
};

const SUGGESTIONS = ["Explain a concept", "Draft an email", "Write a shell one-liner", "Plan my week"];

/**
 * Home with no tab open: a composer in the middle of the page. What is sent
 * starts a session in home's folder with that message, in the model, effort
 * and access the chips say; the tab it opens is the session's, chat or
 * terminal as Settings say. The chips are the default every new session
 * starts with, so a pick here is the next ⌘N's too.
 */
export function HomeStart({ firstRun, onAsk, onOpenFolder, onNewAgent, onOpenBrowser }: Props) {
  const { effective, update } = useDefaultAgent();
  const [draft, setDraft] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);

  useEffect(() => field.current?.focus(), []);

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    onAsk(text, effective);
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex min-h-full w-full max-w-[720px] flex-col justify-center px-6 py-10">
        <div className="flex flex-col items-center text-center">
          <CrewGlyph className="size-14" />
          <h1 className="mt-4 text-[26px] font-semibold tracking-[-0.02em]">
            {firstRun ? "Welcome to Crew" : "What are we working on?"}
          </h1>
          {firstRun && (
            <p className="mt-1.5 max-w-[460px] text-text-muted">
              Ask anything to start, no project needed. Open a folder when you want your crew to work on code.
            </p>
          )}
        </div>

        <form
          className="crew-composer mt-7"
          onSubmit={(event) => {
            event.preventDefault();
            send();
          }}
        >
          <textarea
            ref={field}
            rows={2}
            value={draft}
            aria-label="Ask anything"
            placeholder="Ask anything…"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                send();
              }
            }}
            className="crew-composer-field resize-none text-text placeholder:text-placeholder"
          />
          <div className="mt-1.5 flex h-8 items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1.5">
              <ModelControls value={effective} onChange={update} />
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <AccessPicker provider={effective.provider} value={effective.access} onChange={(access) => update({ ...effective, access })} />
              <button
                type="submit"
                aria-label="Send"
                disabled={!draft.trim()}
                className="grid size-[30px] place-items-center rounded-full bg-text text-inverse transition-colors focus-visible:ring-[1.5px] focus-visible:ring-focus/50 focus-visible:outline-none disabled:bg-hover disabled:text-placeholder"
              >
                <ArrowUpIcon className="size-4" />
              </button>
            </div>
          </div>
        </form>

        <div className="mt-3 flex flex-wrap justify-center gap-1.5">
          {SUGGESTIONS.map((text) => (
            <button
              key={text}
              type="button"
              onClick={() => {
                setDraft(`${text}: `);
                field.current?.focus();
              }}
              className="rounded-full px-3 py-1 text-[12px] text-text-muted ring-1 ring-border ring-inset transition-colors hover:bg-hover hover:text-text"
            >
              {text}
            </button>
          ))}
        </div>

        {firstRun && (
          <div className="mt-10 grid grid-cols-3 gap-2">
            <StartCard icon={FolderPlusIcon} title="Open a project folder" hint="Agents get its code, worktrees and commands" onClick={onOpenFolder} />
            <StartCard icon={BotIcon} title="Meet your first agent" hint="A teammate with a name, a mailbox and a history" onClick={onNewAgent} />
            <StartCard icon={GlobeIcon} title="Drive a browser tab" hint="Agents can click, fill and screenshot for you" onClick={onOpenBrowser} />
          </div>
        )}
      </div>
    </div>
  );
}

function StartCard({ icon: Glyph, title, hint, onClick }: { icon: Icon; title: string; hint: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-col items-start gap-2 rounded-xl bg-card/60 p-3 text-left ring-1 ring-border ring-inset transition-colors outline-none hover:bg-card focus-visible:ring-2 focus-visible:ring-focus/50"
    >
      <Glyph className="size-4 text-icon" />
      <span className="font-medium">{title}</span>
      <span className="text-[12px] leading-snug text-text-muted">{hint}</span>
    </button>
  );
}
