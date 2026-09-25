import type { Style, StyleDefinition } from "@dicebear/core";
import { BotIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useAgentAvatar } from "../hooks/useAgentAvatar";
import { useAgentFaces } from "../hooks/useAgentFaces";
import { avatarUri, loadAvatarStyle, type AgentAvatarId } from "../lib/agentAvatar";

/**
 * An agent's face, drawn from its session id so a rename keeps it. `style`
 * overrides the chosen one, for previews. Until the style's chunk lands the
 * robot glyph holds the spot. `bare` drops the disc, so a face whose shape is
 * its identity keeps its outline.
 */
export function AgentAvatar({
  seed,
  style,
  bare = false,
  className = "size-8",
}: {
  seed: string;
  style?: AgentAvatarId;
  bare?: boolean;
  className?: string;
}) {
  const { avatar } = useAgentAvatar();
  // A face picked for this agent wins over everyone's style; a preview's own `style` wins over both.
  const picked = useAgentFaces()[seed];
  const id = style ?? picked?.style ?? avatar;
  const drawn = picked?.seed ?? seed;
  const [loaded, setLoaded] = useState<{ id: AgentAvatarId; style: Style<StyleDefinition> } | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadAvatarStyle(id)
      .then((next) => !cancelled && setLoaded({ id, style: next }))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (loaded?.id !== id) {
    return (
      <span className={`${className} flex shrink-0 items-center justify-center rounded-full bg-fill text-text-muted`}>
        <BotIcon className="size-1/2" />
      </span>
    );
  }
  return (
    <img
      src={avatarUri(id, loaded.style, drawn)}
      alt=""
      aria-hidden
      draggable={false}
      className={`${className} shrink-0 ${bare ? "" : "rounded-full bg-fill"}`}
    />
  );
}
