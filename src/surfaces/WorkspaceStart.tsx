// A workspace with no tab open is a new session's first
// screen: a mark and a line, the composer, then the other ways in. Sending is
// what creates the session, with the text as its first message.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CrewGlyph } from "../chrome/CrewGlyph";
import { machineIcon } from "../chrome/EnvBits";
import { useUploads } from "../hooks/useUploads";
import { useWorkspaceLink } from "../hooks/useEnvLinks";
import { useDefaultAgent } from "../hooks/useDefaultAgent";
import { useProjectFiles } from "../hooks/useProjectFiles";
import { agentNote, mentionedAgents, mentionedTrees, treeMentions } from "../lib/agentMentions";
import { effortsOf, fastChoice, fitChoice, type AgentChoice } from "../lib/providers";
import type { CommandEntry } from "../lib/protocol";
import type { Session } from "../lib/types";
import { WorktreeFact, type Place } from "./chat/panePlace";
import { pickFiles, writeTempFile } from "../lib/api";
import { attachedFrom } from "../lib/attachments";
import type { AttachedFile } from "../lib/blocks";
import { focusEnv } from "../lib/client/registry";
import { LOCAL } from "../lib/client/route";
import { extensionFor, pathSource, upload } from "../lib/upload";
import { SendButton } from "./chat/ComposerParts";
import type { PromptHandle } from "./chat/PromptEditor";
import { PromptWell } from "./chat/PromptWell";
import { EmptyHead, Fact, IntroWaysFrame, Starters } from "./chat/SessionIntro";
import { useRepoTrees, useWhereAt } from "./chat/where";

/** Puts the caret in the composer, so the sidebar's New session lands where typing starts. */
export function focusWorkspaceStart() {
  document.querySelector<HTMLElement>("[data-workspace-start] .cm-content")?.focus();
}

const NO_AGENTS: readonly Session[] = [];

/** What a `/` offers before any session exists: Crew's own actions on the chips. A provider's commands need its CLI running. */
function startActions(fast: boolean, efforts: boolean): CommandEntry[] {
  const action = (name: string, description: string): CommandEntry => ({ name, description, kind: "crew" }) as CommandEntry;
  return [
    action("model", "Change the model"),
    ...(efforts ? [action("effort", "Change how hard it thinks")] : []),
    action("access", "Change what it may do without asking"),
    ...(fast ? [action("fast", "Turn fast mode on or off")] : []),
  ];
}

/** A function of ways is rendered here, so the composer's refs stay out of the screen's own render. */
function Ways({ render, onDraft }: { render: (draftText: (text: string) => void) => ReactNode; onDraft: (text: string) => void }) {
  return render(onDraft);
}

/**
 * The first screen of anything with no tab open, Home and a workspace alike:
 * a title and badges, the composer, then three ways in. Each caller brings
 * its own badges and ways; sending is what creates the session.
 */
