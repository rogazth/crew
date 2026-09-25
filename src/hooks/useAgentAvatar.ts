import { createContext, createElement, useCallback, useContext, useEffect, useState } from "react";
import * as api from "../lib/api";
import { DEFAULT_AGENT_AVATAR, parseAgentAvatar, type AgentAvatarId } from "../lib/agentAvatar";

const KEY = "agent:avatar";

type Value = { avatar: AgentAvatarId; update: (next: AgentAvatarId) => void };

const Context = createContext<Value>({ avatar: DEFAULT_AGENT_AVATAR, update: () => {} });

/** Picks the style every agent's face is drawn in; the settings page writes here. */
export function AgentAvatarProvider({ children }: { children: React.ReactNode }) {
  const [avatar, setAvatar] = useState(DEFAULT_AGENT_AVATAR);

  useEffect(() => {
    let cancelled = false;
    api
      .stateGet(KEY)
      .then((raw) => !cancelled && setAvatar(parseAgentAvatar(raw)))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const update = useCallback((next: AgentAvatarId) => {
    setAvatar(next);
    void api.stateSet(KEY, next).catch(() => {});
  }, []);

  return createElement(Context.Provider, { value: { avatar, update } }, children);
}

export const useAgentAvatar = () => useContext(Context);
