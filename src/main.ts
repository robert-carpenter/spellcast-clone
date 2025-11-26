import "./style.css";
import { SpellcastGame, InitialRoomState, MultiplayerController } from "./game/SpellcastGame";
import dictionaryRaw from "./game/dictionary.txt?raw";
import logoUrl from "./assets/logo.png";
import {
  createRoom,
  joinRoom,
  startRoom,
  leaveRoom,
  getRoom,
  CreateRoomResponse,
  JoinRoomResponse,
  RoomDTO,
  updateRoomRounds
} from "./network/api";
import { connectRoomSocket, RoomSocket } from "./network/socket";
import { soundManager } from "./audio/SoundManager";

type RoomStatus = RoomDTO["status"];

const app = document.querySelector<HTMLDivElement>("#app")!;

const BASE_APP_WIDTH = 1100;
const BASE_APP_HEIGHT = 620;

function updateAppScale() {
  const shell = document.querySelector<HTMLElement>(".app-viewport");
  if (!shell) return;
  const availableWidth = window.innerWidth - 24;
  const availableHeight = window.innerHeight - 24;
  const scale = Math.min(
    availableWidth / BASE_APP_WIDTH,
    availableHeight / BASE_APP_HEIGHT,
    1
  );
  document.documentElement.style.setProperty("--app-scale", scale.toString());
}

updateAppScale();
window.addEventListener("resize", updateAppScale);

const dictionary = new Set(
  dictionaryRaw
    .split(/\r?\n/)
    .map((word) => word.trim().toUpperCase())
    .filter(Boolean)
);

const TRANSITION_MS = 350;


const BASE_PATH = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");
const HOME_PATH = BASE_PATH || "/";
soundManager.enableAutoUnlock();

const STORAGE_KEYS = {
  name: "spellcast:name",
  room: "spellcast:roomId",
  player: "spellcast:playerId"
} as const;

setGameVisibility(false);
document.body.classList.add("fresh-load");
document.body.classList.add("app-ready");
window.setTimeout(() => document.body.classList.add("landing-ready"), 0);
requestAnimationFrame(() => {
  document.body.classList.remove("fresh-load");
});

const existingRoomFromPath = detectRoomIdFromLocation();
const isDebugMode = import.meta.env.DEV && window.location.pathname.endsWith("/debug");
let kickHandler: ((playerId: string) => void) | null = null;
const landing = createLandingOverlay({
  initialName: loadStoredName(),
  initialRoom: existingRoomFromPath ?? ""
});

landing.loginBtn.addEventListener("click", () => {
  window.location.href = "/auth/discord/login";
});

landing.logoutBtn.addEventListener("click", async () => {
  try {
    await fetch("/auth/logout", { method: "POST", credentials: "include" });
  } catch {
    // ignore
  }
  sessionUser = null;
  applySessionUi();
});

landing.joinWithCodeBtn.addEventListener("click", () => {
  if (!sessionUser?.name) {
    landing.setMessage("Login first to join with code.", "error");
    return;
  }
  landing.joinNameInput.value = sessionUser.name;
  landing.joinNameLabel.style.display = "none";
  landing.joinNameInput.style.display = "none";
  landing.joinRoomInput.value = "";
  landing.showView("join");
  landing.setMessage("");
});

fetchSession()
  .then(() => {
    applySessionUi();
  })
  .catch(() => {
    applySessionUi();
  });

handleAuthQueryParam();
landing.setKickHandler((playerId) => {
  handleKickPlayer(playerId).catch((err) => console.error(err));
});

landing.onRoundsChange((rounds) => {
  if (!lobbyContext || !lobbyContext.isHost) return;
  const resolved = Number(rounds);
  if (!Number.isFinite(resolved)) return;
  if (latestRoomSnapshot?.rounds === resolved) return;
  landing.setRoundsBusy(true);
  updateRoomRounds(lobbyContext.roomId, lobbyContext.playerId, resolved)
    .catch((error) => {
      const message = error instanceof Error ? error.message : "Unable to update rounds.";
      landing.setMessage(message, "error");
      landing.setRoundSelection(latestRoomSnapshot?.rounds ?? 5);
    })
    .finally(() => landing.setRoundsBusy(false));
});

const storedSession = loadStoredSession();
const inviteOverridesSession =
  storedSession && existingRoomFromPath && storedSession.roomId !== existingRoomFromPath
    ? storedSession
    : null;

if (inviteOverridesSession) {
  void leaveStoredSessionForInvite(inviteOverridesSession);
}

if (storedSession && !inviteOverridesSession) {
  resumeStoredSession(storedSession).catch((err) => console.warn("Resume failed", err));
}

const connectionNotice = createConnectionNotice();

let game: SpellcastGame | null = null;
let roomSocket: RoomSocket | null = null;
let multiplayerBridge: MultiplayerController | null = null;
let lobbyContext:
  | {
      roomId: string;
      playerId: string;
      isHost: boolean;
    }
  | null = null;
let latestRoomSnapshot: RoomDTO | null = null;
let hasEnteredGame = false;
let knownPlayerIds = new Set<string>();
let hasPlayerSnapshot = false;
let lastRoomStatus: RoomStatus | null = null;
let isHandlingKick = false;
let kickedModal: HTMLDivElement | null = null;
let kickedCheckInFlight = false;
let isLeavingRoom = false;
let suppressNextKickNotice = false;
let sessionUser: { id: string; name: string } | null = null;

async function fetchSession() {
  try {
    const res = await fetch("/auth/session", { credentials: "include" });
    if (!res.ok) {
      sessionUser = null;
      return;
    }
    const data = (await res.json()) as { authenticated: boolean; user?: { id: string; name: string } };
    if (data.authenticated && data.user) {
      sessionUser = data.user;
      saveName(data.user.name);
    } else {
      sessionUser = null;
    }
  } catch {
    sessionUser = null;
  }
}

