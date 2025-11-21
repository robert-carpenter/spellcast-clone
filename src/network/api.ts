export interface RoomPlayerDTO {
  id: string;
  name: string;
  isHost: boolean;
  score: number;
  gems: number;
}

export interface RoomDTO {
  id: string;
  players: RoomPlayerDTO[];
  hostId: string;
  status: "lobby" | "in-progress";
}

export interface CreateRoomResponse {
  roomId: string;
  player: RoomPlayerDTO;
  room: RoomDTO;
}

export interface JoinRoomResponse extends CreateRoomResponse {}

const API_BASE = import.meta.env.VITE_SERVER_URL ?? "http://localhost:4000";

async function request<T>(path: string, options: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      "Content-Type": "application/json"
    },
    ...options
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error ?? res.statusText);
  }
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

export function leaveRoom(roomId: string, playerId: string): Promise<void> {
  return request(`/api/rooms/${encodeURIComponent(roomId)}/players/${encodeURIComponent(playerId)}`, {
    method: "DELETE"
  });
}
