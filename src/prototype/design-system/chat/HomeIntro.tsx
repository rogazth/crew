// PROTOTYPE — throwaway. Home with no tab open, in the same language as a new
// session's first screen: a mark and a line above, the composer in the middle,
// ways in below. HomeStart keeps the state and what sending does; this only
// lays it out.
import "./chat.css";
import { BotIcon, CalendarDaysIcon, FolderPlusIcon, GlobeIcon, HouseIcon, LightbulbIcon, MailIcon, MonitorIcon, TerminalIcon } from "lucide-react";
import type { RefObject } from "react";
import { CrewGlyph } from "../../../chrome/CrewGlyph";
import { AccessPicker, ModelControls } from "../../../chrome/ComposerControls";
import type { AgentChoice } from "../../../lib/providers";
import { SendButton } from "./ComposerParts";
import { Fact, KeyHints, StarterCard } from "./SessionIntro";

const STARTERS = [
  { icon: LightbulbIcon, title: "Explain a concept", hint: "From first principles", text: "Explain a concept: " },
  { icon: MailIcon, title: "Draft an email", hint: "Who it's for and the goal", text: "Draft an email: " },
  { icon: TerminalIcon, title: "Write a shell one-liner", hint: "Describe it, get the command", text: "Write a shell one-liner: " },
  { icon: CalendarDaysIcon, title: "Plan my week", hint: "A list into days and priorities", text: "Plan my week: " },
];

export function HomeIntro({
  firstRun,
  draft,
  setDraft,
  field,
  choice,
  setChoice,
  send,
  onOpenFolder,
  onNewBot,
  onOpenBrowser,
}: {
  firstRun: boolean;
  draft: string;
  setDraft: (text: string) => void;
  field: RefObject<HTMLTextAreaElement | null>;
  choice: AgentChoice;
  setChoice: (next: AgentChoice) => void;
  send: () => void;
  onOpenFolder: () => void;
  onNewBot: () => void;
  onOpenBrowser: () => void;
}) {
  const pick = (text: string) => {
    setDraft(text);
    field.current?.focus();
  };
  const ways = [
    { icon: FolderPlusIcon, title: "Open a project folder", hint: "Code, worktrees and commands", onClick: onOpenFolder },
    { icon: BotIcon, title: firstRun ? "Meet your first bot" : "Make a bot", hint: "A named agent with its own history", onClick: onNewBot },
    { icon: GlobeIcon, title: "Drive a browser tab", hint: "Agents click, fill and screenshot", onClick: onOpenBrowser },
  ];
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex min-h-full w-full max-w-[840px] flex-col justify-center px-6 py-10">
        <div className="flex flex-col items-center gap-4 pb-5 text-center">
          <CrewGlyph className="size-14" />
          <div className="flex flex-col items-center gap-1">
            <h1 className="text-[22px] leading-7 font-semibold tracking-[-0.02em]">{firstRun ? "Welcome to Crew" : "What are we working on?"}</h1>
            <p className="max-w-lg text-[13px] leading-5 text-balance text-text-muted">
              {firstRun
                ? "Ask anything. Open a folder for code."
                : "Ask anything. Open a folder for code."}
            </p>
          </div>
          <div className="flex flex-wrap justify-center gap-1.5">
            <Fact icon={HouseIcon} title="Runs in your Home folder">
              Home
            </Fact>
            <Fact icon={MonitorIcon}>This Mac</Fact>
          </div>
        </div>

        <form
          className="ds-composer"
          data-roomy=""
          onSubmit={(event) => {
            event.preventDefault();
            send();
          }}
        >
          <div className="ds-composer-text">
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
          </div>
          <div className="flex h-8 items-center justify-between gap-2">
            <div className="ds-model-group">
              <ModelControls value={choice} onChange={setChoice} />
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <div className="ds-access" {...(choice.access === "full" ? { "data-risky": "" } : {})}>
                <AccessPicker provider={choice.provider} value={choice.access} onChange={(access) => setChoice({ ...choice, access })} />
              </div>
              <SendButton stopping={false} canSend={draft.trim().length > 0} label="Send" title="Send (↵)" stopTitle="" onStop={() => undefined} />
            </div>
          </div>
        </form>

        <div className="flex flex-col gap-6 pt-6">
          <div className="grid grid-cols-2 gap-2 px-1">
            {STARTERS.map((starter) => (
              <StarterCard key={starter.title} icon={starter.icon} title={starter.title} hint={starter.hint} onClick={() => pick(starter.text)} />
            ))}
          </div>
          <div className="flex flex-col gap-1 px-1">
            <span className="px-2.5 text-[12px] text-text-muted">{firstRun ? "Bring in your work" : "Or start with"}</span>
            <div className="grid grid-cols-3 gap-2">
              {ways.map((way) => (
                <StarterCard key={way.title} icon={way.icon} title={way.title} hint={way.hint} onClick={way.onClick} />
              ))}
            </div>
          </div>
          <KeyHints
            keys={[
              ["↵", "send"],
              ["⇧↵", "new line"],
              ["⌘N", "new session"],
              ["⌘O", "open a folder"],
            ]}
          />
        </div>
      </div>
    </div>
  );
}