function applySessionUi() {
  if (!landing) return;
  const hasSession = Boolean(sessionUser);
  const name = sessionUser?.name ?? "";
  if (hasSession) {
    landing.createNameLabel.style.display = "none";
    landing.createNameInput.style.display = "none";
    landing.joinNameLabel.style.display = "none";
    landing.joinNameInput.style.display = "none";
    landing.createNameInput.value = name;
    landing.joinNameInput.value = name;
    landing.sessionTag.style.display = "block";
    landing.sessionTag.textContent = `Logged in as ${name}`;
    landing.loginBtn.style.display = "none";
    landing.logoutBtn.style.display = "inline-block";
    landing.joinWithCodeBtn.style.display = "inline-block";
  } else {
    landing.createNameLabel.style.display = "";
    landing.createNameInput.style.display = "";
    landing.joinNameLabel.style.display = "";
    landing.joinNameInput.style.display = "";
    landing.sessionTag.style.display = "none";
    landing.loginBtn.style.display = "inline-block";
    landing.logoutBtn.style.display = "none";
    landing.joinWithCodeBtn.style.display = "none";
  }
}

function setGameVisibility(active: boolean) {
  document.body.classList.toggle("in-game", active);
}

function showLandingAfterFade(view: LandingView, message = "", tone: "info" | "error" = "info", after?: () => void) {
  window.setTimeout(() => {
    landing.showView(view);
    landing.show();
    if (message !== undefined) {
      landing.setMessage(message, tone);
    }
    after?.();
  }, TRANSITION_MS);
}

landing.playOnlineBtn.addEventListener("click", () => {
  if (sessionUser?.name) {
    handleCreateRoom(sessionUser.name).catch((err) => console.error(err));
    return;
  }
  landing.showView("create");
  landing.setMessage("");
});

landing.playOfflineBtn.addEventListener("click", () => {
  const name = landing.createNameInput.value.trim();
  if (name) saveName(name);
  clearRoomSession();
  disconnectRealtime();
  setAppPath(buildOfflinePath(), true);
  landing.transitionOut(() => {
    startSpellcast();
  });
});

landing.createBackBtn.addEventListener("click", () => {
  landing.showView("menu");
  landing.setMessage("");
});

landing.createToJoinBtn.addEventListener("click", () => {
  landing.showView("join");
  landing.setMessage("");
});

landing.joinBackBtn.addEventListener("click", () => {
  landing.showView("menu");
  landing.setMessage("");
  setAppPath(HOME_PATH, true);
});

landing.createBtn.addEventListener("click", () => {
  const name = sessionUser?.name ?? landing.createNameInput.value.trim();
  if (!name) {
    landing.setMessage("Enter a display name.", "error");
    return;
  }
  handleCreateRoom(name).catch((err) => console.error(err));
});

landing.joinBtn.addEventListener("click", () => {
  const name = sessionUser?.name ?? landing.joinNameInput.value.trim();
  const code = landing.joinRoomInput.value.trim().toUpperCase();
  if (!name) {
    landing.setMessage("Enter your name to join.", "error");
    return;
  }
  if (!code) {
    landing.setMessage("Enter a room code.", "error");
    return;
  }
  handleJoinRoom(name, code).catch((err) => console.error(err));
});

landing.lobbyLeaveBtn.addEventListener("click", () => {
  if (!lobbyContext) {
    landing.showView("menu");
    landing.setMessage("");
    return;
  }
  leaveCurrentRoom().catch((err) => console.error(err));
});

landing.lobbyStartBtn.addEventListener("click", () => {
  if (!lobbyContext) return;
  if (!lobbyContext.isHost) return;
  landing.setLobbyStarting(true);
  startRoom(lobbyContext.roomId, lobbyContext.playerId)
    .then(({ room }) => {
      handleRoomUpdate(room);
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : "Unable to start room.";
      landing.setMessage(message, "error");
    })
    .finally(() => landing.setLobbyStarting(false));
});

const relativePath = getRelativePath().toLowerCase();
const isOfflineRoute = relativePath === "/offline";
const isDebugRoute = isDebugMode && relativePath === "/debug";
if (isOfflineRoute) {
  landing.hide();
  startSpellcast();
  setAppPath(buildOfflinePath(), true);
} else if (isDebugRoute) {
  landing.hide();
  startSpellcast();
  setupDebugPanel();
  setAppPath(buildDebugPath(), true);
} else if (existingRoomFromPath) {
  landing.showView("join");
  landing.joinRoomInput.value = existingRoomFromPath;
  landing.setMessage(`Joining room ${existingRoomFromPath}.`, "info");
} else {
  landing.showView("menu");
  setAppPath(HOME_PATH, true);
}

async function handleCreateRoom(name: string) {
  landing.setBusy(true, "Creating room...");
  try {
    const response = await createRoom(name);
    saveName(name);
    handleRoomEntry(response, false);
  } catch (error) {
    landing.setMessage(
      error instanceof Error ? error.message : "Failed to create room.",
      "error"
    );
    throw error;
  } finally {
    landing.setBusy(false);
  }
}

async function handleJoinRoom(name: string, roomCode: string) {
  landing.setBusy(true, "Joining room...");
  try {
    const response = await joinRoom(roomCode, name);
    saveName(name);
    handleRoomEntry(response, true);
  } catch (error) {
    landing.setMessage(
      error instanceof Error ? error.message : "Failed to join room.",
      "error"
    );
    throw error;
  } finally {
    landing.setBusy(false);
  }
}

function handleRoomEntry(response: CreateRoomResponse | JoinRoomResponse, replacePath: boolean) {
  saveName(response.player.name);
  persistRoomSession(response.roomId, response.player.id);
  setAppPath(buildRoomPath(response.roomId), replacePath);
  setGameVisibility(false);
  lobbyContext = {
    roomId: response.roomId,
    playerId: response.player.id,
    isHost: response.player.id === response.room.hostId
  };
  hasEnteredGame = false;
  latestRoomSnapshot = response.room;
  landing.showView("lobby");
  if (response.room.status === "in-progress") {
    landing.setMessage("Game in progress - you'll spectate until next round.", "info");
  } else {
    landing.setMessage("");
  }
  renderLobby(response.room);
  connectRealtime(response.roomId, response.player.id);
}

async function leaveCurrentRoom() {
  if (!lobbyContext) return;
  isLeavingRoom = true;
  suppressNextKickNotice = true;
  landing.setBusy(true, "Leaving room...");
  try {
    await leaveRoom(lobbyContext.roomId, lobbyContext.playerId, lobbyContext.playerId);
  } catch (error) {
    console.warn("Failed to leave room", error);
  } finally {
    landing.setBusy(false);
    disconnectRealtime();
    latestRoomSnapshot = null;
    lobbyContext = null;
    multiplayerBridge = null;
    knownPlayerIds = new Set<string>();
    hasPlayerSnapshot = false;
    lastRoomStatus = null;
    isLeavingRoom = false;
    suppressNextKickNotice = false;
    clearRoomSession();
    hasEnteredGame = false;
    setAppPath(HOME_PATH, true);
    setGameVisibility(false);
    showLandingAfterFade("menu", "");
  }
}

