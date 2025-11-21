export interface Player {
  id: string;
  name: string;
  isHost: boolean;
  score: number;
  gems: number;
  joinedAt: number;
}

export interface Room {
  id: string;
  createdAt: number;
  hostId: string;
  players: Player[];
  status: "lobby" | "in-progress";
}
