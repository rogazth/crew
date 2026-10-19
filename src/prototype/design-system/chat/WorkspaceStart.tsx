// PROTOTYPE — throwaway. A workspace with no tab open is a new session's first
// screen: a mark and a line, the composer, then the other ways in. Sending is
// what creates the session, with the text as its first message.
import "./chat.css";
import { BotIcon, FileSearchIcon, GlobeIcon, MonitorIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { CrewGlyph } from "../../../chrome/CrewGlyph";
import { AccessPicker, ModelControls } from "../../../chrome/ComposerControls";
import { useUploads } from "../../../hooks/useUploads";
import { useWorkspaceLink } from "../../../hooks/useEnvLinks";
import { useDefaultAgent } from "../../../hooks/useDefaultAgent";
import type { AgentChoice } from "../../../lib/providers";
import { WorktreeFact, type Place } from "../sidebar/PaneWorktree";
import { pickFiles, writeTempFile } from "../../../lib/api";
import { attachedFrom } from "../../../lib/attachments";
import type { AttachedFile } from "../../../lib/blocks";
import { focusEnv } from "../../../lib/client/registry";
import { LOCAL } from "../../../lib/client/route";
import { extensionFor, pathSource, upload } from "../../../lib/upload";
import { AttachmentStrip } from "../../../surfaces/chat/Attachments";
import { AttachMenu, SendButton } from "./ComposerParts";
import { EmptyHead, Fact, IntroWaysFrame, StarterCard } from "./SessionIntro";

/** Puts the caret in the composer, so the sidebar's New session lands where typing starts. */
export function focusWorkspaceStart() {
  document.querySelector<HTMLElement>("[data-workspace-start] textarea")?.focus();
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
  onAsk,
}: {
  title: string;
  facts: ReactNode;
  ways: ReactNode;
  /** A new session with `text` as its first message, in what the chips say. */
  onAsk: (text: string, choice: AgentChoice, files: AttachedFile[]) => void;
}) {
  const { draft: choice, setDraft: setPicked } = useDefaultAgent();
  const [draft, setDraft] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);

  useEffect(() => field.current?.focus(), []);

  const [files, setFiles] = useState<AttachedFile[]>([]);
  const addPaths = useCallback((paths: string[]) => {
    setFiles((prev) => {
      const seen = new Set(prev.map((file) => file.path));
      return [...prev, ...paths.filter((item) => !seen.has(item) && seen.add(item)).map(attachedFrom)];
    });
    field.current?.focus();
  }, []);
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
  // What the plus menu types for you: the mark at the caret.
  const typeMark = (mark: string) => {
    const before = draft.slice(0, field.current?.selectionStart ?? draft.length);
    const gap = before.length > 0 && !/\s$/.test(before) ? " " : "";
    setDraft(`${before}${gap}${mark}${draft.slice(before.length)}`);
    window.setTimeout(() => field.current?.focus(), 40);
  };

  const send = () => {
    const text = draft.trim();
    if ((!text && files.length === 0) || uploading) return;
    setDraft("");
    setFiles([]);
    onAsk(text, choice, files);
  };

  // The same three bands as a session's first screen (head, composer, ways in), so the two line up.
  return (
    <div data-workspace-start data-ds-chat="" className="flex h-full min-h-0 flex-col">
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
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  send();
                }
              }}
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
                <ModelControls value={choice} onChange={setPicked} />
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <div className="ds-access">
                <AccessPicker provider={choice.provider} value={choice.access} onChange={(access) => setPicked({ ...choice, access })} />
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
  const machine = useWorkspaceLink(workspaceId)?.name ?? "This Mac";
  const [path, setPath] = useState(defaultPath);
  // Picking another worktree in the sidebar moves the start with it.
  useEffect(() => setPath(defaultPath), [defaultPath]);
  const place = places.find((item) => item.path === path) ?? places.find((item) => item.path === defaultPath);
  return (
    <StartScreen
      title="What are we working on?"
      facts={
        <>
          {place && <WorktreeFact place={place} places={places} onMove={setPath} />}
          <Fact icon={MonitorIcon}>{machine}</Fact>
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

