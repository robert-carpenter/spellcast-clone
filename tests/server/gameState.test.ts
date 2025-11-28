import { describe, it, expect } from "vitest";
import { MIN_VOWELS, VOWELS } from "../../src/shared/constants.js";
import {
  createInitialGameState,
  submitWord,
  advanceRound,
  shuffleBoard,
  topUpGems,
  toPublicGameState,
  requestSwapMode,
  applySwap
} from "../../src/server/gameState.js";
import type { Room } from "../../src/server/types.js";

const makeRoom = (): Room => ({
  id: "room-1",
  createdAt: Date.now(),
  hostId: "p1",
  status: "in-progress",
  rounds: 5,
  players: [
    {
      id: "p1",
      name: "Host",
      isHost: true,
      score: 0,
      gems: 3,
      joinedAt: Date.now(),
      connected: true,
      isSpectator: false
    },
    {
      id: "p2",
      name: "Player2",
      isHost: false,
      score: 0,
      gems: 3,
      joinedAt: Date.now(),
      connected: true,
      isSpectator: false
    }
  ],
  game: createInitialGameState()
});

const countVowels = (letters: string[]) =>
  letters.reduce((count, letter) => count + (VOWELS.includes(letter.toUpperCase()) ? 1 : 0), 0);

describe("gameState vowels", () => {
  it("initial board meets minimum vowel count", () => {
    const game = createInitialGameState();
    const vowels = countVowels(game.tiles.map((t) => t.letter));
    expect(vowels).toBeGreaterThanOrEqual(MIN_VOWELS);
  });

  it("refresh after submission keeps at least minimum vowels", () => {
    const room = makeRoom();
    const game = room.game!;
    const dict = new Set(["CAT", "DOG", "CAN", "RAN"]);

    // Force a simple word across the top row
    const ids = ["0-0", "1-0", "2-0"];
    game.tiles.forEach((tile) => {
      if (tile.id === "0-0") tile.letter = "C";
      if (tile.id === "1-0") tile.letter = "A";
      if (tile.id === "2-0") tile.letter = "T";
      if (!ids.includes(tile.id)) tile.letter = "A"; // ensure plenty of vowels baseline
    });

    const result = submitWord(room, "p1", ids, dict);
    expect(result.success).toBe(true);
    const vowels = countVowels(game.tiles.map((t) => t.letter));
    expect(vowels).toBeGreaterThanOrEqual(MIN_VOWELS);
  });
});

