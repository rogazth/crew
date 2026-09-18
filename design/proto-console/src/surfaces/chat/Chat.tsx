import { useEffect, useState } from "react";
import type { AttachedFile, Session, ThreadState } from "@crew/fixtures";
import { threadOf } from "@/lib/source";
import { noteThread } from "@/lib/roster";
import { useEvent } from "@/lib/hooks";
import { ChatHeader } from "./ChatHeader";
import { Transcript } from "./Transcript";
import { Composer } from "./Composer";
import { LogColumn, LogRow } from "./LogRow";

export function Chat({ session, active }: { session: Session; active: boolean }) {
  const runtime = threadOf(session.id);
  const [thread, setThread] = useState<ThreadState>(() => runtime.snapshot());

  useEffect(() => {
    // The handle calls back synchronously before it returns, so the unsubscribe
    // does not exist yet inside that first call — hence the box.
    const box: { off?: () => void } = {};
    box.off = runtime.subscribe((state) => {
      noteThread(session.id, state.blocks);
      setThread(state);
    });
    return () => box.off?.();
  }, [runtime, session.id]);

  const send = useEvent((text: string, files: AttachedFile[]) => {
    runtime.send(text, files);
  });

  const decide = useEvent((requestId: number, decision: "allow" | "always" | "deny") => {
    runtime.approve(requestId, decision);
  });

  const answer = useEvent((requestId: number, answers: Record<string, string> | null) => {
    runtime.answer(requestId, answers);
  });

  const empty = thread.blocks.length === 0;

  if (empty) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <ChatHeader session={session} />
        <div className="flex min-h-0 flex-1 flex-col justify-center px-4">
        <LogColumn>
          <LogRow gutter="agent" contentClassName="pb-4">
            <span className="flex flex-col gap-1">
              <span className="font-mono text-lg text-ink">{session.name}</span>
              <span className="text-md text-ink-3">
                {session.description || "No description yet."}
              </span>
              <span className="font-mono text-xs text-ink-4">
                Nothing has been said in this session. Say the first thing.
              </span>
            </span>
          </LogRow>
          <LogRow gutter="you">
            <Composer
              session={session}
              working={thread.working}
              active={active}
              onSend={send}
              onStop={() => runtime.stop()}
            />
          </LogRow>
        </LogColumn>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ChatHeader session={session} />
      <Transcript
        session={session}
        blocks={thread.blocks}
        working={thread.working}
        onDecide={decide}
        onAnswer={answer}
      />
      <div className="shrink-0 border-t border-rule px-4 pt-2 pb-3">
        <LogColumn>
          <div className="pl-[calc(var(--log-gutter)+13px)]">
            <Composer
              session={session}
              working={thread.working}
              active={active}
              onSend={send}
              onStop={() => runtime.stop()}
            />
          </div>
        </LogColumn>
      </div>
    </div>
  );
}