async function handleKickPlayer(playerId: string) {
  if (!lobbyContext || !lobbyContext.isHost) return;
  if (playerId === lobbyContext.playerId) return;
  const targetName =
    latestRoomSnapshot?.players.find((player) => player.id === playerId)?.name ?? "player";
  const confirmed = window.confirm(`Remove ${targetName} from the room?`);
  if (!confirmed) return;
  landing.setBusy(true, `Removing ${targetName}...`);
  try {
    await leaveRoom(lobbyContext.roomId, playerId, lobbyContext.playerId);
    landing.setMessage(`${targetName} removed from the room.`, "info");
    window.setTimeout(() => landing.setMessage("", "info"), 1800);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to remove player.";
    landing.setMessage(message, "error");
  } finally {
    landing.setBusy(false);
  }
}

function connectRealtime(roomId: string, playerId: string) {
  disconnectRealtime();
  roomSocket = connectRoomSocket(roomId, playerId, {
    onRoomUpdate: (room) => handleRoomUpdate(room),
    onDisconnect: (reason) => {
      if (isHandlingKick) return;
      if (isLeavingRoom) return;
      if (reason === "io server disconnect") {
        void handleForcedRemoval();
        return;
      }
      if (reason !== "io client disconnect") {
        void checkIfKickedFallback().then((kicked) => {
          if (!kicked) {
            showConnectionNotice("Connection lost. Reconnecting…");
          }
        });
      }
    },
    onError: (message) => {
      landing.setMessage(message, "error");
      showConnectionNotice("Realtime connection error");
    },
    onGameError: (message) => {
      console.warn(message);
      showConnectionNotice(message);
      window.setTimeout(() => hideConnectionNotice(), 2500);
    },
    onSelection: (ownerId, tileIds) => {
      handleSelectionBroadcast(ownerId, tileIds);
    },
    onKicked: () => {
      if (suppressNextKickNotice) {
        suppressNextKickNotice = false;
        return;
      }
      void handleForcedRemoval();
    },
    onConnect: () => hideConnectionNotice(),
    onReconnect: () => hideConnectionNotice()
  });
  multiplayerBridge = createMultiplayerBridge(roomSocket, roomId, playerId);
}

function disconnectRealtime() {
  if (roomSocket) {
    roomSocket.removeAllListeners();
    roomSocket.disconnect();
    roomSocket = null;
  }
  hideConnectionNotice();
}

function handleRoomUpdate(room: RoomDTO) {
  const previousPlayerIds = new Set(knownPlayerIds);
  const freshPlayers = room.players.filter((player) => !previousPlayerIds.has(player.id));
  if (hasPlayerSnapshot && freshPlayers.length) {
    soundManager.play("player-join");
  }
  knownPlayerIds = new Set(room.players.map((player) => player.id));
  hasPlayerSnapshot = true;

  const currentLobby = lobbyContext;

  // Detect if we were removed from the room
  if (!isLeavingRoom && currentLobby && !room.players.some((player) => player.id === currentLobby.playerId)) {
    void handleForcedRemoval();
    return;
  }

  if (lastRoomStatus === "lobby" && room.status === "in-progress") {
    soundManager.play("game-start");
  }
  lastRoomStatus = room.status;

  latestRoomSnapshot = room;
  if (currentLobby) {
    currentLobby.isHost = room.hostId === currentLobby.playerId;
  }
  if (landing.isVisible() && landing.currentView === "lobby") {
    renderLobby(room);
    setGameVisibility(false);
  }
  if (room.status === "in-progress" && !hasEnteredGame) {
    enterGame(room);
  }
  if (hasEnteredGame && room.status === "lobby") {
    hasEnteredGame = false;
    setGameVisibility(false);
    showLandingAfterFade("lobby", "Game complete. Waiting for the host to start again.", "info", () => {
      renderLobby(room);
      if (game) {
        game.dispose();
        game = null;
        app.innerHTML = "";
      }
    });
  }
  if (hasEnteredGame) {
    updateGamePlayers(room);
    if (room.game && game) {
      game.applyGameSnapshot(room.game);
    }
  }
}

function handleSelectionBroadcast(playerId: string, tileIds: string[]) {
  game?.applyRemoteSelection(playerId, tileIds ?? []);
}

async function handleForcedRemoval() {
  if (isHandlingKick) return;
  isHandlingKick = true;
  await showKickedModal("You have been removed from the room.");
  disconnectRealtime();
  if (game) {
    game.dispose();
    game = null;
    app.innerHTML = "";
  }
  clearRoomSession();
  latestRoomSnapshot = null;
  lobbyContext = null;
  knownPlayerIds = new Set();
  hasPlayerSnapshot = false;
  hasEnteredGame = false;
  lastRoomStatus = null;
  setGameVisibility(false);
  showLandingAfterFade("menu", "You were removed from the room.", "error", () => {
    setAppPath(HOME_PATH, true);
    isHandlingKick = false;
  });
}

function renderLobby(room: RoomDTO) {
  if (!lobbyContext) return;
  const isHost = room.hostId === lobbyContext.playerId;
  lobbyContext.isHost = isHost;

  const players = room.players.map((player) => ({
    id: player.id,
    name: player.name,
    isHost: player.id === room.hostId,
    connected: player.connected,
    isSpectator: player.isSpectator ?? false,
    canKick:
      isHost &&
      lobbyContext?.playerId === room.hostId &&
      player.id !== lobbyContext.playerId &&
      room.status === "lobby"
  }));
  const activeCount = room.players.filter((player) => !player.isSpectator).length;
  const canStart = isHost && activeCount >= 1;
  const shareUrl = buildShareUrl(room.id);
  landing.updateLobby({
    roomCode: room.id,
    shareUrl,
    players,
    canStart,
    isHost,
    status: room.status,
    minPlayersMet: activeCount >= 1,
    rounds: room.rounds ?? 5,
    canEditRounds: isHost && room.status === "lobby"
  });
}

