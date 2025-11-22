import "./style.css";
import { SpellcastGame, InitialRoomState, MultiplayerController } from "./game/SpellcastGame";
import dictionaryRaw from "./game/dictionary.txt?raw";
import {
  createRoom,
  joinRoom,
  startRoom,
  leaveRoom,
  getRoom,
  CreateRoomResponse,
  JoinRoomResponse,
  RoomDTO
} from "./network/api";
import { connectRoomSocket, RoomSocket } from "./network/socket";
import { soundManager } from "./audio/SoundManager";

type RoomStatus = RoomDTO["status"];

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("App container not found");
}

const dictionary = new Set(
  dictionaryRaw
    .split(/\r?\n/)
    .map((word) => word.trim().toUpperCase())
    .filter(Boolean)
);


const BASE_PATH = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");
const HOME_PATH = BASE_PATH || "/";
soundManager.enableAutoUnlock();

const STORAGE_KEYS = {
  name: "spellcast:name",
  room: "spellcast:roomId",
  player: "spellcast:playerId"
} as const;

const existingRoomFromPath = detectRoomIdFromLocation();
let kickHandler: ((playerId: string) => void) | null = null;
const landing = createLandingOverlay({
  initialName: loadStoredName(),
  initialRoom: existingRoomFromPath ?? ""
});
landing.setKickHandler((playerId) => {
  handleKickPlayer(playerId).catch((err) => console.error(err));
});

const storedSession = loadStoredSession();
if (storedSession) {
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

landing.playOnlineBtn.addEventListener("click", () => {
  landing.showView("create");
  landing.setMessage("");
});

landing.playOfflineBtn.addEventListener("click", () => {
  const name = landing.createNameInput.value.trim();
  if (name) saveName(name);
  clearRoomSession();
  disconnectRealtime();
  setAppPath(buildOfflinePath(), true);
  landing.hide();
  startSpellcast();
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
  const name = landing.createNameInput.value.trim();
  if (!name) {
    landing.setMessage("Enter a display name.", "error");
    return;
  }
  handleCreateRoom(name).catch((err) => console.error(err));
});

landing.joinBtn.addEventListener("click", () => {
  const name = landing.joinNameInput.value.trim();
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

const isOfflineRoute = getRelativePath().toLowerCase() === "/offline";
if (isOfflineRoute) {
  landing.hide();
  startSpellcast();
  setAppPath(buildOfflinePath(), true);
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
  lobbyContext = {
    roomId: response.roomId,
    playerId: response.player.id,
    isHost: response.player.id === response.room.hostId
  };
  hasEnteredGame = false;
  latestRoomSnapshot = response.room;
  landing.showView("lobby");
  if (response.room.status === "in-progress") {
    landing.setMessage("Game in progress — you'll spectate until next round.", "info");
  } else {
    landing.setMessage("");
  }
  renderLobby(response.room);
  connectRealtime(response.roomId, response.player.id);
}

async function leaveCurrentRoom() {
  if (!lobbyContext) return;
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
    clearRoomSession();
    hasEnteredGame = false;
    setAppPath(HOME_PATH, true);
    landing.showView("menu");
    landing.setMessage("");
    landing.show("menu");
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
      if (reason !== "io client disconnect") {
        showConnectionNotice("Connection lost. Reconnecting…");
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
    onConnect: () => hideConnectionNotice(),
    onReconnect: () => hideConnectionNotice()
  });
  multiplayerBridge = createMultiplayerBridge(roomSocket);
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

  if (lastRoomStatus === "lobby" && room.status === "in-progress") {
    soundManager.play("game-start");
  }
  lastRoomStatus = room.status;

  latestRoomSnapshot = room;
  if (lobbyContext) {
    lobbyContext.isHost = room.hostId === lobbyContext.playerId;
  }
  if (landing.isVisible() && landing.currentView === "lobby") {
    renderLobby(room);
  }
  if (room.status === "in-progress" && !hasEnteredGame) {
    enterGame(room);
  }
  if (hasEnteredGame && room.status === "lobby") {
    hasEnteredGame = false;
    landing.showView("lobby");
    landing.show();
    landing.setMessage("Game complete. Waiting for the host to start again.", "info");
    renderLobby(room);
    if (game) {
      game.dispose();
      game = null;
      app.innerHTML = "";
    }
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
    minPlayersMet: activeCount >= 1
  });
}

function enterGame(room: RoomDTO) {
  if (!lobbyContext) return;
  const initial = roomToInitialState(room, lobbyContext.playerId);
  landing.hide();
  hasEnteredGame = true;
  startSpellcast(initial, { multiplayer: multiplayerBridge ?? undefined });
  if (room.game && game) {
    game.applyGameSnapshot(room.game);
  }
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
    game: room.game
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
  landing.show("menu");
  landing.setMessage("");
  setAppPath(HOME_PATH, true);
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

function createMultiplayerBridge(socket: RoomSocket): MultiplayerController {
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
}

function createLandingOverlay(options: LandingOverlayOptions) {
  const overlay = document.createElement("div");
  overlay.className = "landing-overlay";

  const panel = document.createElement("div");
  panel.className = "landing-panel landing-panel--stacked";

  const viewsWrap = document.createElement("div");
  viewsWrap.className = "landing-views";

  const status = document.createElement("div");
  status.className = "landing-panel__status";
  status.hidden = true;

  panel.appendChild(viewsWrap);
  panel.appendChild(status);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  let activeView: LandingView = "menu";
  let visible = true;

  const viewMap = new Map<LandingView, HTMLElement>();
  const registerView = (name: LandingView, element: HTMLElement) => {
    element.dataset.view = name;
    element.classList.add("landing-view");
    viewsWrap.appendChild(element);
    viewMap.set(name, element);
  };

  // Menu view
  const menuView = document.createElement("div");
  menuView.className = "landing-view__menu";

  const menuTitle = document.createElement("h1");
  menuTitle.textContent = "Spellcast Clone";
  menuTitle.className = "landing-menu__title";

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

  menuActions.append(playOnlineBtn, playOfflineBtn);
  menuView.append(menuTitle, menuSubtitle, menuActions);
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

  const lobbyPlayersList = document.createElement("ul");
  lobbyPlayersList.className = "lobby-players";
  const lobbyPlayersHeader = document.createElement("h3");
  lobbyPlayersHeader.className = "lobby-players__heading";
  lobbyPlayersHeader.textContent = "Players";

  const lobbyStatusText = document.createElement("p");
  lobbyStatusText.className = "lobby-status";

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

  lobbyView.append(
    lobbyHeader,
    lobbyShareWrap,
    lobbyDivider,
    lobbyPlayersHeader,
    lobbyPlayersList,
    lobbyStatusText,
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
    activeView = name;
    viewMap.forEach((view, key) => {
      view.hidden = key !== name;
    });
  };

  const setMessage = (message: string, tone: "info" | "error" = "info") => {
    status.textContent = message;
    status.hidden = !message;
    status.dataset.tone = tone;
  };

  const setBusy = (state: boolean, message?: string) => {
    panel.querySelectorAll<HTMLButtonElement>("button").forEach((btn) => {
      btn.disabled = state;
    });
    panel.querySelectorAll<HTMLInputElement>("input").forEach((input) => {
      input.disabled = state;
    });
    overlay.classList.toggle("landing-overlay--loading", state);
    if (state && message) {
      setMessage(message, "info");
    } else if (!state) {
      setMessage("");
    }
  };

  return {
    root: overlay,
    showView,
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
    createNameInput,
    createBtn,
    createBackBtn,
    createToJoinBtn: toJoinBtn,
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
