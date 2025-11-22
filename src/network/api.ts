import type { GameSnapshot } from "../shared/gameTypes";

export interface RoomPlayerDTO {
  id: string;
  name: string;
  isHost: boolean;
  score: number;
  gems: number;
  isSpectator: boolean;
  connected: boolean;
}

export interface RoomDTO {
  id: string;
  players: RoomPlayerDTO[];
  hostId: string;
  status: "lobby" | "in-progress";
  rounds: number;
  game?: GameSnapshot;
}

export interface CreateRoomResponse {
  roomId: string;
  player: RoomPlayerDTO;
  room: RoomDTO;
}

export interface JoinRoomResponse extends CreateRoomResponse {}

const API_BASE = (() => {
  const configured = import.meta.env.VITE_SERVER_URL;
  if (configured && configured.trim().length) {
    return configured;
  }
  return typeof window !== "undefined"
    ? window.location.origin
    : "http://localhost:8900";
})();

async function request<T>(path: string, options: RequestInit): Promise<T> {
  console.log("[client][api]", options?.method ?? "GET", path, options?.body ?? "");
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      "Content-Type": "application/json"
    },
    ...options
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    console.warn("[client][api] error", path, err);
    throw new Error(err.error ?? res.statusText);
  }
  console.log("[client][api] success", path);
  return res.json();
}

export function createRoom(name: string): Promise<CreateRoomResponse> {
  return request("/api/rooms", {
    method: "POST",
    body: JSON.stringify({ name })
  });
}

export function joinRoom(roomId: string, name: string): Promise<JoinRoomResponse> {
  return request(`/api/rooms/${encodeURIComponent(roomId)}/join`, {
    method: "POST",
    body: JSON.stringify({ name })
  });
}

export function getRoom(roomId: string): Promise<RoomDTO> {
  return request(`/api/rooms/${encodeURIComponent(roomId)}`, {
    method: "GET"
  });
}

export function startRoom(roomId: string, playerId: string): Promise<{ room: RoomDTO }> {
  return request(`/api/rooms/${encodeURIComponent(roomId)}/start`, {
    method: "POST",
    body: JSON.stringify({ playerId })
  });
}

export function updateRoomRounds(
  roomId: string,
  playerId: string,
  rounds: number
): Promise<{ room: RoomDTO }> {
  return request(`/api/rooms/${encodeURIComponent(roomId)}/settings`, {
    method: "PATCH",
    body: JSON.stringify({ playerId, rounds })
  });
}

export function leaveRoom(roomId: string, playerId: string, requesterId?: string): Promise<void> {
  return request(`/api/rooms/${encodeURIComponent(roomId)}/players/${encodeURIComponent(playerId)}`, {
    method: "DELETE",
    body: JSON.stringify({ requesterId: requesterId ?? playerId })
  });
}

export function kickPlayer(
  roomId: string,
  playerId: string,
  requesterId: string
): Promise<void> {
  return leaveRoom(roomId, playerId, requesterId);
}
