// A new session's first screen and Home, as one
// family: who it is above the composer, ways in below it.
import {
  BookOpenIcon,
  CpuIcon,
  FlaskConicalIcon,
  GitBranchIcon,
  GitCommitHorizontalIcon,
  GitPullRequestIcon,
  type LucideIcon as Icon,
} from "lucide-react";
import type { ReactNode } from "react";
import { BotAvatar } from "../../chrome/BotAvatar";
import { CrewGlyph } from "../../chrome/CrewGlyph";
import { machineIcon } from "../../chrome/EnvBits";
import { defaultModelOf, modelLabel } from "../../lib/providers";
import type { Session } from "../../lib/types";
import { usePanePlace, WorktreeFact } from "./panePlace";
import { branchOf, useWhere, type Where } from "./where";

/** A fact about where or how something runs: a filled pill, never an outline. */
export function Fact({ icon: Glyph, children, title, tone }: { icon: Icon; children: ReactNode; title?: string | undefined; tone?: "warning" }) {
  return (
    <span className="ds-fact" title={title} {...(tone ? { "data-tone": tone } : {})}>
      <Glyph />
      <span>{children}</span>
    </span>
  );
}

/** A way in: a glyph, what it does, and one line on how. A click drafts it; nothing is sent. */
export function StarterCard({ icon: Glyph, title, hint, onClick }: { icon: Icon; title: string; hint: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="ds-starter">
      <Glyph />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate text-[13px] font-medium text-text">{title}</span>
        <span className="text-[12px] leading-4 text-text-muted">{hint}</span>
      </span>
    </button>
  );
}

/** The keys a first message needs, under the ways in. */
export function KeyHints({ keys }: { keys: [string, string][] }) {
  return (
    <div className="ds-keys">
      {keys.map(([key, label]) => (
        <span key={label}>
          <kbd>{key}</kbd>
          {label}
        </span>
      ))}
    </div>
  );
}

/**
 * The first screen's head, one skeleton for Home and every session: a mark, a
 * title, a line, and the facts about where it runs. The model is a quiet fact
 * among them; the composer's chip, right under it, is how to change it.
 */
export function EmptyHead({
  mark,
  title,
  line,
  facts,
}: {
  mark: ReactNode;
  title: string;
  line?: string | undefined;
  facts?: ReactNode;
}) {
  return (
    <div className="mx-auto flex w-full max-w-[840px] flex-col items-center gap-4 px-6 pb-5 text-center">
      {mark}
      <div className="flex flex-col items-center gap-1">
        <h1 className="text-[22px] leading-7 font-semibold tracking-[-0.02em]">{title}</h1>
        {line && <p className="max-w-lg text-[13px] leading-5 text-balance text-text-muted">{line}</p>}
      </div>
      {facts && <div className="flex flex-wrap justify-center gap-1.5">{facts}</div>}
    </div>
  );
}

/** A session's head: a bot is its face and name, any other session is the app's own question about its folder. */
export function IntroHead({ session }: { session: Session }) {
  const where = useWhere(session);
  const pane = usePanePlace(session.id);
  const model = modelLabel(session.provider, session.model || defaultModelOf(session.provider));
  // The model is a quiet fact here; the composer's chip is how to change it.
  const modelFact = model ? <Fact icon={CpuIcon}>{model}</Fact> : null;
  if (session.kind === "bot") {
    return (
      <EmptyHead
        mark={<BotAvatar seed={session.id} bare animated={session.status === "working"} className="size-14" />}
        title={session.name || "New session"}
        line={session.description}
        facts={modelFact}
      />
    );
  }
  const branch = branchOf(where);
  return (
    <EmptyHead
      mark={<CrewGlyph className="size-14" />}
      title="What are we working on?"
      facts={
        <>
          {/* A session nobody has written to can still start in another worktree: its badge is the way to. */}
          {pane ? (
            <WorktreeFact place={pane.place} places={pane.places} onMove={pane.onMove} />
          ) : (
            branch && <Fact icon={GitBranchIcon}>{branch}</Fact>
          )}
          <Fact icon={machineIcon(where.remote)}>{where.machine}</Fact>
          {modelFact}
        </>
      }
    />
  );
}

type Starter = { icon: Icon; title: string; hint: string; text: string };

/** Code starters need a git checkout to talk about: not a bot, not Home, not a folder outside git, and not before git has answered. */
function startersFor(session: Pick<Session, "kind">, where: Where): Starter[] {
  if (session.kind === "bot" || where.home || !where.tree) return [];
  const branch = branchOf(where);
  const base = where.base ?? "the default branch";
  const onBranch = branch && !where.tree.main;
  return [
    onBranch
      ? {
          icon: GitPullRequestIcon,
          title: `Review the diff on ${branch}`,
          hint: where.base ? `Changes against ${where.base}, and risks` : "Changes against the default branch, and risks",
          text: `Review the diff on ${branch} against ${base}. Flag bugs, risky changes and anything untested.`,
        }
      : {
          icon: GitCommitHorizontalIcon,
          title: "Review the last commit",
          hint: "Bugs and loose ends",
          text: "Review the last commit for bugs, risky changes and anything left untested.",
        },
    {
      icon: FlaskConicalIcon,
      title: "Run the tests and fix failures",
      hint: "Run them, fix what fails",
      text: "Find how this project runs its tests, run them, and fix whatever fails. Tell me what you changed.",
    },
    {
      icon: BookOpenIcon,
      title: "Explain this codebase",
      hint: "Layout and where to start",
      text: "Explain this codebase: what it does, how it's laid out, and where I should start reading.",
    },
  ];
}

/** The keys both first screens teach. */
const INTRO_KEYS: [string, string][] = [
  ["↵", "send"],
  ["⇧↵", "new line"],
  ["@", "mention a file"],
  ["/", "run a command"],
  ["⇧Tab", "step the effort"],
];

/** Under the composer, on every first screen: three ways in, then the keys. Only the ways differ. */
export function IntroWaysFrame({ children }: { children?: ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-[840px] flex-col gap-6 px-6 pt-2 pb-8">
      {children && <div className="grid grid-cols-3 gap-2 px-1">{children}</div>}
      <KeyHints keys={INTRO_KEYS} />
    </div>
  );
}

/** Ways in under the composer: starters and the keys. */
export function IntroWays({ session, onPick }: { session: Session; onPick: (text: string) => void }) {
  const where = useWhere(session);
  return (
    <IntroWaysFrame>
      {startersFor(session, where).map((starter) => (
        <StarterCard key={starter.title} icon={starter.icon} title={starter.title} hint={starter.hint} onClick={() => onPick(starter.text)} />
      ))}
    </IntroWaysFrame>
  );
}
