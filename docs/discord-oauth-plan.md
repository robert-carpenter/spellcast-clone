## Discord OAuth Integration Plan

### Backend
- Register a Discord application (OAuth2): get client ID/secret; set redirect URI to `/auth/discord/callback`.
- Add env vars: `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_REDIRECT_URI`, optional `SESSION_SECRET`.
- Endpoints:
  - `GET /auth/discord/login` – redirects to Discord authorize with scope `identify`, state, and PKCE or random anti-CSRF token.
  - `GET /auth/discord/callback` – exchange `code` for token, fetch `https://discord.com/api/users/@me`, derive display name (username or global_name), create a signed session (HTTP-only secure cookie) with `{ id, name, avatar? }`.
  - `GET /auth/session` – returns session user info if cookie valid; else 401.
  - `POST /auth/logout` – clears the session cookie.
- Session handling: sign cookies (HMAC/JWT) with `SESSION_SECRET`; set `SameSite=Lax`, `Secure` in production.
- Error handling: on OAuth errors, redirect to main page with an error query param.

### Frontend (landing/main menu)
- On load, call `/auth/session`; if authenticated, store `sessionUser` and skip Create/Join name inputs (hide or pre-fill and auto-advance).
- Add “Login with Discord” button on the main menu; clicking hits `/auth/discord/login`.
- If `sessionUser` exists:
  - Hide name fields on Create/Join views; auto-fill player name from session.
  - Skip straight to lobby/join flow (use stored room code if present).
  - Show logged-in badge (avatar/username) and a logout button calling `/auth/logout`.
- Persist session state in memory; rely on HTTP-only cookie for auth; no localStorage needed.

### Game flows
- When creating/joining rooms, use the session username as the player name; prevent overriding with manual input if logged in.
- Handle reconnect: on room join/resume, re-check session; if missing, prompt re-login or fallback to manual name entry.
- Spectators: unchanged; host detection still based on room.hostId.

### Security/UX
- Use state/nonce for CSRF on the OAuth flow.
- Keep scopes minimal (`identify`).
- Show errors gracefully if the OAuth callback fails; offer retry/login/logout.

### Implementation order
1) Backend routes + session cookie signing + `/auth/session` + `/auth/logout`.
2) Frontend session check + login button + logout + hide/auto-fill name inputs.
3) Wire session name into create/join requests.
4) Polish UI (badge, error toasts) and test end-to-end.
