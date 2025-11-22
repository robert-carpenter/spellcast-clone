import { GEM_TARGET, LETTER_VALUES, MIN_VOWELS, VOWELS } from "../shared/constants.js";
import { GameSnapshot, LastSubmission, TileModel } from "../shared/gameTypes.js";
import { GameState, Player, Room } from "./types.js";

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const TRIPLE_CHANCE = 0.12;
const BOARD_COLS = 5;
const BOARD_ROWS = 5;
const TOTAL_ROUNDS = 5;
const LONG_WORD_THRESHOLD = 6;
const LONG_WORD_BONUS = 10;

function getActivePlayers(room: Room): Player[] {
  return room.players.filter((player: Player) => !player.isSpectator);
}

function hasActivePlayers(room: Room): boolean {
  return room.players.some((player: Player) => !player.isSpectator);
}

function findFirstActiveIndex(room: Room): number {
  return room.players.findIndex((player: Player) => !player.isSpectator);
}

function getCurrentTurnPlayer(room: Room): Player | undefined {
  const game = room.game;
  if (!game) return undefined;
  if (!hasActivePlayers(room)) return undefined;
  const players = room.players;
  if (!players.length) return undefined;
  if (
    game.currentPlayerIndex >= players.length ||
    players[game.currentPlayerIndex]?.isSpectator
  ) {
    const firstActive = findFirstActiveIndex(room);
    if (firstActive === -1) return undefined;
    game.currentPlayerIndex = firstActive;
  }
  return players[game.currentPlayerIndex];
}

function getNextActiveIndex(room: Room, currentIndex: number): {
  index: number;
  wrapped: boolean;
} {
  const players = room.players;
  const total = players.length;
  if (!total || !hasActivePlayers(room)) {
    return { index: currentIndex, wrapped: false };
  }
  let idx = currentIndex;
  do {
    idx = (idx + 1) % total;
    if (!players[idx].isSpectator) {
      return { index: idx, wrapped: idx <= currentIndex };
    }
  } while (idx !== currentIndex);
  return { index: currentIndex, wrapped: true };
}

export interface SubmitResult {
  success: boolean;
  error?: string;
  payload?: {
    word: string;
    points: number;
    gems: number;
    longWordBonus: boolean;
  };
}

export interface ActionResult {
  success: boolean;
  error?: string;
}

export function createInitialGameState(): GameState {
  const tiles = createTiles(false, false);
  return {
    cols: BOARD_COLS,
    rows: BOARD_ROWS,
    tiles,
    round: 1,
    totalRounds: TOTAL_ROUNDS,
    currentPlayerIndex: 0,
    multipliersEnabled: false,
    wordMultiplierEnabled: false,
    swapModePlayerId: undefined,
    lastSubmission: undefined,
    completed: false,
    winnerId: undefined,
    log: []
  };
}

export function startNewGame(room: Room) {
  room.game = createInitialGameState();
  room.players.forEach((player: Player) => {
    player.score = 0;
    player.gems = 3;
    player.isSpectator = false;
  });
  const firstActive = findFirstActiveIndex(room);
  if (firstActive >= 0 && room.game) {
    room.game.currentPlayerIndex = firstActive;
  }
}

