import { contextBridge, ipcRenderer } from "electron";
import { FORM_TYPED } from "../../src/lib/browser/bridge";
import { watchFormInput } from "./form-input";
import { ignoreWindowClose } from "./guest-close";
import { firefoxUserAgent } from "./identity";
import { passForFirefoxOnSignIn } from "./sign-in";

contextBridge.executeInMainWorld({ func: ignoreWindowClose });
contextBridge.executeInMainWorld({ func: passForFirefoxOnSignIn, args: [firefoxUserAgent()] });
// A half-filled form keeps its page loaded; the window hears of it once per document.
watchFormInput(
  window,
  () => navigator.userActivation?.isActive !== false,
  () => ipcRenderer.sendToHost(FORM_TYPED),
);
