import { Menu } from "electron";
import { installCli } from "./install-cli";
import { checkForUpdates } from "./update";

type Actions = { quitAndStopEverything: () => void };

export function buildMenu({ quitAndStopEverything }: Actions): Menu {
  return Menu.buildFromTemplate([
    {
      label: "Crew",
      submenu: [
        { role: "about" },
        { label: "Check for Updates\u2026", click: () => void checkForUpdates(true) },
        { label: "Install `crew` Command\u2026", click: () => void installCli() },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
        // Quit leaves crewd running with the processes and agents it holds;
        // this stops them too.
        { label: "Quit Crew and Stop Everything", click: quitAndStopEverything },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "Window",
      submenu: [{ role: "minimize" }, { role: "zoom" }],
    },
  ]);
}
