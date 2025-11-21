import { io, Socket } from "socket.io-client";
import type { RoomDTO } from "./api";

const SOCKET_BASE = import.meta.env.VITE_SERVER_URL ?? "http://localhost:4000";

export interface RoomSocketHandlers {
  onRoomUpdate(room: RoomDTO): void;
  onDisconnect(reason: string): void;
  onError?(message: string): void;
  onConnect?(): void;
  onReconnect?(): void;
}

export type RoomSocket = Socket<{
  "room:update": (room: RoomDTO) => void;
  "room:error": (payload: { message: string }) => void;
}> &
  Socket;

export function connectRoomSocket(
  roomId: string,
  playerId: string,
  handlers: RoomSocketHandlers
): RoomSocket {
  const socket = io(SOCKET_BASE, {
    transports: ["websocket"],
    forceNew: true,
    reconnection: true,
    auth: { roomId, playerId }
  }) as RoomSocket;

  socket.on("room:update", (room: RoomDTO) => handlers.onRoomUpdate(room));

  socket.on("room:error", (payload: { message: string }) => {
    handlers.onError?.(payload.message);
    socket.disconnect();
  });

  socket.on("connect_error", (err) => {
    handlers.onError?.(err.message ?? "Connection error");
  });

  socket.on("disconnect", (reason) => {
    handlers.onDisconnect(reason);
  });

  socket.on("connect", () => {
    handlers.onConnect?.();
  });

  socket.io.on("reconnect", () => {
    handlers.onReconnect?.();
  });

  return socket;
}