describe("round and multiplier rules", () => {
  it("advancing round does not reshuffle or refresh board (letters and gems unchanged)", () => {
    const room = makeRoom();
    const game = room.game!;
    const snapshot = game.tiles.map((t) => ({
      id: t.id,
      letter: t.letter,
      hasGem: t.hasGem
    }));

    advanceRound(room);

    const next = game.tiles.map((t) => ({
      id: t.id,
      letter: t.letter,
      hasGem: t.hasGem
    }));

    expect(next).toEqual(snapshot);
  });

  it("advancing round moves the 2W word multiplier to a new position", () => {
    const room = makeRoom();
    const game = room.game!;
    game.wordMultiplierEnabled = true;
    advanceRound(room);
    const firstId = game.roundWordTileId;
    advanceRound(room);
    expect(game.roundWordTileId).toBeDefined();
    if (firstId && game.roundWordTileId && game.tiles.length > 1) {
      expect(game.roundWordTileId).not.toBe(firstId);
    }
  });

  it("shuffling board keeps the 2W word multiplier position", () => {
    const room = makeRoom();
    const game = room.game!;
    game.wordMultiplierEnabled = true;
    advanceRound(room); // set an initial word multiplier
    const beforeId = game.roundWordTileId;
    const playerId = room.players[0].id;
    game.tiles.forEach((t) => (t.hasGem = true)); // ensure shuffle is allowed by gems
    const shuffleResult = shuffleBoard(room, playerId);
    expect(shuffleResult.success).toBe(true);
    expect(game.roundWordTileId).toBe(beforeId);
    const vowels = countVowels(game.tiles.map((t) => t.letter));
    expect(vowels).toBeGreaterThan(0); // sanity check board still valid
  });

  it("reconnecting a player should not move letter multiplier tiles", () => {
    const room = makeRoom();
    const game = room.game!;
    advanceRound(room); // enable multipliers and assign letter multiplier
    const beforeMultiplierIds = game.tiles
      .filter((t) => t.multiplier !== "none")
      .map((t) => t.id)
      .sort();
    expect(beforeMultiplierIds.length).toBeGreaterThan(0);

    // Simulate a reconnect snapshot and ensure multiplier ids are preserved.
    const snapshot = toPublicGameState(game)!;
    const afterMultiplierIds = snapshot.tiles
      .filter((t) => t.multiplier !== "none")
      .map((t) => t.id)
      .sort();

    expect(afterMultiplierIds).toEqual(beforeMultiplierIds);
  });

  it("using swap should not move letter multiplier tiles (currently failing)", () => {
    const room = makeRoom();
    const game = room.game!;
    advanceRound(room); // enable multipliers
    const player = room.players[0];
    player.gems = 5;

    const beforeMultiplierIds = game.tiles
      .filter((t) => t.multiplier !== "none")
      .map((t) => t.id)
      .sort();
    expect(beforeMultiplierIds.length).toBeGreaterThan(0);

    // enter swap mode then apply swap on a non-multiplier tile
    requestSwapMode(room, player.id);
    const target = game.tiles.find((t) => t.multiplier === "none") ?? game.tiles[0];
    applySwap(room, player.id, target.id, "Z");

    const afterMultiplierIds = game.tiles
      .filter((t) => t.multiplier !== "none")
      .map((t) => t.id)
      .sort();

    expect(afterMultiplierIds).toEqual(beforeMultiplierIds);
  });

  it("swapping a tile keeps all multipliers unchanged (letter + word)", () => {
    const room = makeRoom();
    const game = room.game!;
    advanceRound(room); // enable/assign multipliers
    const player = room.players[0];
    player.gems = 5;

    const beforeMultipliers = new Map(game.tiles.map((t) => [t.id, t.multiplier]));
    const beforeWordId = game.roundWordTileId;

    requestSwapMode(room, player.id);
    const target = game.tiles.find((t) => t.multiplier === "none") ?? game.tiles[0];
    applySwap(room, player.id, target.id, "Z");

    const afterMultipliers = new Map(game.tiles.map((t) => [t.id, t.multiplier]));
    expect(afterMultipliers).toEqual(beforeMultipliers);
    expect(game.roundWordTileId).toBe(beforeWordId);
  });
});

describe("gems and turn edge cases", () => {
  it("gems are topped off after submitting a word", () => {
    const room = makeRoom();
    const game = room.game!;
    // force an easy word
    const ids = ["0-0", "1-0", "2-0"];
    game.tiles.forEach((tile) => {
      if (tile.id === "0-0") tile.letter = "C";
      if (tile.id === "1-0") tile.letter = "A";
      if (tile.id === "2-0") tile.letter = "T";
      tile.hasGem = false;
    });
    const dict = new Set(["CAT"]);
    const result = submitWord(room, "p1", ids, dict);
    expect(result.success).toBe(true);
    const gemCount = game.tiles.filter((t) => t.hasGem).length;
    expect(gemCount).toBeGreaterThan(0);
  });

  it("when last player of round leaves, game advances to next round automatically", () => {
    const room = makeRoom();
    const game = room.game!;
    game.round = 1;
    game.totalRounds = 3;
    game.currentPlayerIndex = room.players.length - 1;
    const leavingPlayer = room.players[room.players.length - 1];
    leavingPlayer.isSpectator = true;

    // simulate advanceTurn call behavior when last player leaves
    advanceRound(room);

    expect(game.round).toBe(2);
  });
});
