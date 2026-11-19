import { on, onReconnect, openStream, request, uploadPiece, writeStream } from "./registry";

export const transport = { request, on, onReconnect, openStream, writeStream, uploadPiece };
