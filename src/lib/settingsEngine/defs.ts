// Every setting the engine holds, each defined beside what it means. A new one
// goes here, so a global one is known from its first reconciliation; one whose
// key depends on something (a provider's install method) is defined where it is used.
import { accentSetting } from "../accent";
import { botAvatarSetting } from "../botAvatar";
import { browserPrefsSetting } from "../browserPrefs";
import { sitePermissionsSetting } from "../browser/permissions";
import { chatTextSetting } from "../chatText";
import { keybindingsSetting } from "../keybindings";
import { notificationPrefsSetting } from "../notificationPrefs";
import { bypassPermissions } from "../permissions";
import { defaultAgentSetting, lastAgentsSetting } from "../providers";
import { autoUpdateSetting, warnRelaySetting, wakeSetting } from "../remoteUi";
import { retention } from "../retention";
import { reopenSetting } from "../startup";
import { terminalPrefsSetting } from "../terminalPrefs";
import { autoDownloadSetting } from "../updatePrefs";
import { alertsSetting, ringsSetting } from "../usage";
import type { SettingDef } from "./define";

export const ALL_SETTINGS: SettingDef<never>[] = [
  // Yours wherever you work.
  retention,
  bypassPermissions,
  defaultAgentSetting,
  lastAgentsSetting,
  accentSetting,
  chatTextSetting,
  botAvatarSetting,
  terminalPrefsSetting,
  browserPrefsSetting,
  alertsSetting,
  ringsSetting,
  // This computer's.
  reopenSetting,
  wakeSetting,
  warnRelaySetting,
  autoUpdateSetting,
  autoDownloadSetting,
  keybindingsSetting,
  notificationPrefsSetting,
  sitePermissionsSetting,
] as unknown as SettingDef<never>[];

export const GLOBAL_KEYS: string[] = ALL_SETTINGS.filter((def) => def.scope === "global").map((def) => def.key);
