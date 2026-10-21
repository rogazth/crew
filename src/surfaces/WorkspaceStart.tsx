// A workspace with no tab open is a new session's first
// screen: a mark and a line, the composer, then the other ways in. Sending is
// what creates the session, with the text as its first message.
import { BotIcon, FileSearchIcon, GlobeIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { CrewGlyph } from "../chrome/CrewGlyph";
import { AccessPicker, ModelControls } from "../chrome/ComposerControls";
import { machineIcon } from "../chrome/EnvBits";
import type { Opener } from "../chrome/ModelPicker";
import { useUploads } from "../hooks/useUploads";
import { useWorkspaceLink } from "../hooks/useEnvLinks";
import { useDefaultAgent } from "../hooks/useDefaultAgent";
import { useProjectFiles } from "../hooks/useProjectFiles";
import { effortsOf, fastChoice, fitChoice, selectedEffort, toggledFast, type AgentChoice } from "../lib/providers";
import { completeMention, rememberMention } from "../lib/mentions";
import type { CommandEntry } from "../lib/protocol";
import { nextEffort } from "../lib/sessionOptions";
import { removeSlash, searchCommands, slashAt } from "../lib/slashCommands";
import type { ProjectFile } from "../lib/types";
import { WorktreeFact, type Place } from "./chat/panePlace";
import { pickFiles, writeTempFile } from "../lib/api";
import { attachedFrom } from "../lib/attachments";
import type { AttachedFile } from "../lib/blocks";
import { focusEnv } from "../lib/client/registry";
import { LOCAL } from "../lib/client/route";
import { extensionFor, pathSource, upload } from "../lib/upload";
import { AttachmentStrip } from "./chat/Attachments";
import { AttachMenu, SendButton } from "./chat/ComposerParts";
import { MentionPicker } from "./chat/MentionPicker";
import { SlashPicker } from "./chat/SlashPicker";
import { useMentionMenu } from "./chat/useMentionMenu";
import { EmptyHead, Fact, IntroWaysFrame, StarterCard } from "./chat/SessionIntro";

/** Puts the caret in the composer, so the sidebar's New session lands where typing starts. */
export function focusWorkspaceStart() {
  document.querySelector<HTMLElement>("[data-workspace-start] textarea")?.focus();
}

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
  onAsk,
}: {
  title: string;
  facts: ReactNode;
  ways: ReactNode;
  /** The folder a new session will run in: what `@` reads files from. */
  cwd: string | null;
  /** Whether `@` searches an index of the folder, which only a project is worth; folders are always listed. */
  indexFiles?: boolean;
  /** A pick on the chips becomes the preferred agent, as Home's does; elsewhere it is for the next session only. */
  rememberPick?: boolean;
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
  const field = useRef<HTMLTextAreaElement>(null);
  const model = useRef<Opener>(null);
  const effort = useRef<Opener>(null);
  const access = useRef<Opener>(null);

  // The same menus as a session's composer: `@` reads the folder, `/` offers what exists before a session does.
  const [cursor, setCursor] = useState(0);
  const [active, setActive] = useState(0);
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
  const { mention, results } = useMentionMenu(draft, cursor, projectFiles, resolvePath);
  const fitted = fitChoice(choice);
  const canFast = fastChoice(fitted.provider, fitted.model).available;
  const hasEfforts = effortsOf(fitted.provider, fitted.model).length > 0;
  const actions = useMemo(() => startActions(canFast, hasEfforts), [canFast, hasEfforts]);
  const slash = mention ? null : slashAt(draft, cursor);
  const slashResults = useMemo(
    () => (slash ? searchCommands(actions, slash.query, true) : []),
    [slash?.query, actions], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const choices = mention ? results.length : slashResults.length;
  const syncCursor = () => {
    const el = field.current;
    if (el) setCursor(el.selectionStart);
  };
  // The draft has just changed: the caret goes where the change left it once the field has the new text.
  const place = (at: number, then?: () => void) => {
    requestAnimationFrame(() => {
      const el = field.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(at, at);
      setCursor(at);
      then?.();
    });
  };
  const pickMention = (file: ProjectFile, into = false) => {
    const el = field.current;
    if (!el) return;
    const next = completeMention(draft, el.selectionStart, file, { into });
    if (!next) return;
    rememberMention(file.path);
    setDraft(next.text);
    setActive(0);
    place(next.cursor);
  };
  const pickSlash = (entry: CommandEntry) => {
    const el = field.current;
    if (!el) return;
    const next = removeSlash(draft, el.selectionStart);
    if (!next) return;
    setDraft(next.text);
    setActive(0);
    place(next.cursor, () => {
      if (entry.name === "model") model.current?.open();
      else if (entry.name === "effort") effort.current?.open();
      else if (entry.name === "access") access.current?.open();
      else if (entry.name === "fast") {
        const toggled = toggledFast(choice);
        if (toggled) setPicked(toggled);
      }
    });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (choices > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActive((index) => (index + step + choices) % choices);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const at = Math.min(active, choices - 1);
        if (mention) pickMention(results[at]!, event.key === "Tab");
        else pickSlash(slashResults[at]!);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setCursor(-1);
        return;
      }
    }
    // ⇧Tab steps the effort levels, as in a session's composer.
    if (event.key === "Tab" && event.shiftKey) {
      event.preventDefault();
      const next = nextEffort(selectedEffort(fitted.provider, fitted.model, fitted.effort), effortsOf(fitted.provider, fitted.model));
      if (next) setPicked(fitChoice({ ...fitted, effort: next }));
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  };

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
  // What the plus menu types for you: the mark at the caret, and its menu opens.
  const typeMark = (mark: string) => {
    const at = mark === "/" && draft.trim() === "" ? 0 : (field.current?.selectionStart ?? draft.length);
    const before = mark === "/" && at === 0 ? "" : draft.slice(0, at);
    const gap = before.length > 0 && !/\s$/.test(before) ? " " : "";
    setDraft(`${before}${gap}${mark}${draft.slice(at)}`);
    setActive(0);
    // The menu hands the focus back to its trigger as it closes: the caret goes in after that.
    window.setTimeout(() => place(before.length + gap.length + 1), 40);
  };

  const send = () => {
    const text = draft.trim();
    if ((!text && files.length === 0) || uploading) return;
    setDraft("");
    setFiles([]);
    // A pick made here was for this session: the next first screen opens on the preferred agent again.
    if (!rememberPick) setPickedDraft(null);
    onAsk(text, choice, files);
  };

  // The same three bands as a session's first screen (head, composer, ways in), so the two line up.
  return (
    <div data-workspace-start className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 flex-[4] flex-col items-center justify-end overflow-hidden">
        <EmptyHead mark={<CrewGlyph className="size-14" />} title={title} facts={facts} />
      </div>
      <div className="ds-composer-wrap relative mx-auto w-full max-w-[840px] shrink-0 px-6 py-1">
        <form
          className="ds-composer"
          data-roomy=""
          onSubmit={(event) => {
            event.preventDefault();
            send();
          }}
        >
          {mention && (
            <MentionPicker results={results} active={Math.min(active, Math.max(0, results.length - 1))} onHover={setActive} onPick={pickMention} />
          )}
          {slashResults.length > 0 && (
            <SlashPicker results={slashResults} active={Math.min(active, slashResults.length - 1)} onHover={setActive} onPick={pickSlash} />
          )}
          {(files.length > 0 || uploads.length > 0) && (
            <div className="px-1.5">
              <AttachmentStrip files={files} onRemove={(item) => setFiles((prev) => prev.filter((file) => file.path !== item))} uploads={uploads} onDismissUpload={dismissUpload} />
            </div>
          )}
          <div className="ds-composer-text">
            <textarea
              ref={field}
              rows={2}
              value={draft}
              aria-label="Ask anything"
              placeholder="Ask anything…"
              onChange={(event) => {
                setDraft(event.target.value);
                setCursor(event.target.selectionStart);
                setActive(0);
              }}
              onSelect={syncCursor}
              onKeyUp={syncCursor}
              onClick={syncCursor}
              onBlur={() => setCursor(-1)}
              onKeyDown={onKeyDown}
              onPaste={(event) => {
                const list = [...event.clipboardData.files];
                if (list.length === 0) return;
                event.preventDefault();
                pasted(list);
              }}
              className="crew-composer-field resize-none text-text placeholder:text-placeholder"
            />
          </div>
          <div className="flex h-8 items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1.5">
              <AttachMenu onAttach={() => void attach()} onMention={() => typeMark("@")} onCommand={() => typeMark("/")} />
              <div className="ds-model-group">
                <ModelControls value={choice} onChange={setPicked} openers={{ model, effort }} />
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <div className="ds-access">
                <AccessPicker ref={access} provider={choice.provider} value={choice.access} onChange={(access) => setPicked({ ...choice, access })} />
              </div>
              <SendButton stopping={false} canSend={(draft.trim().length > 0 || files.length > 0) && !uploading} label="Send" title="Send (↵)" stopTitle="" onStop={() => undefined} />
            </div>
          </div>
        </form>
        <div className="ds-status" />
      </div>
      <div className="min-h-0 flex-[6] overflow-y-auto">
        <IntroWaysFrame>{ways}</IntroWaysFrame>
      </div>
    </div>
  );
}

export function WorkspaceStart({
  workspaceId,
  places,
  defaultPath,
  onAsk,
  onNewBot,
  onOpenFile,
  onOpenBrowser,
}: {
  workspaceId: string;
  /** The worktrees a session can start in, and the one on screen in the sidebar. */
  places: Place[];
  defaultPath: string;
  /** A new session in the worktree at `path`, with `text` as its first message, in what the chips say. */
  onAsk: (text: string, choice: AgentChoice, path: string, files: AttachedFile[]) => void;
  onNewBot: () => void;
  onOpenFile: () => void;
  onOpenBrowser: () => void;
}) {
  const link = useWorkspaceLink(workspaceId);
  const machine = link?.name ?? "This Mac";
  const [path, setPath] = useState(defaultPath);
  // Picking another worktree in the sidebar moves the start with it.
  useEffect(() => setPath(defaultPath), [defaultPath]);
  const place = places.find((item) => item.path === path) ?? places.find((item) => item.path === defaultPath);
  return (
    <StartScreen
      title="What are we working on?"
      cwd={place?.path ?? path}
      facts={
        <>
          {place && <WorktreeFact place={place} places={places} onMove={setPath} />}
          <Fact icon={machineIcon(link !== null)}>{machine}</Fact>
        </>
      }
      ways={
        <>
          <StarterCard icon={BotIcon} title="New bot" hint="A named agent with its own history" onClick={onNewBot} />
          <StarterCard icon={FileSearchIcon} title="Open a file" hint="Jump to any file in the project" onClick={onOpenFile} />
          <StarterCard icon={GlobeIcon} title="Open a browser tab" hint="Let agents browse, fill forms and capture pages" onClick={onOpenBrowser} />
        </>
      }
      onAsk={(text, choice, files) => onAsk(text, choice, place?.path ?? path, files)}
    />
  );
}

