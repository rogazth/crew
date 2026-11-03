import { contextBridge } from "electron";
import { ignoreWindowClose } from "./guest-close";
import { firefoxUserAgent } from "./identity";
import { passForFirefoxOnSignIn } from "./sign-in";

contextBridge.executeInMainWorld({ func: ignoreWindowClose });
contextBridge.executeInMainWorld({ func: passForFirefoxOnSignIn, args: [firefoxUserAgent()] });
