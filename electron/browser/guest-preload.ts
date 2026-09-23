import { contextBridge } from "electron";
import { ignoreWindowClose } from "./guest-close";

contextBridge.executeInMainWorld({ func: ignoreWindowClose });
