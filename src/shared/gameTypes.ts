export type Multiplier = "none" | "doubleLetter" | "tripleLetter";
export type WordMultiplier = "none" | "doubleWord";

export interface TileModel {
  id: string;
  x: number;
  y: number;
  letter: string;
  hasGem: boolean;
  multiplier: Multiplier;
  wordMultiplier: WordMultiplier;
}

export interface LastSubmission {
  playerId: string;
  playerName: string;
  word: string;
  points: number;
  gems: number;
  longWordBonus: boolean;
}

export interface GameSnapshot {
  cols: number;
  rows: number;
  tiles: TileModel[];
  round: number;
  totalRounds: number;
  currentPlayerIndex: number;
  turnStartedAt: number;
  multipliersEnabled: boolean;
  wordMultiplierEnabled: boolean;
  roundWordTileId?: string;
  swapModePlayerId?: string;
  lastSubmission?: LastSubmission;
  completed: boolean;
  winnerId?: string;
  log?: string[];
}
