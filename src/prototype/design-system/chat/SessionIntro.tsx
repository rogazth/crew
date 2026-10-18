// PROTOTYPE — throwaway. A new session's first screen and Home, as one
// family: who it is and where it runs above the composer, ways in below it.
import "./chat.css";
import {
  BookOpenIcon,
  FlaskConicalIcon,
  FolderGit2Icon,
  FolderIcon,
  GitCommitHorizontalIcon,
  GitPullRequestIcon,
  ListTodoIcon,
  LockIcon,
  LockOpenIcon,
  MonitorIcon,
  PencilIcon,
  PlugIcon,
  SparklesIcon,
  type LucideIcon as Icon,
} from "lucide-react";
import type { ReactNode } from "react";
import { BotAvatar } from "../../../chrome/BotAvatar";
import { ProviderIcon } from "../../../chrome/ProviderIcon";
import { sortedServers, useMcp } from "../../../lib/mcp";
import { ACCESSES, EFFORT_LABELS, providerLine, type Access, type Effort } from "../../../lib/providers";
import type { Session } from "../../../lib/types";
import { branchOf, useWhere, type Where } from "./where";

const ACCESS_ICONS: Record<Access, Icon> = { ask: LockIcon, edits: PencilIcon, auto: SparklesIcon, full: LockOpenIcon };

/** PROTOTYPE mock: what a fresh session's CLI would load, before it has started and reported its own. */
const MOCK_MCP = ["github", "linear", "playwright"];

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

/** Who it is, what runs it, where and with what it may act. */
export function IntroHead({ session }: { session: Session }) {
  const where = useWhere(session);
  const mcp = useMcp(session.id);
  const servers = sortedServers(mcp);
  const reported = mcp?.reported && servers.length > 0;
  const mcpCount = reported ? servers.length : MOCK_MCP.length;
  const access = ACCESSES.find((item) => item.id === session.autonomy);
  const effort = session.effort ? EFFORT_LABELS[session.effort as Effort] : undefined;
  const branch = branchOf(where);
  const place = [where.workspace, branch ?? (where.workspace ? undefined : where.folder)].filter(Boolean).join(" · ");
  return (
    <div className="mx-auto flex w-full max-w-[840px] flex-col items-center gap-4 px-6 pb-5 text-center">
      {session.kind === "bot" ? (
        <BotAvatar seed={session.id} bare animated={session.status === "working"} className="size-14" />
      ) : (
        <span className="grid size-14 place-items-center rounded-[18px] bg-surface shadow-float">
          <ProviderIcon provider={session.provider} className="size-7" />
        </span>
      )}
      <div className="flex flex-col items-center gap-1">
        <h2 className="text-[22px] leading-7 font-semibold tracking-[-0.02em]">{session.name || "New session"}</h2>
        <p className="flex items-center gap-1.5 text-[13px] text-text-muted">
          <ProviderIcon provider={session.provider} className="size-3.5" />
          {providerLine(session.provider, session.model)}
          {effort && <span className="text-placeholder">· {effort} effort</span>}
        </p>
        {session.description && <p className="mt-1 max-w-md text-[13px] leading-5 text-text-muted">{session.description}</p>}
      </div>
      <div className="flex max-w-[640px] flex-wrap justify-center gap-1.5">
        {place && (
          <Fact icon={branch ? FolderGit2Icon : FolderIcon} title={where.tree?.path ?? where.folder}>
            {place}
          </Fact>
        )}
        <Fact icon={MonitorIcon}>{where.machine}</Fact>
        {access && (
          <Fact icon={ACCESS_ICONS[access.id]} title={access.description} {...(access.id === "full" ? { tone: "warning" as const } : {})}>
            {access.label}
          </Fact>
        )}
        <Fact
          icon={PlugIcon}
          title={reported ? servers.map((server) => server.name).join(", ") : `Mocked: ${MOCK_MCP.join(", ")}`}
        >
          {mcpCount} MCP {mcpCount === 1 ? "server" : "servers"}
        </Fact>
      </div>
    </div>
  );
}

type Starter = { icon: Icon; title: string; hint: string; text: string };

function startersFor(where: Where): Starter[] {
  const branch = branchOf(where);
  const onBranch = branch && !where.tree?.main;
  return [
    onBranch
      ? {
          icon: GitPullRequestIcon,
          title: `Review the diff on ${branch}`,
          hint: "Changes against main, and risks",
          text: `Review the diff on ${branch} against main. Flag bugs, risky changes and anything untested.`,
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
    {
      icon: ListTodoIcon,
      title: "Find work worth doing",
      hint: "TODOs, FIXMEs and rough edges, ranked",
      text: "Find the TODOs, FIXMEs and rough edges in this repo and rank the ones worth doing first.",
    },
  ];
}

/** Ways in under the composer: starters and the keys. */
export function IntroWays({ session, onPick }: { session: Session; onPick: (text: string) => void }) {
  const where = useWhere(session);
  return (
    <div className="mx-auto flex w-full max-w-[840px] flex-col gap-6 px-6 pt-2 pb-8">
      <div className="grid grid-cols-2 gap-2 px-1">
        {startersFor(where).map((starter) => (
          <StarterCard key={starter.title} icon={starter.icon} title={starter.title} hint={starter.hint} onClick={() => onPick(starter.text)} />
        ))}
      </div>
      <KeyHints
        keys={[
          ["↵", "send"],
          ["⇧↵", "new line"],
          ["@", "mention a file"],
          ["/", "run a command"],
          ["⇧⇥", "change access"],
        ]}
      />
    </div>
  );
}
