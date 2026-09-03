import { useCallback, useState } from "react";
import { ProviderIcon } from "../chrome/ProviderIcon";
import { useThread } from "../hooks/useThread";
import { respond, send, stop } from "../lib/agentRuntime";
import { pickFiles } from "../lib/api";
import type { ApprovalDecision, AttachedFile } from "../lib/blocks";
import { providerLine, type ProviderId } from "../lib/providers";
import type { Session } from "../lib/types";
import { Composer } from "./chat/Composer";
import { Transcript } from "./chat/Transcript";

type Props = {
  session: Session;
  cwd: string;
  onModel: (session: Session, provider: ProviderId, model: string) => void;
};

export function AgentChat({ session, cwd, onModel }: Props) {
  const { blocks, ready, working } = useThread(session.id);
  const [draft, setDraft] = useState("");
  const [files, setFiles] = useState<AttachedFile[]>([]);

  const attach = useCallback(async () => {
    const picked = await pickFiles();
    if (picked.length === 0) return;
    setFiles((prev) => {
      const seen = new Set(prev.map((file) => file.path));
      const next: AttachedFile[] = [];
      for (const path of picked) {
        if (seen.has(path)) continue;
        next.push({ path, name: path.split("/").pop() ?? path });
      }
      return [...prev, ...next];
    });
  }, []);

  const submit = useCallback(() => {
    const text = draft.trim();
    if ((!text && files.length === 0) || working || !ready) return;
    const attached = files;
    setDraft("");
    setFiles([]);
    void send(session, cwd, text, attached);
  }, [cwd, draft, files, ready, session, working]);

  const approve = useCallback(
    (requestId: number, decision: ApprovalDecision) => respond(session, requestId, decision),
    [session],
  );

  return (
    <div className="flex h-full flex-col bg-canvas">
      {blocks.length === 0 ? (
        <Identity session={session} />
      ) : (
        <Transcript blocks={blocks} working={working} onApprove={approve} />
      )}
      <Composer
        session={session}
        draft={draft}
        files={files}
        working={working}
        ready={ready}
        onDraft={setDraft}
        onModel={(provider, model) => onModel(session, provider, model)}
        onAttach={() => void attach()}
        onRemoveFile={(path) => setFiles((prev) => prev.filter((file) => file.path !== path))}
        onSend={submit}
        onStop={() => void stop(session)}
      />
    </div>
  );
}

function Identity({ session }: { session: Session }) {
  return (
    <div data-selectable className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex h-full max-w-3xl flex-col items-center justify-center gap-3 px-6 text-center">
        <div className="flex size-14 items-center justify-center rounded-2xl border border-border bg-sidebar">
          <ProviderIcon provider={session.provider} className="size-6" />
        </div>
        <div>
          <p className="font-medium">{session.name}</p>
          <p className="mt-0.5 text-text-muted">
            {providerLine(session.provider, session.model)}
          </p>
        </div>
        {session.description && (
          <p className="max-w-md text-text-muted">{session.description}</p>
        )}
      </div>
    </div>
  );
}
