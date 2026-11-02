import { botAvatarSetting, type BotAvatarId } from "../lib/botAvatar";
import { saveSetting, useSetting } from "../lib/settingsEngine/store";

const update = (next: BotAvatarId) => saveSetting(botAvatarSetting, next);

/** The style every bot's face is drawn in; the settings page writes it. */
export function useBotAvatar() {
  return { avatar: useSetting(botAvatarSetting), update };
}
