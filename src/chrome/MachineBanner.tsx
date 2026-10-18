import { LoaderCircleIcon, WifiOffIcon } from "lucide-react";
import { useWorkspaceLink } from "../hooks/useEnvLinks";
import { reconnect } from "../lib/client/registry";
import { openSettingsSection } from "../lib/remoteUi";
import { Button } from "./kit";

/**
 * Over a workspace whose machine is not answering: what is going on and what
 * to do. Its bots keep running over there; only the window lost them.
 */
export function MachineBanner({ workspaceId }: { workspaceId: string | null }) {
  const link = useWorkspaceLink(workspaceId);
  if (!link || (link.status === "online" && !link.mismatch)) return null;
  const connecting = link.status === "connecting";
  return (
    <div
      role="status"
      data-machine-banner={link.mismatch ? "mismatch" : link.status}
      className="flex shrink-0 items-center gap-2.5 border-b border-hairline bg-warning/8 px-3 py-2 text-[12px]"
    >
      {connecting ? (
        <LoaderCircleIcon className="size-3.5 shrink-0 animate-spin text-text-muted" />
      ) : (
        <WifiOffIcon className="size-3.5 shrink-0 text-danger" />
      )}
      <span className="min-w-0 flex-1 truncate">
        {link.mismatch ? (
          <>
            <b className="font-medium">{link.name} runs an incompatible crewd.</b>{" "}
            <span className="text-text-muted">Update it in Settings.</span>
          </>
        ) : connecting ? (
          <>
            <b className="font-medium">Connecting to {link.name}…</b>{" "}
            <span className="text-text-muted">Bots keep running there.</span>
          </>
        ) : (
          <>
            <b className="font-medium">{link.name} offline.</b>{" "}
            <span className="text-text-muted">
              {link.error ? `${link.error}. ` : ""}Bots keep running; reconnecting automatically.
            </span>
          </>
        )}
      </span>
      {link.mismatch ? (
        <Button variant="ghost" className="h-6 px-2 text-[12px]" onClick={() => openSettingsSection("environments")}>
          Settings
        </Button>
      ) : (
        !connecting && (
          <Button variant="ghost" className="h-6 px-2 text-[12px]" onClick={() => reconnect(link.id)}>
            Try again
          </Button>
        )
      )}
    </div>
  );
}