export function submitWord(
  room: Room,
  playerId: string,
  tileIds: string[],
  dictionary: Set<string>
): SubmitResult {
  const game = requireGame(room);
  if (!game) return { success: false, error: "Game not started." };
  if (game.completed) {
    return { success: false, error: "Game already completed." };
  }
  if (!tileIds.length) {
    return { success: false, error: "Select tiles to form a word." };
  }
  const player = getCurrentTurnPlayer(room);
  if (!player) {
    return { success: false, error: "No active players available." };
  }
  if (player.id !== playerId) {
    return { success: false, error: "It is not your turn." };
  }

  const tiles = tileIds.map((id) => game.tiles.find((tile: TileModel) => tile.id === id));
  if (tiles.some((tile) => !tile)) {
    return { success: false, error: "Invalid tile selection." };
  }
  const typedTiles = tiles as TileModel[];
  if (!isValidSelection(typedTiles)) {
    return {
      success: false,
      error: "Tiles must be unique and touch the previous tile."
    };
  }

  const word = typedTiles.map((tile) => tile.letter).join("");
  if (!dictionary.has(word.toUpperCase())) {
    return { success: false, error: `"${word}" is not a valid word.` };
  }

  const longWordBonus = word.length >= LONG_WORD_THRESHOLD;
  const points = calculateWordScore(typedTiles, longWordBonus);
  const gems = typedTiles.filter((tile) => tile.hasGem).length;

  player.score += points;
  player.gems += gems;

  refreshTiles(game, typedTiles);
  assignMultipliers(game);

  const submission: LastSubmission = {
    playerId: player.id,
    playerName: player.name,
    word: word.toUpperCase(),
    points,
    gems,
    longWordBonus
  };
  game.lastSubmission = submission;
  addLogEntry(
    game,
    `Round ${game.round}: ${submission.playerName} scored ${submission.points} pts${
      submission.gems ? ` and ${submission.gems} gem(s)` : ""
    } with ${submission.word}.`
  );

  advanceTurn(room);

  return {
    success: true,
    payload: {
      word: submission.word,
      points,
      gems,
      longWordBonus
    }
  };
}

export function shuffleBoard(room: Room, playerId: string): ActionResult {
  const game = requireGame(room);
  if (!game) return { success: false, error: "Game not started." };
  const player = room.players.find((p: Player) => p.id === playerId);
  if (!player) return { success: false, error: "Player not found." };
  if (player.isSpectator) return { success: false, error: "Spectators cannot use Shuffle." };
  if (player.gems < 1) return { success: false, error: "Need 1 gem to shuffle." };
  player.gems -= 1;
  const letters = game.tiles.map((tile: TileModel) => tile.letter);
  shuffleArray(letters);
  game.tiles.forEach((tile: TileModel, index: number) => {
    tile.letter = letters[index];
  });
  if (game.wordMultiplierEnabled) {
    moveWordMultiplier(game.tiles);
  }
  ensureMinimumVowels(game.tiles);
  return { success: true };
}

export function requestSwapMode(room: Room, playerId: string): ActionResult {
  const game = requireGame(room);
  if (!game) return { success: false, error: "Game not started." };
  const player = room.players.find((p: Player) => p.id === playerId);
  if (!player) return { success: false, error: "Player not found." };
  if (player.isSpectator) return { success: false, error: "Spectators cannot swap letters." };
  if (player.gems < 3) return { success: false, error: "Need 3 gems to swap a letter." };
  game.swapModePlayerId = playerId;
  return { success: true };
}

export function applySwap(
  room: Room,
  playerId: string,
  tileId: string,
  letter: string
): ActionResult {
  const game = requireGame(room);
  if (!game) return { success: false, error: "Game not started." };
  const player = room.players.find((p: Player) => p.id === playerId);
  if (!player) return { success: false, error: "Player not found." };
  if (player.isSpectator) {
    return { success: false, error: "Spectators cannot swap letters." };
  }
  if (game.swapModePlayerId !== playerId) {
    return { success: false, error: "You are not swapping a letter." };
  }
  if (player.gems < 3) {
    return { success: false, error: "You do not have enough gems." };
  }
  const tile = game.tiles.find((t: TileModel) => t.id === tileId);
  if (!tile) {
    return { success: false, error: "Tile not found." };
  }
  player.gems -= 3;
  tile.letter = normalizeLetter(letter);
  tile.hasGem = tile.hasGem; // no change
  game.swapModePlayerId = undefined;
  ensureMinimumVowels(game.tiles);
  return { success: true };
}

export function cancelSwap(room: Room, playerId: string) {
  const game = requireGame(room);
  if (!game) return;
  if (game.swapModePlayerId === playerId) {
    game.swapModePlayerId = undefined;
  }
}