function enterGame(room: RoomDTO) {
  if (!lobbyContext) return;
  const initial = roomToInitialState(room, lobbyContext.playerId);
  landing.transitionOut(() => {
    hasEnteredGame = true;
    startSpellcast(initial, { multiplayer: multiplayerBridge ?? undefined });
    if (room.game && game) {
      game.applyGameSnapshot(room.game);
    }
  });
}

function roomToInitialState(room: RoomDTO, playerId: string): InitialRoomState {
  return {
    roomId: room.id,
    playerId,
    players: room.players.map((player) => ({
      id: player.id,
      name: player.name,
      score: player.score,
      gems: player.gems,
      isHost: player.id === room.hostId,
      connected: player.connected,
      isSpectator: player.isSpectator ?? false
    })),
    game: room.game,
    rounds: room.rounds
  };
}

function updateGamePlayers(room: RoomDTO) {
  const snapshot = room.players.map((player) => ({
    id: player.id,
    name: player.name,
    isHost: player.id === room.hostId,
    score: player.score,
    gems: player.gems,
    connected: player.connected,
    isSpectator: player.isSpectator ?? false
  }));
  game?.syncRoomPlayers(snapshot);
}

function startSpellcast(roomState?: InitialRoomState, options?: { multiplayer?: MultiplayerController }) {
  if (game) {
    game.dispose();
  }
  setGameVisibility(true);
  game = new SpellcastGame(app, dictionary, roomState, options);
  window.addEventListener("spellcast:exit", handleGameExit);
  if (!roomState?.roomId) {
    soundManager.play("game-start");
  }
}

function handleGameExit() {
  window.removeEventListener("spellcast:exit", handleGameExit);
  if (lobbyContext) {
    leaveCurrentRoom().catch((err) => {
      console.error(err);
      exitOfflineGame();
    });
  } else {
    exitOfflineGame();
  }
}

function exitOfflineGame() {
  game?.dispose();
  game = null;
  app.innerHTML = "";
  setGameVisibility(false);
  showLandingAfterFade("menu", "", "info", () => {
    setAppPath(HOME_PATH, true);
  });
}

function saveName(name: string) {
  try {
    localStorage.setItem(STORAGE_KEYS.name, name);
  } catch {
    // ignore
  }
}

function persistRoomSession(roomId: string, playerId: string) {
  try {
    localStorage.setItem(STORAGE_KEYS.room, roomId);
    localStorage.setItem(STORAGE_KEYS.player, playerId);
  } catch {
    // ignore
  }
}

function clearRoomSession() {
  try {
    localStorage.removeItem(STORAGE_KEYS.room);
    localStorage.removeItem(STORAGE_KEYS.player);
  } catch {
    // ignore
  }
}

async function leaveStoredSessionForInvite(session: { roomId: string; playerId: string }) {
  landing.setMessage("Switching rooms...", "info");
  try {
    await leaveRoom(session.roomId, session.playerId, session.playerId);
  } catch (error) {
    console.warn("Failed to leave previous room during invite navigation", error);
  } finally {
    clearRoomSession();
  }
}

function loadStoredName(): string {
  try {
    return localStorage.getItem(STORAGE_KEYS.name) ?? "";
  } catch {
    return "";
  }
}

function loadStoredSession(): { roomId: string; playerId: string } | null {
  try {
    const roomId = localStorage.getItem(STORAGE_KEYS.room);
    const playerId = localStorage.getItem(STORAGE_KEYS.player);
    if (roomId && playerId) {
      return { roomId, playerId };
    }
  } catch {
    // ignore
  }
  return null;
}

function detectRoomIdFromLocation(): string | null {
  const relative = getRelativePath();
  const roomMatch = relative.match(/\/room\/([A-Z0-9]+)/i);
  if (roomMatch) {
    return roomMatch[1].toUpperCase();
  }
  return null;
}

function setupDebugPanel() {
  const panel = document.createElement("div");
  panel.style.position = "fixed";
  panel.style.top = "12px";
  panel.style.left = "12px";
  panel.style.zIndex = "200000";
  panel.style.background = "rgba(255,255,255,0.08)";
  panel.style.border = "1px solid rgba(255,255,255,0.25)";
  panel.style.borderRadius = "8px";
  panel.style.padding = "10px";
  panel.style.color = "#fff";
  panel.style.fontFamily = "monospace";
  panel.textContent = "Debug";

  const btn = document.createElement("button");
  btn.textContent = "Preview Endgame";
  btn.style.marginTop = "8px";
  btn.addEventListener("click", () => {
    game?.debugShowEndgamePreview();
  });

  panel.appendChild(btn);
  document.body.appendChild(panel);
}

function getRelativePath(): string {
  if (BASE_PATH && window.location.pathname.startsWith(BASE_PATH)) {
    return window.location.pathname.slice(BASE_PATH.length);
  }
  return window.location.pathname;
}

function buildRoomPath(roomId: string) {
  return `${BASE_PATH}/room/${roomId}`;
}

function buildOfflinePath() {
  return `${BASE_PATH}/offline`;
}

function buildDebugPath() {
  return `${BASE_PATH}/debug`;
}

function buildShareUrl(roomId: string) {
  const origin = window.location.origin.replace(/\/$/, "");
  return `${origin}${buildRoomPath(roomId)}`;
}

function setAppPath(path: string, replace: boolean) {
  const normalized = path || "/";
  if (replace) {
    window.history.replaceState({}, "", normalized);
  } else {
    window.history.pushState({}, "", normalized);
  }
}

function handleAuthQueryParam() {
  const params = new URLSearchParams(window.location.search);
  const auth = params.get("auth");
  if (auth === "failed") {
    landing.setMessage("Login failed. Please try again.", "error");
    params.delete("auth");
    const next = `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ""}${window.location.hash}`;
    window.history.replaceState({}, "", next);
  }
}

function showKickedModal(message: string): Promise<void> {
  return new Promise((resolve) => {
    if (kickedModal) {
      kickedModal.remove();
      kickedModal = null;
    }
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    const modal = document.createElement("div");
    modal.className = "modal modal--theme";
    kickedModal = overlay;

    const text = document.createElement("p");
    text.className = "modal__message";
    text.textContent = message;

    const actions = document.createElement("div");
    actions.className = "modal__actions";

    const okBtn = document.createElement("button");
    okBtn.className = "modal__btn primary";
    okBtn.textContent = "Okay";
    okBtn.addEventListener("click", () => {
      overlay.remove();
      kickedModal = null;
      isHandlingKick = false;
      resolve();
    });

    actions.append(okBtn);
    modal.append(text, actions);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
  });
}

