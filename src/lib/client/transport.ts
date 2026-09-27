import { on, onReconnect, openStream, request, writeStream } from "./registry";

export const transport = { request, on, onReconnect, openStream, writeStream };
