import { useCallback, useState } from "react";
import { Footer, Overlay } from "./kit";
import type { Workspace, Worktree } from "../lib/types";
import { shortenPath } from "../lib/workspaces";
import { branchError, worktreeLabel } from "../lib/worktrees";

type Props = {
  workspace: Workspace;
  /** The worktree on screen; a new branch starts from the main checkout's HEAD. */
  from: Worktree | undefined;
  onCreate: (branch: string, withAgent: boolean) => Promise<void>;
  onClose: () => void;
};

/** Where git will put it: crew's folder, one directory per branch. */
function preview(workspace: Workspace, branch: string): string {
  const repo = workspace.path.split("/").filter(Boolean).pop() ?? workspace.name;
  const slug = branch.trim().replace(/[^A-Za-z0-9._-]/g, "-") || "…";
  return `~/.crew/worktrees/${repo}/${slug}`;
}

/** A branch name and nothing else; ↵ makes the worktree, ⌘↵ makes it and an agent to work in it. */
export function NewWorktreeDialog({ workspace, from, onCreate, onClose }: Props) {
  const [branch, setBranch] = useState("feat/");
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useCallback((node: HTMLInputElement | null) => {
    if (!node) return;
    node.focus();
    node.setSelectionRange(node.value.length, node.value.length);
  }, []);

  const invalid = branchError(branch);

  async function submit(withAgent: boolean) {
    if (invalid || busy) return;
    setBusy(true);
    try {
      await onCreate(branch.trim(), withAgent);
    } catch (error) {
      setFailure(String(error).replace(/^Error:\s*/, ""));
      setBusy(false);
    }
  }

  return (
    <Overlay onClose={onClose}>
      <div className="flex flex-col gap-3 p-4">
        <div className="text-[14px] font-semibold">New worktree</div>
        <input
          ref={input}
          value={branch}
          aria-label="Branch"
          placeholder="Branch"
          spellCheck={false}
          disabled={busy}
          onChange={(event) => {
            setBranch(event.target.value);
            setFailure(null);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            // The agent sheet this can open listens for ⌘↵ too; the press is spent here.
            event.preventDefault();
            event.stopPropagation();
            event.nativeEvent.stopImmediatePropagation();
            void submit(event.metaKey || event.ctrlKey);
          }}
          className="h-9 rounded-md bg-kumo-base px-3 ring ring-kumo-line outline-none focus:ring-kumo-focus/50"
        />
        <div className="flex flex-col gap-1 text-[12px] text-kumo-subtle">
          <span>
            From <span className="text-kumo-default">{from ? worktreeLabel(from) : "HEAD"}</span>
          </span>
          <span className="truncate font-mono text-[11px]" title={workspace.path}>
            {shortenPath(preview(workspace, branch))}
          </span>
          {failure && <span className="text-kumo-danger">{failure}</span>}
        </div>
      </div>
      <Footer
        hints={[
          ["↵", busy ? "creating…" : "create"],
          ["⌘↵", "create + agent"],
          ["esc", "cancel"],
        ]}
      />
    </Overlay>
  );
}