async function checkIfKickedFallback(): Promise<boolean> {
  if (isHandlingKick || kickedCheckInFlight) return false;
  if (!lobbyContext) return false;
  kickedCheckInFlight = true;
  try {
    const room = await getRoom(lobbyContext.roomId);
    const stillInRoom = room.players.some((p) => p.id === lobbyContext!.playerId);
    if (!stillInRoom) {
      await handleForcedRemoval();
      return true;
    }
    return false;
  } catch {
    return false;
  } finally {
    kickedCheckInFlight = false;
  }
}

function createMultiplayerBridge(
  socket: RoomSocket,
  roomId: string,
  requesterId: string
): MultiplayerController {
  return {
    submitWord(tileIds: string[]) {
      console.log("[client][socket] emit game:submitWord", tileIds);
      socket.emit("game:submitWord", { tileIds });
    },
    shuffle() {
      console.log("[client][socket] emit game:shuffle");
      socket.emit("game:shuffle");
    },
    requestSwapMode() {
      console.log("[client][socket] emit game:swap:start");
      socket.emit("game:swap:start");
    },
    applySwap(tileId: string, letter: string) {
      console.log("[client][socket] emit game:swap:apply", tileId, letter);
      socket.emit("game:swap:apply", { tileId, letter });
    },
    cancelSwap() {
      console.log("[client][socket] emit game:swap:cancel");
      socket.emit("game:swap:cancel");
    },
    updateSelection(tileIds: string[]) {
      console.log("[client][socket] emit game:selection", tileIds);
      socket.emit("game:selection", { tileIds });
    },
    async kickPlayer(playerId: string) {
      console.log("[client][api] kick player", playerId);
      try {
        await leaveRoom(roomId, playerId, requesterId);
      } catch (error) {
        console.warn("Failed to kick player", error);
      }
    },
    skipTurn(playerId: string) {
      console.log("[client][socket] emit game:skip", playerId);
      socket.emit("game:skip", { playerId });
    }
  };
}

type LandingView = "menu" | "create" | "join" | "lobby";

interface LandingOverlayOptions {
  initialName?: string;
  initialRoom?: string;
}

interface LobbyRenderData {
  roomCode: string;
  shareUrl: string;
  players: Array<{
    id: string;
    name: string;
    isHost: boolean;
    connected: boolean;
    canKick: boolean;
    isSpectator: boolean;
  }>;
  canStart: boolean;
  isHost: boolean;
  status: RoomStatus;
  minPlayersMet: boolean;
  rounds: number;
  canEditRounds: boolean;
}