export function toPublicGameState(game?: GameState): GameSnapshot | undefined {
  if (!game) return undefined;
  return { ...game };
}

function createTiles(
  multipliersEnabled: boolean,
  wordMultiplierEnabled: boolean
): TileModel[] {
  const tiles: TileModel[] = [];
  for (let y = 0; y < BOARD_ROWS; y += 1) {
    for (let x = 0; x < BOARD_COLS; x += 1) {
      tiles.push({
        id: tileId(x, y),
        x,
        y,
        letter: randomLetter(),
        hasGem: false,
        multiplier: "none",
        wordMultiplier: "none"
      });
    }
  }
  assignRandomGems(tiles);
  ensureMinimumVowels(tiles);
  if (multipliersEnabled) {
    ensureLetterMultiplier(tiles);
  }
  if (wordMultiplierEnabled) {
    ensureWordMultiplier(tiles);
  }
  return tiles;
}

function refreshTiles(game: GameState, tiles: TileModel[]) {
  tiles.forEach((tile: TileModel) => {
    tile.letter = randomLetter();
    tile.hasGem = false;
    tile.multiplier = "none";
    tile.wordMultiplier = game.wordMultiplierEnabled ? tile.wordMultiplier : "none";
    if (!game.wordMultiplierEnabled) {
      tile.wordMultiplier = "none";
    }
  });
  topUpGems(game.tiles);
  ensureMinimumVowels(game.tiles);
}

function assignMultipliers(game: GameState) {
  if (game.multipliersEnabled) {
    ensureLetterMultiplier(game.tiles);
  }
  if (game.wordMultiplierEnabled) {
    ensureWordMultiplier(game.tiles);
  }
}

function ensureLetterMultiplier(tiles: TileModel[]) {
  const existing = tiles.find((tile: TileModel) => tile.multiplier !== "none");
  if (existing) return;
  const candidates = tiles.filter((tile: TileModel) => tile.multiplier === "none");
  if (!candidates.length) return;
  const target = candidates[Math.floor(Math.random() * candidates.length)];
  target.multiplier = Math.random() < TRIPLE_CHANCE ? "tripleLetter" : "doubleLetter";
}

function ensureWordMultiplier(tiles: TileModel[]) {
  const existing = tiles.find((tile: TileModel) => tile.wordMultiplier === "doubleWord");
  if (existing) return;
  const candidates = tiles.filter((tile: TileModel) => tile.wordMultiplier === "none");
  if (!candidates.length) return;
  const target = candidates[Math.floor(Math.random() * candidates.length)];
  target.wordMultiplier = "doubleWord";
}

function moveWordMultiplier(tiles: TileModel[]) {
  if (!tiles.length) return;
  const currentIndex = tiles.findIndex((tile) => tile.wordMultiplier === "doubleWord");
  let candidates = tiles.filter((_, index) => index !== currentIndex);
  if (!candidates.length) {
    candidates = [...tiles];
  }
  const target = candidates[Math.floor(Math.random() * candidates.length)];
  tiles.forEach((tile) => {
    tile.wordMultiplier = tile === target ? "doubleWord" : "none";
  });
}

function isValidSelection(tiles: TileModel[]): boolean {
  const seen = new Set<string>();
  for (let i = 0; i < tiles.length; i += 1) {
    const tile = tiles[i];
    if (seen.has(tile.id)) {
      return false;
    }
    seen.add(tile.id);
    if (i === 0) continue;
    const prev = tiles[i - 1];
    const dx = Math.abs(prev.x - tile.x);
    const dy = Math.abs(prev.y - tile.y);
    if (dx > 1 || dy > 1 || (dx === 0 && dy === 0)) {
      return false;
    }
  }
  return true;
}

