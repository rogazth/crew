import { contextBridge } from "electron";
import { passForChrome } from "./page-chrome";
import { firefoxUserAgent } from "./identity";
import { passForFirefoxOnSignIn } from "./sign-in";

contextBridge.executeInMainWorld({ func: passForChrome });
contextBridge.executeInMainWorld({ func: passForFirefoxOnSignIn, args: [firefoxUserAgent()] });