export function StartScreen({
  title,
  facts,
  ways,
  cwd,
  indexFiles = true,
  rememberPick = false,
  agents = NO_AGENTS,
  onAsk,
}: {
  title: string;
  facts: ReactNode;
  /** The ways in under the composer; given a way to draft text into it, for starters. */
  ways: ReactNode | ((draftText: (text: string) => void) => ReactNode);
  /** The folder a new session will run in: what `@` reads files from. */
  cwd: string | null;
  /** Whether `@` searches an index of the folder, which only a project is worth; folders are always listed. */
  indexFiles?: boolean;
  /** A pick on the chips becomes the preferred agent, as Home's does; elsewhere it is for the next session only. */
  rememberPick?: boolean;
  /** The workspace's bots and sessions, which `@` names alongside its worktrees. */
  agents?: readonly Session[];
  /** A new session with `text` as its first message, in what the chips say. */
  onAsk: (text: string, choice: AgentChoice, files: AttachedFile[]) => void;
}) {
  const { draft: choice, setDraft: setPickedDraft, update } = useDefaultAgent();
  const setPicked = useCallback(
    (next: AgentChoice) => {
      if (!rememberPick) return setPickedDraft(next);
      update(next);
      setPickedDraft(null);
    },
    [rememberPick, setPickedDraft, update],
  );
  const [draft, setDraft] = useState("");
  const field = useRef<PromptHandle>(null);
  // The same menus as a session's composer: `@` reads the folder and names the workspace's others, `/` offers what exists before a session does.
  const projectFiles = useProjectFiles(indexFiles ? cwd : null);
  const resolvePath = useCallback(
    (path: string) => {
      if (!cwd) return null;
      if (path.startsWith("/")) return path;
      const rest = path.replace(/^\.\//, "").replace(/\/+$/, "");
      return rest && rest !== "." ? `${cwd.replace(/\/+$/, "")}/${rest}` : cwd;
    },
    [cwd],
  );
  // Home is no repo: only a project has worktrees to name.
  const trees = useRepoTrees(indexFiles ? (cwd ?? "") : "");
  const worktrees = useMemo(() => treeMentions(trees), [trees]);
  const fitted = fitChoice(choice);
  const canFast = fastChoice(fitted.provider, fitted.model).available;
  const hasEfforts = effortsOf(fitted.provider, fitted.model).length > 0;
  const actions = useMemo(() => startActions(canFast, hasEfforts), [canFast, hasEfforts]);

  useEffect(() => field.current?.focus(), []);

  const [files, setFiles] = useState<AttachedFile[]>([]);
  const addPaths = (paths: string[]) => {
    setFiles((prev) => {
      const seen = new Set(prev.map((file) => file.path));
      return [...prev, ...paths.filter((item) => !seen.has(item) && seen.add(item)).map(attachedFrom)];
    });
    field.current?.focus();
  };
  const { uploads, start: startUploads, dismiss: dismissUpload, busy: uploading } = useUploads(addPaths);

  // A file the machine in front cannot read from this Mac's disk goes to its temp dir first.
  const attach = async () => {
    const paths = await pickFiles();
    const env = focusEnv();
    if (env === LOCAL) return addPaths(paths);
    for (const item of paths) {
      const source = await pathSource(item).catch(() => null);
      if (!source) continue;
      startUploads([{ name: source.name, size: source.size, run: (onProgress) => upload(source, env, extensionFor(source.name), onProgress) }]);
    }
  };
  const pasted = (list: File[]) => {
    const env = focusEnv();
    startUploads(list.map((file) => ({ name: file.name || "pasted file", size: file.size, run: (onProgress) => writeTempFile(file, env, onProgress) })));
  };
  // A starter drafts its text for the sender to read and send; nothing is sent.
  const draftText = (text: string) => {
    setDraft(text);
    field.current?.focus();
  };

  const canSend = (draft.trim().length > 0 || files.length > 0) && !uploading;
  const send = () => {
    const text = draft.trim();
    if (!canSend) return;
    setDraft("");
    setFiles([]);
    // A pick made here was for this session: the next first screen opens on the preferred agent again.
    if (!rememberPick) setPickedDraft(null);
    // The agents and worktrees it names go under it with their ids and paths, as a session's composer sends them.
    onAsk(text + agentNote(mentionedAgents(text, agents), mentionedTrees(text, worktrees, agents)), choice, files);
  };

  // The same three bands as a session's first screen (head, composer, ways in), so the two line up.
  return (
    <div data-workspace-start className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 flex-[4] flex-col items-center justify-end overflow-hidden">
        <EmptyHead mark={<CrewGlyph className="size-14" />} title={title} facts={facts} />
      </div>
      <div className="ds-composer-wrap relative mx-auto w-full max-w-chat shrink-0 px-6 py-1">
        <PromptWell
          ref={field}
          draft={draft}
          onDraft={setDraft}
          files={files}
          uploads={uploads}
          onRemoveFile={(item) => setFiles((prev) => prev.filter((file) => file.path !== item))}
          onDismissUpload={dismissUpload}
          onAttach={() => void attach()}
          onPasteFiles={pasted}
          projectFiles={projectFiles}
          resolvePath={resolvePath}
          agents={agents}
          worktrees={worktrees}
          commands={actions}
          choice={choice}
          onChoice={setPicked}
          placeholder="Ask anything…"
          label="Ask anything"
          roomy
          canSend={canSend}
          onSend={send}
          trailing={<SendButton stopping={false} canSend={canSend} label="Send" title="Send (↵)" stopTitle="" onStop={() => undefined} />}
        />
        <div className="ds-status" />
      </div>
      <div className="min-h-0 flex-[6] overflow-y-auto">
        <IntroWaysFrame>{typeof ways === "function" ? <Ways render={ways} onDraft={draftText} /> : ways}</IntroWaysFrame>
      </div>
    </div>
  );
}

export function WorkspaceStart({
  workspaceId,
  places,
  defaultPath,
  onPlace,
  agents,
  onAsk,
}: {
  workspaceId: string;
  /** The worktrees a session can start in, and the one on screen in the sidebar. */
  places: Place[];
  defaultPath: string;
  /** A worktree picked on the badge, remembered: the next first screen opens on it too. */
  onPlace: (path: string) => void;
  /** The workspace's bots and sessions, for `@`. */
  agents: readonly Session[];
  /** A new session in the worktree at `path`, with `text` as its first message, in what the chips say. */
  onAsk: (text: string, choice: AgentChoice, path: string, files: AttachedFile[]) => void;
}) {
  const link = useWorkspaceLink(workspaceId);
  const machine = link?.name ?? "This Mac";
  // The sidebar's pick, or the badge's: either one moves the start.
  const where = useWhereAt(defaultPath, workspaceId);
  const place = places.find((item) => item.path === defaultPath);
  return (
    <StartScreen
      title="What are we working on?"
      cwd={defaultPath}
      facts={
        <>
          {place && <WorktreeFact place={place} places={places} onMove={onPlace} />}
          <Fact icon={machineIcon(link !== null)}>{machine}</Fact>
        </>
      }
      agents={agents}
      ways={(pick) => <Starters where={where} onPick={pick} />}
      onAsk={(text, choice, files) => onAsk(text, choice, defaultPath, files)}
    />
  );
}