function createLandingOverlay(options: LandingOverlayOptions) {
  const overlay = document.createElement("div");
  overlay.className = "landing-overlay";

  const panelsWrap = document.createElement("div");
  panelsWrap.className = "landing-panels";
  overlay.appendChild(panelsWrap);
  document.body.appendChild(overlay);

  let activeView: LandingView = "menu";
  let visible = true;

  const viewMap = new Map<
    LandingView,
    { panel: HTMLElement; view: HTMLElement; status: HTMLElement }
  >();
  let viewTransitionTimer: number | null = null;
  let panelHeightLockTimer: number | null = null;
  const transitionMs = TRANSITION_MS;
  const registerView = (name: LandingView, element: HTMLElement) => {
    element.dataset.view = name;
    element.classList.add("landing-view");
    element.hidden = true;
    const status = document.createElement("div");
    status.className = "landing-panel__status";
    status.hidden = true;
    const panel = document.createElement("div");
    panel.className = "landing-panel landing-panel--stacked landing-panel--hidden";
    panel.hidden = true;
    panel.appendChild(element);
    panel.appendChild(status);
    panelsWrap.appendChild(panel);
    viewMap.set(name, { panel, view: element, status });
  };

  const lockPanelHeight = () => {
    if (panelHeightLockTimer) {
      window.clearTimeout(panelHeightLockTimer);
      panelHeightLockTimer = null;
    }
    const activePanel = viewMap.get(activeView)?.panel;
    const h = activePanel?.getBoundingClientRect().height ?? 0;
    if (h > 0) {
      panelsWrap.style.minHeight = `${h}px`;
      panelHeightLockTimer = window.setTimeout(() => {
        panelsWrap.style.minHeight = "";
        panelHeightLockTimer = null;
      }, transitionMs + 40);
    }
  };

  // Menu view
  const menuView = document.createElement("div");
  menuView.className = "landing-view__menu";

  const menuLogo = document.createElement("img");
  menuLogo.src = logoUrl;
  menuLogo.alt = "Words & Wizards";
  menuLogo.className = "landing-menu__logo";

  const menuSubtitle = document.createElement("p");
  menuSubtitle.className = "landing-menu__subtitle";
  menuSubtitle.textContent = "Cast words alone or invite friends.";

  const menuActions = document.createElement("div");
  menuActions.className = "landing-menu__actions";

  const playOnlineBtn = document.createElement("button");
  playOnlineBtn.className = "landing-menu__btn primary";
  playOnlineBtn.textContent = "Play Online";

  const playOfflineBtn = document.createElement("button");
  playOfflineBtn.className = "landing-menu__btn";
  playOfflineBtn.textContent = "Play Offline";

  const primaryRow = document.createElement("div");
  primaryRow.className = "landing-menu__primary-row";
  primaryRow.append(playOnlineBtn, playOfflineBtn);

  const joinWithCodeBtn = document.createElement("button");
  joinWithCodeBtn.className = "landing-menu__btn";
  joinWithCodeBtn.textContent = "Join with Code";
  joinWithCodeBtn.style.display = "none";

  const loginBtn = document.createElement("button");
  loginBtn.className = "landing-menu__btn";
  loginBtn.textContent = "Login with Discord";
  const logoutBtn = document.createElement("button");
  logoutBtn.className = "landing-menu__btn";
  logoutBtn.textContent = "Logout";
  logoutBtn.style.display = "none";

  const sessionTag = document.createElement("div");
  sessionTag.className = "landing-menu__session";
  sessionTag.style.display = "none";

  menuActions.append(
    primaryRow,
    joinWithCodeBtn,
    loginBtn,
    logoutBtn,
    sessionTag
  );
  menuView.append(menuLogo, menuSubtitle, menuActions);
  registerView("menu", menuView);

  // Create Room view
  const createView = document.createElement("div");
  createView.className = "landing-view__form";

  const createTitle = document.createElement("h2");
  createTitle.textContent = "Create Room";

  const createNameLabel = document.createElement("label");
  createNameLabel.className = "landing-panel__label";
  createNameLabel.textContent = "Display Name";

  const createNameInput = document.createElement("input");
  createNameInput.type = "text";
  createNameInput.className = "landing-panel__input";
  createNameInput.maxLength = 32;
  createNameInput.value = options.initialName ?? "";
  createNameInput.placeholder = "WandMaster";

  const createActions = document.createElement("div");
  createActions.className = "landing-panel__actions";

  const createBtn = document.createElement("button");
  createBtn.className = "hud__btn primary";
  createBtn.textContent = "Create Room";

  const createBackBtn = document.createElement("button");
  createBackBtn.className = "hud__btn";
  createBackBtn.textContent = "Back";

  const toJoinBtn = document.createElement("button");
  toJoinBtn.className = "landing-link";
  toJoinBtn.type = "button";
  toJoinBtn.textContent = "Have a code? Join a room";

  createActions.append(createBtn, createBackBtn);
  createView.append(createTitle, createNameLabel, createNameInput, createActions, toJoinBtn);
  registerView("create", createView);

  // Join view
  const joinView = document.createElement("div");
  joinView.className = "landing-view__form";

  const joinTitle = document.createElement("h2");
  joinTitle.textContent = "Join Room";

  const joinNameLabel = document.createElement("label");
  joinNameLabel.className = "landing-panel__label";
  joinNameLabel.textContent = "Display Name";

  const joinNameInput = document.createElement("input");
  joinNameInput.type = "text";
  joinNameInput.className = "landing-panel__input";
  joinNameInput.maxLength = 32;
  joinNameInput.placeholder = "Your name";
  joinNameInput.value = options.initialName ?? "";

  const joinRoomLabel = document.createElement("label");
  joinRoomLabel.className = "landing-panel__label";
  joinRoomLabel.textContent = "Room Code";

  const joinRoomInput = document.createElement("input");
  joinRoomInput.type = "text";
  joinRoomInput.className = "landing-panel__input";
  joinRoomInput.maxLength = 6;
  joinRoomInput.placeholder = "ABCD";
  joinRoomInput.value = (options.initialRoom ?? "").toUpperCase();
  joinRoomInput.addEventListener("input", () => {
    joinRoomInput.value = joinRoomInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  });

  const joinActions = document.createElement("div");
  joinActions.className = "landing-panel__actions";

  const joinBtn = document.createElement("button");
  joinBtn.className = "hud__btn primary";
  joinBtn.textContent = "Join Game";

  const joinBackBtn = document.createElement("button");
  joinBackBtn.className = "hud__btn";
  joinBackBtn.textContent = "Back";

  joinActions.append(joinBtn, joinBackBtn);
  joinView.append(
    joinTitle,
    joinNameLabel,
    joinNameInput,
    joinRoomLabel,
    joinRoomInput,
    joinActions
  );
  registerView("join", joinView);

  // Lobby view
  const lobbyView = document.createElement("div");
  lobbyView.className = "landing-view__lobby";

  const lobbyHeader = document.createElement("div");
  lobbyHeader.className = "lobby-header";
  const lobbyTitle = document.createElement("h2");
  lobbyTitle.textContent = "Lobby";
  const lobbyRoomCode = document.createElement("div");
  lobbyRoomCode.className = "lobby-room-code";
  lobbyHeader.append(lobbyTitle, lobbyRoomCode);

  const lobbyShareWrap = document.createElement("div");
  lobbyShareWrap.className = "lobby-share";
  const shareLabel = document.createElement("span");
  shareLabel.textContent = "Invite link";
  const shareRow = document.createElement("div");
  shareRow.className = "lobby-share__row";
  const shareInput = document.createElement("input");
  shareInput.className = "lobby-share__input";
  shareInput.readOnly = true;
  const shareCopy = document.createElement("button");
  shareCopy.className = "share-copy-btn";
  shareCopy.type = "button";
  shareCopy.setAttribute("aria-label", "Copy invite link");
  shareCopy.title = "Copy invite link";
  const copyIcon = document.createElement("i");
  copyIcon.className = "fa-solid fa-copy";
  shareCopy.append(copyIcon);
  let copyFeedbackTimer: number | undefined;
  shareCopy.addEventListener("click", () => {
    const url = shareInput.value.trim();
    if (!url) return;
    shareCopy.disabled = true;
    if (copyFeedbackTimer) {
      window.clearTimeout(copyFeedbackTimer);
      copyFeedbackTimer = undefined;
    }
    const resetState = () => {
      shareCopy.classList.remove("share-copy-btn--success", "share-copy-btn--error");
      shareCopy.setAttribute("aria-label", "Copy invite link");
      shareCopy.title = "Copy invite link";
    };
    copyTextToClipboard(url)
      .then(() => {
        resetState();
        shareCopy.classList.add("share-copy-btn--success");
        shareCopy.setAttribute("aria-label", "Link copied!");
        shareCopy.title = "Link copied!";
        copyFeedbackTimer = window.setTimeout(() => {
          resetState();
          copyFeedbackTimer = undefined;
        }, 1600);
      })
      .catch(() => {
        resetState();
        shareCopy.classList.add("share-copy-btn--error");
        shareCopy.setAttribute("aria-label", "Copy failed");
        shareCopy.title = "Copy failed";
        copyFeedbackTimer = window.setTimeout(() => {
          resetState();
          copyFeedbackTimer = undefined;
        }, 1800);
      })
      .finally(() => {
        shareCopy.disabled = false;
      });
  });
  shareRow.append(shareInput, shareCopy);
  lobbyShareWrap.append(shareLabel, shareRow);

  const lobbyDivider = document.createElement("hr");
  lobbyDivider.className = "lobby-divider";

  const lobbyPlayersList = document.createElement("div");
  lobbyPlayersList.className = "lobby-players";
  const lobbyPlayersHeader = document.createElement("h3");
  lobbyPlayersHeader.className = "lobby-players__heading";
  lobbyPlayersHeader.textContent = "Players";

  const lobbyStatusText = document.createElement("p");
  lobbyStatusText.className = "lobby-status";

  const lobbyRounds = document.createElement("div");
  lobbyRounds.className = "lobby-rounds";
  const lobbyRoundsLabel = document.createElement("span");
  lobbyRoundsLabel.className = "lobby-rounds__label";
  lobbyRoundsLabel.textContent = "Rounds";
  const lobbyRoundsOptions = document.createElement("div");
  lobbyRoundsOptions.className = "lobby-rounds__options";
  const roundInputs: HTMLInputElement[] = [];
  [3, 5].forEach((value) => {
    const option = document.createElement("label");
    option.className = "lobby-rounds__option";
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "lobby-rounds";
    input.value = String(value);
    const text = document.createElement("span");
    text.textContent = `${value} Rounds`;
    option.append(input, text);
    lobbyRoundsOptions.append(option);
    roundInputs.push(input);
  });
  lobbyRounds.append(lobbyRoundsLabel, lobbyRoundsOptions);

  const lobbyActions = document.createElement("div");
  lobbyActions.className = "lobby-actions";
  const lobbyStartBtn = document.createElement("button");
  lobbyStartBtn.className = "hud__btn primary";
  lobbyStartBtn.textContent = "Start Game";
  const lobbyLeaveBtn = document.createElement("button");
  lobbyLeaveBtn.className = "player-action-btn player-action-btn--exit";
  lobbyLeaveBtn.setAttribute("aria-label", "Leave lobby");
  const lobbyLeaveIcon = document.createElement("i");
  lobbyLeaveIcon.className = "fa-solid fa-door-open";
  lobbyLeaveBtn.append(lobbyLeaveIcon);
  lobbyActions.append(lobbyStartBtn, lobbyLeaveBtn);

  let roundsChangeHandler: ((rounds: number) => void) | null = null;
  let roundsEditable = false;
  let roundsBusy = false;
  const syncRoundInputs = () => {
    const disabled = !roundsEditable || roundsBusy;
    roundInputs.forEach((input) => {
      input.disabled = disabled;
    });
    lobbyRounds.classList.toggle("lobby-rounds--disabled", disabled);
    lobbyRounds.classList.toggle("lobby-rounds--busy", roundsBusy);
  };
  const setRoundsSelection = (value: number) => {
    let matched = false;
    roundInputs.forEach((input) => {
      const match = Number(input.value) === value;
      input.checked = match;
      if (match) matched = true;
    });
    if (!matched && roundInputs.length) {
      roundInputs[roundInputs.length - 1].checked = true;
    }
  };
  const setRoundsEditable = (state: boolean) => {
    roundsEditable = state;
    syncRoundInputs();
  };
  const setRoundsBusyState = (state: boolean) => {
    roundsBusy = state;
    syncRoundInputs();
  };
  roundInputs.forEach((input) => {
    input.addEventListener("change", () => {
      if (!input.checked) return;
      const value = Number(input.value);
      if (!Number.isFinite(value)) return;
      roundsChangeHandler?.(value);
    });
  });
  setRoundsSelection(5);

  lobbyView.append(
    lobbyHeader,
    lobbyShareWrap,
    lobbyDivider,
    lobbyPlayersHeader,
    lobbyPlayersList,
    lobbyStatusText,
    lobbyRounds,
    lobbyActions
  );
  registerView("lobby", lobbyView);

  const hideOverlay = () => {
    overlay.classList.add("landing-overlay--hidden");
    visible = false;
  };

  const showOverlay = () => {
    if (!overlay.isConnected) {
      document.body.appendChild(overlay);
    }
    overlay.classList.remove("landing-overlay--hidden");
    visible = true;
  };

  const showView = (name: LandingView) => {
    const next = viewMap.get(name);
    if (!next) return;
    if (activeView === name && !next.panel.hidden) return;
    const previous = viewMap.get(activeView);
    activeView = name;

    if (viewTransitionTimer) {
      window.clearTimeout(viewTransitionTimer);
      viewTransitionTimer = null;
    }

    // If there's a previous view visible, let it exit first, then bring the next one in.
    if (previous && !previous.panel.hidden && previous !== next) {
      lockPanelHeight();
      previous.panel.classList.remove("landing-panel--active");
      previous.panel.classList.add("landing-panel--exit");
      next.panel.classList.remove("landing-panel--active", "landing-panel--exit");
      next.panel.hidden = true;
      viewTransitionTimer = window.setTimeout(() => {
        previous.panel.classList.remove("landing-panel--exit");
        previous.panel.hidden = true;
        next.panel.hidden = false;
        // Allow the browser to apply the hidden->visible styles before animating in.
        next.panel.classList.remove("landing-panel--active", "landing-panel--exit");
        // Force reflow so the transition runs when we add the active class.
        void next.panel.getBoundingClientRect();
        requestAnimationFrame(() => {
          next.panel.classList.add("landing-panel--active");
        });
      }, transitionMs);
      return;
    }

    // No prior view to exit; just activate the target immediately.
    viewMap.forEach(({ panel }) => {
      const isTarget = panel === next.panel;
      panel.hidden = !isTarget;
      panel.classList.toggle("landing-panel--active", isTarget);
      panel.classList.remove("landing-panel--exit");
    });
  };

  const setMessage = (message: string, tone: "info" | "error" = "info") => {
    viewMap.forEach(({ status }) => {
      status.textContent = "";
      status.hidden = true;
    });
    const status = viewMap.get(activeView)?.status;
    if (!status) return;
    status.textContent = message;
    status.hidden = !message;
    status.dataset.tone = tone;
  };

  const setBusy = (state: boolean, message?: string) => {
    panelsWrap.querySelectorAll<HTMLButtonElement>("button").forEach((btn) => {
      btn.disabled = state;
    });
    panelsWrap.querySelectorAll<HTMLInputElement>("input").forEach((input) => {
      input.disabled = state;
    });
    overlay.classList.toggle("landing-overlay--loading", state);
    if (state && message) {
      setMessage(message, "info");
    } else if (!state) {
      setMessage("");
    }
  };

  // initialize with default view visible
  showView(activeView);

  return {
    root: overlay,
    showView,
    transitionOut(after?: () => void) {
      hideOverlay();
      window.setTimeout(() => after?.(), transitionMs);
    },
    transitionIn(view?: LandingView, after?: () => void) {
      if (view) showView(view);
      showOverlay();
      window.setTimeout(() => after?.(), transitionMs);
    },
    hide() {
      hideOverlay();
    },
    show(view?: LandingView) {
      if (view) showView(view);
      showOverlay();
    },
    setMessage,
    setBusy,
    get currentView() {
      return activeView;
    },
    isVisible() {
      return visible;
    },
    playOnlineBtn,
    playOfflineBtn,
    joinWithCodeBtn,
    loginBtn,
    logoutBtn,
    sessionTag,
    createNameLabel,
    createNameInput,
    createBtn,
    createBackBtn,
    createToJoinBtn: toJoinBtn,
    joinNameLabel,
    joinNameInput,
    joinRoomInput,
    joinBtn,
    joinBackBtn,
    lobbyStartBtn,
    lobbyLeaveBtn,
    setLobbyStarting(state: boolean) {
      lobbyStartBtn.disabled = state;
      lobbyStartBtn.dataset.loading = state ? "true" : "false";
    },
    setRoundSelection(value: number) {
      setRoundsSelection(value);
    },
    setRoundsBusy(state: boolean) {
      setRoundsBusyState(state);
    },
    onRoundsChange(handler: (rounds: number) => void) {
      roundsChangeHandler = handler;
    },
    updateLobby(data: LobbyRenderData) {
      lobbyRoomCode.textContent = `Room ${data.roomCode}`;
      shareInput.value = data.shareUrl;
      lobbyPlayersList.innerHTML = "";
      data.players.forEach((player) => {
        const item = document.createElement("li");
        item.className = "lobby-player";
        const row = document.createElement("div");
        row.className = "lobby-player__row";

        const left = document.createElement("div");
        left.className = "lobby-player__left";

        const indicator = document.createElement("span");
        indicator.className = `status-indicator ${
          player.connected ? "status-indicator--online" : "status-indicator--offline"
        }`;
        indicator.title = player.connected ? "Connected" : "Reconnecting…";

        const name = document.createElement("span");
        name.className = "lobby-player__name";
        name.textContent = player.name;

        left.append(indicator, name);
        row.append(left);

        if (player.isHost) {
          const badge = document.createElement("span");
          badge.className = "lobby-player__badge";
          badge.textContent = "Host";
          row.append(badge);
        }

        if (player.isSpectator) {
          const specBadge = document.createElement("span");
          specBadge.className = "lobby-player__badge lobby-player__badge--spectator";
          specBadge.textContent = "Spectator";
          row.append(specBadge);
        }

        if (player.canKick) {
          const kickBtn = document.createElement("button");
          kickBtn.className = "lobby-player__kick";
          kickBtn.textContent = "Kick";
          kickBtn.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            kickHandler?.(player.id);
          });
          row.append(kickBtn);
        }

        item.append(row);
        lobbyPlayersList.appendChild(item);
      });
      if (!data.players.length) {
        const empty = document.createElement("li");
        empty.textContent = "Waiting for players...";
        lobbyPlayersList.appendChild(empty);
      }
      lobbyStartBtn.textContent = "Start Game";
      lobbyStartBtn.disabled = !data.canStart;
      lobbyStartBtn.style.display = data.isHost ? "inline-flex" : "none";
      setRoundsSelection(data.rounds);
      setRoundsEditable(data.canEditRounds);
      if (!data.isHost) {
        lobbyStatusText.textContent = "Waiting for the host to start the game.";
      } else if (!data.minPlayersMet) {
        lobbyStatusText.textContent = "Need at least one player to start.";
      } else if (data.status === "in-progress") {
        lobbyStatusText.textContent = "Game starting...";
      } else {
        lobbyStatusText.textContent = "";
      }
      lobbyLeaveBtn.disabled = false;
      if (!data.isHost) {
        lobbyStartBtn.classList.remove("primary");
      } else {
        lobbyStartBtn.classList.add("primary");
      }
    },
    setKickHandler(handler: (playerId: string) => void) {
      kickHandler = handler;
    }
  };
}

