import { describe, it, expect, beforeEach } from "vitest";
import { OfflineAdapter } from "../../src/game/offlineAdapter.js";
import { MIN_VOWELS, VOWELS } from "../../src/shared/constants.js";

const makeAdapter = () =>
  new OfflineAdapter({
    totalRounds: 3,
    rng: () => 0.5 // deterministic-ish
  });

const countVowels = (letters: string[]) =>
  letters.reduce((count, letter) => count + (VOWELS.includes(letter.toUpperCase()) ? 1 : 0), 0);

describe("OfflineAdapter + shared rules", () => {
  let adapter: OfflineAdapter;

  beforeEach(() => {
    adapter = makeAdapter();
    adapter.seedPlayers([
      { id: "p1", name: "One", isHost: true },
      { id: "p2", name: "Two", isHost: false }
    ]);
  });

  it("creates initial snapshot with minimum vowels", () => {
    const snap = adapter.snapshot();
    expect(snap).toBeDefined();
    const vowels = countVowels((snap?.tiles ?? []).map((t) => t.letter));
    expect(vowels).toBeGreaterThanOrEqual(MIN_VOWELS);
  });

  it("submitWord updates snapshot and advances turn", () => {
    const dict = new Set(["CAT"]);
    const snap = adapter.snapshot()!;
    const ids = ["0-0", "1-0", "2-0"];
    snap.tiles.forEach((tile) => {
      if (tile.id === "0-0") tile.letter = "C";
      if (tile.id === "1-0") tile.letter = "A";
      if (tile.id === "2-0") tile.letter = "T";
    });
    adapter.room.game = { ...adapter.room.game!, ...snap };

    const result = adapter.submitWord("p1", ids, dict);
    expect(result?.success).toBe(true);
    const next = adapter.snapshot()!;
    expect(next.currentPlayerIndex).toBe(1);
    const vowels = countVowels(next.tiles.map((t) => t.letter));
    expect(vowels).toBeGreaterThanOrEqual(MIN_VOWELS);
  });

  it("shuffle keeps 2W position stable", () => {
    const snap = adapter.snapshot()!;
    const initialId = snap.roundWordTileId;
    const result = adapter.shuffle("p1");
    expect(result?.success).toBe(true);
    const next = adapter.snapshot()!;
    if (initialId) {
      expect(next.roundWordTileId).toBe(initialId);
    }
  });

  it("advanceRound moves 2W to a new position", () => {
    adapter.advanceRound();
    const first = adapter.snapshot()!.roundWordTileId;
    adapter.advanceRound();
    const second = adapter.snapshot()!.roundWordTileId;
    if (first && second && adapter.getTiles().length > 1) {
      expect(second).not.toBe(first);
    }
  });
});
