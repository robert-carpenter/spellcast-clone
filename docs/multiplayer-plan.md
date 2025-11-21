## Multiplayer Implementation Plan

### Phase 1 – Architecture & Server Scaffold _(completed)_
1. ✅ Stand up Node.js + Express + TypeScript server with in-memory room store.
2. ✅ Define `Room`/`Player` models including host tracking, gem/score defaults, and room status (`lobby`/`in-progress`).
3. ✅ Expose REST endpoints:
   - `POST /api/rooms` – create room, return host player + snapshot.
   - `POST /api/rooms/:roomId/join` – join existing room with validation and capacity checks.
   - `GET /api/rooms/:roomId` – fetch current room snapshot.
   - `POST /api/rooms/:roomId/start` – host-only transition from lobby to in-progress.
   - `DELETE /api/rooms/:roomId/players/:playerId` – allow players to leave (host reassignment handled).
4. ✅ Utility helpers implemented (room ID generator, UUID usage, request validation).

### Phase 2 – Client Integration _(completed)_
1. ✅ New landing/menu flow: Play Online/Offline split, create & join forms, and lobby UI with shareable link + player list.
2. ✅ URL deep-links (`/room/:id`) auto-populate the join form and update browser history when rooms are created.
3. ✅ Game instantiation consumes server-provided `InitialRoomState`; player list stayed synced via periodic polling.
4. ✅ Local storage keeps name and room/player IDs for smoother reconnects; offline mode remains available in parallel.

### Phase 3 – Real-Time Sync _(completed)_
1. ✅ Socket.IO server added; clients authenticate via room/player IDs and receive live `room:update` snapshots.
2. ✅ Player join/leave/start events broadcast instantly; lobby UI and in-game player list update as soon as changes land.
3. ✅ Disconnect/reconnect handling with a grace window, host reassignment on leave, and UI connection notices for outages.

### Phase 4 – Gameplay Synchronization
1. Move board actions (word submission, power-ups, swaps) to server authority.
2. Ensure rounds, timers, and logs are synchronized and validated server-side.
3. Implement host-only abilities (kick, lock room, reset).

### Phase 5 – UX Enhancements
1. Connection status indicators, room capacity feedback, error handling.
2. Persist and display activity log from server.
3. Support spectator/observer mode (optional).

### Phase 6 – Deployment & Monitoring
1. Choose hosting (Render/Heroku/Vercel + WebSocket support).
2. Add logging/metrics, health checks, and persistence strategy (Redis/DB) if needed.
