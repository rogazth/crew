import { contextBridge } from "electron";
import { ignoreWindowClose } from "./guest-close";
import { passForFirefoxOnSignIn } from "./sign-in";

contextBridge.executeInMainWorld({ func: ignoreWindowClose });
contextBridge.executeInMainWorld({ func: passForFirefoxOnSignIn });
