import type { Style, StyleDefinition } from "@dicebear/core";
import { RobotIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useAgentAvatar } from "../hooks/useAgentAvatar";
import { avatarUri, loadAvatarStyle, type AgentAvatarId } from "../lib/agentAvatar";

/**
 * An agent's face, drawn from its session id so a rename keeps it. `style`
 * overrides the chosen one, for previews. Until the style's chunk lands the
 * robot glyph holds the spot.
 */
export function AgentAvatar({
  seed,
  style,
  className = "size-8",
}: {
  seed: string;
  style?: AgentAvatarId;
  className?: string;
}) {
  const { avatar } = useAgentAvatar();
  const id = style ?? avatar;
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
      <span className={`${className} flex shrink-0 items-center justify-center rounded-full bg-kumo-fill text-kumo-subtle`}>
        <RobotIcon className="size-1/2" />
      </span>
    );
  }
  return (
    <img
      src={avatarUri(id, loaded.style, seed)}
      alt=""
      aria-hidden
      draggable={false}
      className={`${className} shrink-0 rounded-full bg-kumo-fill`}
    />
  );
}
