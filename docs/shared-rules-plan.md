# Shared Rules Refactor Plan

Goal: Make offline and multiplayer use the same authoritative game logic so we avoid duplicating fixes and can test rules once. Keep rendering/UI separate.

## Phase 1: Extract Rules to Shared Module
- Create a shared rules module (e.g., `src/shared/rules.ts`) that exports:
  - `createGameState`, `advanceTurn`, `advanceRound`
  - `submitWord`, `shuffleBoard`, `requestSwapMode`/`applySwap` (if kept)
  - Helpers: `topUpGems`, `ensureMinimumVowels`, multipliers, 2W selection.
- Make RNG injectable (e.g., `rng?: () => number`) for determinism in tests.
- Use shared types (`GameSnapshot` plus internal fields) in this module.
- Leave server transport/UI untouched; just re-export rules from server for now.

## Phase 2: Server Uses Shared Rules
- Replace server `gameState.ts` logic with calls to the shared rules module.
- Keep server-specific concerns (sockets, auth) in server files; no rule changes there.
- Ensure state shape matches existing snapshots (`roundWordTileId`, `turnStartedAt`, etc.).

## Phase 3: Offline Uses Shared Rules
- Update `SpellcastGame` to call the shared rules instead of bespoke client-side logic:
  - On submit: call `submitWord` from shared rules, then apply returned state to `WordBoard`.
  - On advance round/turn: use shared `advanceRound`/`advanceTurn`.
  - On shuffle/swap: use shared functions.
- Keep `WordBoard` purely a renderer/state reflector (and bag tracker) if possible; avoid duplicating rule enforcement.

### Detailed sub-steps for Phase 3
1) Add a small offline adapter in `SpellcastGame` that owns a local `Room`/`GameState` and delegates to shared rules for:
   - `createInitialGameState` when starting offline
   - `submitWord`, `shuffleBoard`, `applySwap`/`requestSwapMode` (if used), `advanceTurn`, `advanceRound`
2) Map shared-rule state to the UI:
   - Apply tile updates to `WordBoard` (letters, gems, multipliers, wordMultiplier tile)
   - Sync player scores/gems/lastWord, round/turn, lastSubmission, log
   - Keep rendering/selection/animations in `SpellcastGame`/`WordBoard`
   - Instantiate the offline adapter in `SpellcastGame` constructor when not multiplayer and hydrate the board/UI from its snapshot
3) Replace offline handlers to call the adapter instead of bespoke logic:
   - `onSubmitWord`, `onShuffle`, `onSwap`/`onSwapTile`, turn advancement
   - Remove redundant client-side scoring/vowel/multiplier logic once adapter drives state
4) Determinism hooks:
   - Allow injecting RNG into the adapter for offline tests (e.g., wrap Math.random during calls); keep Math.random default for runtime
5) Add offline tests using shared rules:
   - Simulate offline submit/shuffle/advance and assert state matches expectations and `WordBoard`-compatible structure

## Phase 4: Tests and Determinism
- Add/expand Vitest coverage to shared rules (already started for server rules):
  - Vowel minimums, multipliers, scoring, gems, shuffle, 2W movement, round advance.
  - Deterministic RNG in tests (stub `Math.random` or pass rng).
- Add a few integration-style tests for offline usage: simulate submit/shuffle/advance with shared rules and assert `WordBoard`-compatible state.

## Phase 5: Cleanup and Docs
- Update README to note shared rules architecture and testing approach.
- Remove redundant logic from client/server once both rely on the shared rules module.
- Optional: expose a small façade to keep API stable if future UI layers change.
