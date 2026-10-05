import { createContext, createElement, useCallback, useContext, useEffect, useState } from "react";
import * as api from "../lib/api";
import { DEFAULT_BOT_AVATAR, parseBotAvatar, type BotAvatarId } from "../lib/botAvatar";

const KEY = "bot:avatar";

type Value = { avatar: BotAvatarId; update: (next: BotAvatarId) => void };

const Context = createContext<Value>({ avatar: DEFAULT_BOT_AVATAR, update: () => {} });

/** Picks the style every bot's face is drawn in; the settings page writes here. */
export function BotAvatarProvider({ children }: { children: React.ReactNode }) {
  const [avatar, setAvatar] = useState(DEFAULT_BOT_AVATAR);

  useEffect(() => {
    let cancelled = false;
    api
      .stateGet(KEY)
      .then((raw) => !cancelled && setAvatar(parseBotAvatar(raw)))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const update = useCallback((next: BotAvatarId) => {
    setAvatar(next);
    void api.stateSet(KEY, next).catch(() => {});
  }, []);

  return createElement(Context.Provider, { value: { avatar, update } }, children);
}

export const useBotAvatar = () => useContext(Context);
