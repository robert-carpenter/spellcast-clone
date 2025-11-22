## Unified "Single Src" Build Plan

Goal: serve everything (frontend assets, APIs, WebSockets) from a single Vite-powered server in dev and prod. During development, we run only the Vite dev server (middleware mode) so HMR, SPA assets, and backend routes all come from the same port. For production, a single Node entry produced by Vite serves the prerendered client bundle plus all backend logic.

### Phase 0 - Pre-work & Constraints ✅
*Decisions locked in:*
1. **Middleware-only runtime:** Development will rely solely on Vite’s middleware/server mode. Express/Socket.IO hooks will be registered via a Vite plugin so the dev server owns the entire port/HMR lifecycle.
2. **Single SSR entry for prod:** Production builds will emit a Node entry via `vite build --ssr src/server/index.ts` (exact path to be finalized during Phase 2). That server bundle will import/serve the prerendered SPA from `dist/client`, so only one Node process is required in production.

Action items for later phases now reference these decisions.

### Phase 1 - Repo Restructuring ✅
*Completed:*
1. Added `src/server` and moved all server sources (`server.ts`, `gameState.ts`, `types.ts`, shims, etc.) from `server/src` into this new folder.
2. Relocated the old root-level `shared/` typings into `src/shared` so both client and server now import via `../shared/...`.
3. Updated TypeScript configs and import paths to reflect the new structure (client `tsconfig.json` now includes only `src`, server `tsconfig.json` targets `../src/server` + `../src/shared`).

### Phase 2 - Tooling Consolidation ✅
*Completed:*
1. Added a root-level `tsconfig.server.json` (NodeNext config) and retired the old `server/tsconfig.json`.
2. Created `vite.server.config.ts` so `vite build --config vite.server.config.ts --ssr src/server/server.ts` emits `dist/server/index.mjs`.
3. Consolidated scripts/dependencies into the root `package.json`:
   - `npm run build:client` → `vite build`
   - `npm run build:server` → `vite build --config vite.server.config.ts`
   - `npm run build` runs both, and `npm run start` now executes `node dist/server/index.mjs`.

### Phase 3 - Unified Dev Workflow ✅
*Completed:*
1. Updated `vite.config.ts` to include a `spellcast-backend` plugin (`apply: "serve"`). This plugin spins up our Express backend inside Vite’s middleware stack and attaches Socket.IO to Vite’s HTTP server, so `npm run dev` now launches a single port with both HMR and backend routes.
2. Refactored `src/server/server.ts` to export `initializeBackend(app, httpServer)` which registers all REST routes and Socket.IO handlers without binding its own port. When executed directly (in the production bundle), it still creates its own Express/HTTP server.
3. Dev workflow: `npm run dev` (Vite) now serves both client and backend; HMR continues to work automatically because everything sits behind the Vite server.

### Phase 4 - Production Build & Deployment ✅
*Completed:*
1. `npm run build` now produces two outputs:
   - `dist/client` via the standard Vite build (configured `outDir: dist/client`).
   - `dist/server/index.mjs` via `vite build --config vite.server.config.ts`.
2. The backend bundle serves `dist/client` automatically (refined `registerHttpRoutes`), and dictionary loading now checks the new dist paths.
3. Dockerfile simplified to a two-stage build using the root scripts only:
   - Build stage runs `npm run build`.
   - Runtime stage installs prod deps once, copies `dist/` and the dictionary, then runs `node dist/server/index.mjs`.

### Phase 5 - Cleanup & Validation ✅
*Completed:*
1. Legacy `/server` sources are now fully under `src/server` and `src/shared`; old configs/scripts were removed.
2. Documentation reflects the single-command workflow (this plan + package scripts). Dockerfile and build scripts now describe the unified build clearly.
3. Verified both `npm run dev` (Vite-only dev server) and `npm run build && npm run start` (single Node runtime) to ensure parity with the earlier workflow before redeploying.

### Optional Enhancements
1. Use environment-aware server entry so the same file can run dev (middleware) and prod (static) modes.
2. Integrate ESLint/Prettier and type checking across the unified tree.
3. Add integration tests covering key API endpoints and frontend flows to catch regressions early.
