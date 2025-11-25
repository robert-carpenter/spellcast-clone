# Spellcast Clone

A multiplayer and offline word-building game inspired by Boggle/Scrabble mechanics. Players spell words on a 5x5 board, earn points, collect gems, and use power-ups. The project includes a Three.js-powered board, custom animations, Discord OAuth login, and a Vite-powered client/server build.

## Features

- **Game Modes**: Offline play or hosted multiplayer rooms with round-based turns.
- **Board Mechanics**: 5x5 board with letter bag distribution, gems, letter multipliers, and rotating double-word (2W) tile per round.
- **Power-ups**: Shuffle (costs 1 gem) and Swap Letter (costs 3 gems).
- **Animations**: Submission word draw animation with stroke-drawn letters, sparkles, underline reveal, and fly-off to the scoring player.
- **UI Theme**: Bright blue/yellow theme with wizard background, responsive scaling, and themed modals/menus.
- **Discord OAuth**: Optional login that auto-fills player name and bypasses name prompts; session persistence with login/logout.
- **Dictionary Search**: In-game modal to search dictionary entries (min 2 chars).
- **Kicking/Skipping**: Host-only kick and skip-turn controls with confirmation modals.

## Tech Stack

- **Client**: TypeScript, Vite, Three.js, GSAP for animations, FontAwesome icons, CSS custom theme.
- **Server**: Node/Express (Vite SSR build), Socket.io for realtime multiplayer, dotenv for config.

## Getting Started

### Prerequisites

- Node.js 18+
- npm

### Install

```bash
npm install
```

### Development

```bash
npm run dev         # start Vite client dev server
npm run dev -- --host  # if you need LAN access
```

Server-side code is built via `npm run build:server` (see Build below) but during dev you typically run the client dev server and the socket/express server together if you have a dev script; otherwise use `npm run dev` for client and a separate node process for the server entry if configured.

### Build

```bash
npm run build          # builds client and server
npm run build:client   # client only
npm run build:server   # server only
```

### Run Production Build

```bash
npm run start   # serves dist/server/index.mjs (after build)
```

## Configuration

Environment variables (example `.env`):

```
SESSION_SECRET=change-me
DISCORD_CLIENT_ID=your_discord_client_id
DISCORD_CLIENT_SECRET=your_discord_client_secret
DISCORD_REDIRECT_URI=http://localhost:3000/auth/discord/callback
BASE_URL=http://localhost:3000
```

Notes:
- `SESSION_SECRET` should be a strong random string.
- Discord values are required only if using OAuth login.

## Project Structure

- `src/main.ts` – Client entry; UI/menu flow, auth, session handling.
- `src/game/SpellcastGame.ts` – Core client game logic, rendering, animations, modals.
- `src/game/WordBoard.ts` – Three.js board representation; tile bag logic, multipliers, vowels, refreshes.
- `src/server/server.ts` – Express server, socket wiring, Discord OAuth routes.
- `src/server/gameState.ts` – Server game rules, turn/round handling, scoring, letter bag, multipliers.
- `src/shared` – Shared types/constants between client and server.
- `src/style.css` – Global styles/theme and animation styling.
- `docs/` – Planning docs (Discord OAuth, multiplayer, build plan).

## Gameplay Notes

- **Rounds & Multipliers**: Letter multipliers unlock after Round 1; 2W tile appears from Round 2 and repositions each round. Board state is retained between rounds (no shuffle/refresh), only the 2W tile moves.
- **Vowels**: Letter bag enforces distribution; refresh logic tops up vowels to the minimum target.
- **Power-ups**: Shuffle preserves multipliers/gems and repositions letters; Swap lets you pick a letter at the cost of gems.

## Controls & UI

- **Submitting Words**: Select adjacent tiles; valid words score and trigger the draw animation.
- **Power-ups**: Buttons in the power panel (Shuffle, Swap Letter).
- **Modals**: Leave game, activity log, dictionary search, kick/skip confirmation, removed-from-game notification.
- **Auth**: Login/Logout with Discord when configured; shows session tag in the main menu.

## Deployment

- Build with `npm run build`.
- Set env vars in your hosting platform (e.g., Railway) for server-side values and Discord OAuth.
- Serve `dist/server/index.mjs` with Node; client assets live in `dist/client`.

## Testing Tips

- Verify vowel distribution after round advance (board retained, 2W moves).
- Check shuffle and swap power-ups adjust gems correctly.
- Test Discord login flow (login/logout, auto name, bypass name prompt).
- Multiplayer: ensure host kick/skip works and modals display; spectators handled correctly.
- Animations: submission stroke draw, underline reveal, dot sparkles, fly-off to player card.

## License

This project is provided without an explicit license; treat as all rights reserved unless a license is added.
