import { io, Socket } from "socket.io-client";
import type { RoomDTO } from "./api";

const SOCKET_BASE = import.meta.env.VITE_SERVER_URL ?? "http://localhost:4000";

export interface RoomSocketHandlers {
  onRoomUpdate(room: RoomDTO): void;
  onDisconnect(reason: string): void;
  onError?(message: string): void;
  onGameError?(message: string): void;
  onSelection?(playerId: string, tileIds: string[]): void;
  onConnect?(): void;
  onReconnect?(): void;
}

export type RoomSocket = Socket<{
  "room:update": (room: RoomDTO) => void;
  "room:error": (payload: { message: string }) => void;
  "game:selection": (payload: { playerId: string; tileIds: string[] }) => void;
  "game:error": (payload: { message: string }) => void;
}> &
  Socket;

export function connectRoomSocket(
  roomId: string,
  playerId: string,
  handlers: RoomSocketHandlers
): RoomSocket {
  console.log("[client][socket] connecting", roomId, playerId);
  const socket = io(SOCKET_BASE, {
    transports: ["websocket"],
    forceNew: true,
    reconnection: true,
    auth: { roomId, playerId }
  }) as RoomSocket;

  socket.on("room:update", (room: RoomDTO) => {
    console.log("[client][socket] room:update", room.id, room.status);
    handlers.onRoomUpdate(room);
  });

  socket.on("room:error", (payload: { message: string }) => {
    console.warn("[client][socket] room:error", payload);
    handlers.onError?.(payload.message);
    socket.disconnect();
  });

  socket.on("game:error", (payload: { message: string }) => {
    console.warn("[client][socket] game:error", payload);
    handlers.onGameError?.(payload.message);
  });

  socket.on("game:selection", (payload: { playerId: string; tileIds: string[] }) => {
    console.log("[client][socket] game:selection", payload);
    handlers.onSelection?.(payload.playerId, payload.tileIds ?? []);
  });

  socket.on("connect_error", (err) => {
    console.warn("[client][socket] connect_error", err);
    handlers.onError?.(err.message ?? "Connection error");
  });

  socket.on("disconnect", (reason) => {
    console.log("[client][socket] disconnect", reason);
    handlers.onDisconnect(reason);
  });

  socket.on("connect", () => {
    console.log("[client][socket] connected");
    handlers.onConnect?.();
  });

  socket.io.on("reconnect", () => {
    console.log("[client][socket] reconnect");
    handlers.onReconnect?.();
  });

  return socket;
}
