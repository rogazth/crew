import { createContext, useContext } from "react";

/**
 * Which open card currently owns Enter and Escape. Only the newest one does, and
 * "newest" is a property of the whole transcript, not of any one card — so it is
 * decided once, above, instead of by every card racing for the key handler.
 */
export const HotCardContext = createContext<{ approval: string | null; question: string | null }>({
  approval: null,
  question: null,
});

export const useHotApproval = () => useContext(HotCardContext).approval;
export const useHotQuestion = () => useContext(HotCardContext).question;