function createConnectionNotice() {
  const notice = document.createElement("div");
  notice.className = "connection-notice";
  notice.hidden = true;
  document.body.appendChild(notice);
  return {
    show(message: string) {
      notice.textContent = message;
      notice.hidden = false;
    },
    hide() {
      notice.hidden = true;
    }
  };
}

function showConnectionNotice(message: string) {
  connectionNotice.show(message);
}

function hideConnectionNotice() {
  connectionNotice.hide();
}

function copyTextToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }
  return new Promise((resolve, reject) => {
    try {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      const successful = document.execCommand("copy");
      document.body.removeChild(textarea);
      if (successful) {
        resolve();
      } else {
        reject(new Error("Copy command was rejected."));
      }
    } catch (error) {
      reject(error instanceof Error ? error : new Error("Copy failed"));
    }
  });
}

// Hot module replace support when running dev server
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    disconnectRealtime();
    game?.dispose();
  });
}

async function resumeStoredSession(session: { roomId: string; playerId: string }) {
  landing.setBusy(true, "Reconnecting to your room...");
  landing.setMessage("Reconnecting to your previous room...", "info");
  try {
    const room = await getRoom(session.roomId);
    const player = room.players.find((entry) => entry.id === session.playerId);
    if (!player) {
      clearRoomSession();
      landing.setMessage("", "info");
      return;
    }
    lobbyContext = {
      roomId: room.id,
      playerId: player.id,
      isHost: player.id === room.hostId
    };
    latestRoomSnapshot = room;
    knownPlayerIds = new Set(room.players.map((entry) => entry.id));
    hasPlayerSnapshot = true;
    hasEnteredGame = room.status === "in-progress";
    setAppPath(buildRoomPath(room.id), true);
    renderLobby(room);
    landing.showView("lobby");
    landing.setMessage("", "info");
    connectRealtime(room.id, player.id);
    if (room.status === "in-progress") {
      enterGame(room);
    }
  } catch (error) {
    clearRoomSession();
    landing.setMessage("", "info");
    throw error;
  } finally {
    landing.setBusy(false);
  }
}
