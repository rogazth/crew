import { useCallback, useEffect, useRef, useState, type ComponentType } from "react";
import { useThread } from "../hooks/useThread";
import { answer, respond, send, stop } from "../lib/agentRuntime";
import { pickFiles, writeTempFile } from "../lib/api";
import { attachedFrom } from "../lib/attachments";
import { mentionedFiles } from "../lib/mentions";
import { useChatActions } from "./chat/context";
import { useFileDrop } from "../hooks/useFileDrop";
import type { Answers, ApprovalDecision, AttachedFile } from "../lib/blocks";
import type { Session } from "../lib/types";
import { useAgentTheme } from "../hooks/useAgentTheme";
import { DefaultChatSurface } from "./chat/DefaultChatSurface";
import { TimelineChatSurface } from "./chat-timeline/TimelineChatSurface";
import type { AgentThemeId } from "../lib/agentTheme";
import type { ChatSurfaceProps } from "./chat/surface";

const SURFACES: Record<AgentThemeId, ComponentType<ChatSurfaceProps>> = {
  default: DefaultChatSurface,
  timeline: TimelineChatSurface,
};

type Props = {
  session: Session;
  cwd: string;
  active: boolean;
};

export function AgentChat({ session, cwd, active }: Props) {
  const { blocks, ready, working, more, loadingEarlier, loadEarlier, focusId } = useThread(session.id);
  const [draft, setDraft] = useState("");
  const [files, setFiles] = useState<AttachedFile[]>([]);
  const field = useRef<HTMLTextAreaElement>(null);
  const pane = useRef<HTMLDivElement>(null);
  const { files: projectFiles } = useChatActions();
  const { theme } = useAgentTheme();

  // Opening the tab means "talk to this agent"; the caret should already be there.
  useEffect(() => {
    if (active) field.current?.focus();
  }, [active]);

  const addPaths = useCallback((paths: string[]) => {
    if (paths.length === 0) return;
    setFiles((prev) => {
      const seen = new Set(prev.map((file) => file.path));
      const next: AttachedFile[] = [];
      for (const path of paths) {
        if (seen.has(path)) continue;
        seen.add(path);
        next.push(attachedFrom(path));
      }
      return [...prev, ...next];
    });
    field.current?.focus();
  }, []);

  const attach = useCallback(async () => addPaths(await pickFiles()), [addPaths]);

  // A pasted screenshot has no path; it gets one in the temp dir, like the terminal does.
  const pasteFiles = useCallback(
    (pasted: File[]) => {
      void Promise.all(pasted.map((file) => writeTempFile(file).catch(() => null))).then((paths) =>
        addPaths(paths.filter((path): path is string => path !== null)),
      );
    },
    [addPaths],
  );

  const over = useFileDrop(pane, addPaths);

  const submit = useCallback(() => {
    const text = draft.trim();
    if ((!text && files.length === 0) || working || !ready) return;
    const attached = files;
    const mentions = mentionedFiles(text, projectFiles).map((file) => file.path);
    setDraft("");
    setFiles([]);
    void send(session, cwd, text, attached, mentions.length > 0 ? { mentions } : {});
  }, [cwd, draft, files, projectFiles, ready, session, working]);

  const approve = useCallback(
    (requestId: number, decision: ApprovalDecision) => respond(session, requestId, decision),
    [session],
  );
  const reply = useCallback(
    (requestId: number, answers: Answers | null) => answer(session, requestId, answers),
    [session],
  );

  const Surface = SURFACES[theme];

  return (
    <div ref={pane} className="relative flex h-full flex-col bg-canvas">
      <Surface
        session={session}
        blocks={blocks}
        working={working}
        ready={ready}
        active={active}
        more={more}
        loadingEarlier={loadingEarlier}
        onLoadEarlier={loadEarlier}
        focusId={focusId}
        draft={draft}
        files={files}
        over={over}
        field={field}
        onDraft={setDraft}
        onSend={submit}
        onStop={() => void stop(session)}
        onAttach={() => void attach()}
        onPasteFiles={pasteFiles}
        onRemoveFile={(path) => setFiles((prev) => prev.filter((file) => file.path !== path))}
        onApprove={approve}
        onAnswer={reply}
      />
    </div>
  );
}
