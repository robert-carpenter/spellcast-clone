// Shared rules facade.
// NOTE: For now this re-exports the authoritative rule implementations from the server module
// so both offline and server code can import from one place. In later phases we can relocate
// the implementation here to eliminate the indirection.

export type { Player, Room, GameState } from "../server/types.js";

export {
  createInitialGameState,
  startNewGame,
  submitWord,
  shuffleBoard,
  requestSwapMode,
  applySwap,
  cancelSwap,
  toPublicGameState,
  advanceTurn,
  advanceRound,
  addLogEntry
} from "../server/gameState.js";
