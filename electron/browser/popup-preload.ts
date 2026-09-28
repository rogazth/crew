import { contextBridge } from "electron";
import { passForFirefoxOnSignIn } from "./sign-in";

contextBridge.executeInMainWorld({ func: passForFirefoxOnSignIn });