function calculateWordScore(tiles: TileModel[], hasLongWordBonus: boolean): number {
  const baseScore = tiles.reduce((total, tile) => {
    const base = LETTER_VALUES[tile.letter.toLowerCase()] ?? 0;
    const multiplier =
      tile.multiplier === "tripleLetter" ? 3 : tile.multiplier === "doubleLetter" ? 2 : 1;
    return total + base * multiplier;
  }, 0);
  const hasDoubleWord = tiles.some((tile) => tile.wordMultiplier === "doubleWord");
  const total = hasDoubleWord ? baseScore * 2 : baseScore;
  return total + (hasLongWordBonus ? LONG_WORD_BONUS : 0);
}

function advanceTurn(room: Room) {
  const game = requireGame(room);
  if (!game) return;
  if (!hasActivePlayers(room)) return;
  const { index, wrapped } = getNextActiveIndex(room, game.currentPlayerIndex);
  game.currentPlayerIndex = index;
  if (wrapped) {
    if (game.round < game.totalRounds) {
      game.round += 1;
      if (game.round > 1) {
        game.multipliersEnabled = true;
        game.wordMultiplierEnabled = true;
      }
      refreshAllTiles(game);
      assignMultipliers(game);
    } else {
      game.completed = true;
      determineWinner(room);
    }
  }
}

function refreshAllTiles(game: GameState) {
  game.tiles.forEach((tile: TileModel) => {
    tile.letter = randomLetter();
    tile.hasGem = false;
    tile.multiplier = "none";
    tile.wordMultiplier = "none";
  });
  assignRandomGems(game.tiles);
  ensureMinimumVowels(game.tiles);
}

function determineWinner(room: Room) {
  const candidates = getActivePlayers(room);
  const pool = candidates.length ? candidates : room.players;
  const sorted = [...pool].sort((a, b) => b.score - a.score);
  const top = sorted[0];
  if (room.game) {
    room.game.winnerId = top?.id;
  }
}

export function addLogEntry(game: GameState, message: string) {
  game.log.push(message);
  if (game.log.length > 50) {
    game.log.shift();
  }
}

function assignRandomGems(tiles: TileModel[], target = GEM_TARGET) {
  tiles.forEach((tile) => {
    if (tile.hasGem) {
      tile.hasGem = false;
    }
  });
  topUpGems(tiles, target);
}

function topUpGems(tiles: TileModel[], target = GEM_TARGET) {
  if (!tiles.length) return;
  const desired = Math.min(target, tiles.length);
  const current = tiles.reduce((count, tile) => count + (tile.hasGem ? 1 : 0), 0);
  if (current >= desired) return;
  const pool = tiles.filter((tile) => !tile.hasGem);
  if (!pool.length) return;
  shuffleArray(pool);
  const needed = Math.min(desired - current, pool.length);
  for (let i = 0; i < needed; i += 1) {
    pool[i].hasGem = true;
  }
}

function ensureMinimumVowels(tiles: TileModel[], target = MIN_VOWELS) {
  if (!tiles.length) return;
  const desired = Math.min(target, tiles.length);
  const current = tiles.reduce((count, tile) => count + (isVowel(tile.letter) ? 1 : 0), 0);
  if (current >= desired) return;
  const pool = tiles.filter((tile) => !isVowel(tile.letter));
  if (!pool.length) return;
  shuffleArray(pool);
  const needed = Math.min(desired - current, pool.length);
  for (let i = 0; i < needed; i += 1) {
    pool[i].letter = randomVowel();
  }
}

function shuffleArray<T>(items: T[]) {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
}

function randomLetter(): string {
  return LETTERS[Math.floor(Math.random() * LETTERS.length)];
}

function randomVowel(): string {
  return VOWELS[Math.floor(Math.random() * VOWELS.length)];
}

function isVowel(letter: string): boolean {
  return VOWELS.includes((letter ?? "").toUpperCase());
}

function normalizeLetter(letter: string): string {
  const upper = (letter ?? "").trim().charAt(0).toUpperCase();
  return LETTERS.includes(upper) ? upper : randomLetter();
}

function tileId(x: number, y: number): string {
  return `${x}-${y}`;
}

function requireGame(room: Room): GameState | undefined {
  return room.game;
}
