import { useEffect } from "react";
import { isCommandId, liveCommands, onCommandsChange, runCommand } from "../lib/commands";
import { browserHost } from "../lib/host";

/**
 * A focused page is its own process and swallows every key. Main checks
 * each chord pressed in one against the commands live here and sends the
 * match back, so ⌘W and ⌘K work from inside a page like anywhere else.
 */
export function useBrowserBridge() {
  useEffect(() => {
    const host = browserHost();
    if (!host) return;
    const publish = () => host.setCommands(liveCommands());
    publish();
    const unsubscribe = onCommandsChange(publish);
    const unlisten = host.onCommand((id) => {
      if (isCommandId(id)) runCommand(id);
    });
    return () => {
      unsubscribe();
      unlisten();
    };
  }, []);
}
