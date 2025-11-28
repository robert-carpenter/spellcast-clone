import { describe, it, expect } from "vitest";
import { LETTER_VALUES } from "../../src/shared/constants.js";
import {
  createInitialGameState,
  submitWord,
  advanceTurn
} from "../../src/shared/rules.js";
import type { Room } from "../../src/shared/rules.js";

const makeRoom = (): Room => ({
  id: "room-rules",
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
    }
  ],
  game: createInitialGameState()
});

describe("Shared rules scoring and turn flow", () => {
  it("scores a word with multipliers and advances turn", () => {
    const room = makeRoom();
    const game = room.game!;

    // Set up a word with a double-letter and double-word
    const ids = ["0-0", "1-0", "2-0"];
    game.tiles.forEach((tile) => {
      if (tile.id === "0-0") {
        tile.letter = "C";
        tile.multiplier = "doubleLetter";
      }
      if (tile.id === "1-0") {
        tile.letter = "A";
      }
      if (tile.id === "2-0") {
        tile.letter = "T";
        tile.wordMultiplier = "doubleWord";
      }
    });

    const dict = new Set(["CAT"]);
    const result = submitWord(room, "p1", ids, dict);
    expect(result.success).toBe(true);

    const base =
      LETTER_VALUES.c * 2 + // double letter on C
      LETTER_VALUES.a +
      LETTER_VALUES.t;
    const expectedScore = base * 2; // double word

    expect(room.players[0].score).toBe(expectedScore);
    expect(room.game?.currentPlayerIndex).toBe(0); // only one player, still 0
  });

  it("advances round when turn wraps and leaves board intact", () => {
    const room = makeRoom();
    const game = room.game!;
    const snapshot = game.tiles.map((t) => t.letter + t.hasGem);
    advanceTurn(room);
    expect(game.round).toBe(2); // wrap immediately with single player
    game.currentPlayerIndex = 0;
    advanceTurn(room);
    expect(game.round).toBe(3);
    const after = game.tiles.map((t) => t.letter + t.hasGem);
    expect(after).toEqual(snapshot);
  });
});
