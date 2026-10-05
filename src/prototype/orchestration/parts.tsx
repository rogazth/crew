// PROTOTYPE — the small pieces every orchestration surface shares: a participant's face, a command's state.
import { BotIcon, UserIcon } from "lucide-react";
import { AgentAvatar } from "../../chrome/AgentAvatar";
import { ProviderIcon } from "../../chrome/ProviderIcon";
import type { ProtoSession, Task } from "./store";

/** A bot is its face; a session is its CLI's mark; the user is the person glyph. */
export function Face({ name, sessions, className = "size-4" }: { name: string; sessions: ProtoSession[]; className?: string }) {
  if (name === "You") return <UserIcon className={`${className} shrink-0 rounded-full bg-card p-[2px] text-icon`} />;
  const session = sessions.find((s) => s.name === name);
  if (!session) return <BotIcon className={`${className} shrink-0 text-icon`} />;
  return session.kind === "agent" ? (
    <AgentAvatar seed={session.id} bare className={className} />
  ) : (
    <ProviderIcon provider={session.provider} className={className} />
  );
}

/** A background command's state at a glance: running pulses, a clean exit is a still dot, a failure red. */
export function TaskDot({ task }: { task: Task }) {
  if (task.state === "running") return <span className="proto-bg-dot" aria-hidden />;
  const tone = task.state === "stopped" ? "bg-placeholder" : task.exitCode === 0 ? "bg-text-muted" : "bg-danger";
  return <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${tone}`} />;
}
