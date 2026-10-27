import type { Style, StyleDefinition } from "@dicebear/core";
import { useEffect, useMemo, useState } from "react";
import { providerMark } from "../chrome/providerMarks";
import { avatarUri, loadAvatarStyle, type BotAvatarId } from "../lib/botAvatar";
import type { Session } from "../lib/types";
import { useBotAvatar } from "./useBotAvatar";
import { useBotFaces } from "./useBotFaces";

/** What an `@name` chip wears: a bot's face, a session's provider logo (a mask, for a one-colour one). */
export type AgentIcon = { src: string; mask: boolean };

/**
 * Each agent's icon as a URL, for what draws outside React (the composer's
 * chips): the face `BotAvatar` would draw for a bot, the provider's logo for
 * a session. A bot whose face style is still loading has none yet.
 */
export function useAgentIcons(agents: readonly Session[]): ReadonlyMap<string, AgentIcon> {
  const { avatar } = useBotAvatar();
  const faces = useBotFaces();
  const [styles, setStyles] = useState<Partial<Record<BotAvatarId, Style<StyleDefinition>>>>({});
  const wanted = useMemo(
    () => [...new Set(agents.filter((agent) => agent.kind === "bot").map((agent) => faces[agent.id]?.style ?? avatar))],
    [agents, faces, avatar],
  );
  useEffect(() => {
    let live = true;
    for (const id of wanted) {
      if (styles[id]) continue;
      loadAvatarStyle(id)
        .then((style) => live && setStyles((loaded) => ({ ...loaded, [id]: style })))
        .catch(() => {});
    }
    return () => {
      live = false;
    };
  }, [wanted, styles]);
  return useMemo(() => {
    const icons = new Map<string, AgentIcon>();
    for (const agent of agents) {
      if (agent.kind !== "bot") {
        const mark = providerMark(agent.provider);
        if (mark) icons.set(agent.id, mark);
        continue;
      }
      const face = faces[agent.id];
      const id = face?.style ?? avatar;
      const style = styles[id];
      if (style) icons.set(agent.id, { src: avatarUri(id, style, face?.seed ?? agent.id), mask: false });
    }
    return icons;
  }, [agents, faces, avatar, styles]);
}
