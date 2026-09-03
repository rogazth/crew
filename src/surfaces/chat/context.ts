import { createContext, useContext } from "react";

/** What a chat surface can ask of the shell without a prop for every level. */
export type ChatActions = {
  /** Workspace-relative or absolute; opens a file tab. */
  openPath: (path: string) => void;
};

export const ChatContext = createContext<ChatActions>({ openPath: () => undefined });

export function useChatActions(): ChatActions {
  return useContext(ChatContext);
}
