import { contextBridge } from "electron";
import { ignoreWindowClose } from "./guest-close";
import { passForChrome } from "./page-chrome";
import { firefoxUserAgent } from "./identity";
import { passForFirefoxOnSignIn } from "./sign-in";

contextBridge.executeInMainWorld({ func: ignoreWindowClose });
contextBridge.executeInMainWorld({ func: passForChrome });
contextBridge.executeInMainWorld({ func: passForFirefoxOnSignIn, args: [firefoxUserAgent()] });
