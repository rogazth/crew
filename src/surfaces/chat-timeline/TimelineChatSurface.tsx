import { DefaultChatSurface } from "../chat/DefaultChatSurface";
import type { ChatSurfaceProps } from "../chat/surface";

/** Timeline theme: still the default layout until this surface grows its own transcript. */
export function TimelineChatSurface(props: ChatSurfaceProps) {
  return <DefaultChatSurface {...props} />;
}
