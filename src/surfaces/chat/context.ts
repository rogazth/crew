import { createContext, useContext } from "react";
import type { ProjectFile } from "../../lib/types";

/** What a chat surface can ask of the shell without a prop for every level. */
export type ChatActions = {
  /** Workspace-relative or absolute; opens a file tab. */
  openPath: (path: string) => void;
  /** The workspace index, for `@` mentions. */
  files: ProjectFile[];
};

export const ChatContext = createContext<ChatActions>({ openPath: () => undefined, files: [] });

export function useChatActions(): ChatActions {
  return useContext(ChatContext);
}
