import { GameSnapshot } from "../shared/gameTypes.js";

export interface Player {
  id: string;
  name: string;
  isHost: boolean;
  score: number;
  gems: number;
  joinedAt: number;
  connected: boolean;
  isSpectator: boolean;
}

export interface GameState extends GameSnapshot {
  swapModePlayerId?: string;
  log: string[];
}

export interface Room {
  id: string;
  createdAt: number;
  hostId: string;
  players: Player[];
  status: "lobby" | "in-progress";
  game?: GameState;
}
