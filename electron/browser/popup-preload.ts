import { contextBridge } from "electron";
import { firefoxUserAgent } from "./identity";
import { passForFirefoxOnSignIn } from "./sign-in";

contextBridge.executeInMainWorld({ func: passForFirefoxOnSignIn, args: [firefoxUserAgent()] });
