import type { Workspace } from "../lib/types";
import { workspaceMark } from "../lib/workspaces";
import { useWorkspaceFace } from "./workspaceProfile";

const SIZES = {
  /** A mark beside a name the rail already shows. */
  sm: "size-5 rounded-[5px] text-[8px]",
  md: "size-8 rounded-lg text-[11px] tracking-wide",
  /** Heading the workspace's settings. */
  lg: "size-12 rounded-[15px] text-[16px] tracking-wide",
};

/** The workspace's tile, as the rail draws it: its face when it has one, else its initials on ink. */
export function WorkspaceTile({ workspace, size = "md" }: { workspace: Workspace; size?: keyof typeof SIZES }) {
  const faceUrl = useWorkspaceFace(workspace);
  return (
    <span aria-hidden className={`grid shrink-0 place-items-center overflow-hidden font-semibold ${SIZES[size]} ${faceUrl ? "" : "bg-accent text-inverse"}`}>
      {faceUrl ? <img src={faceUrl} alt="" draggable={false} className="size-full object-contain" /> : workspaceMark(workspace.name)}
    </span>
  );
}
