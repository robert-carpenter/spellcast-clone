import "./style.css";
import { SpellcastGame, InitialRoomState, MultiplayerController } from "./game/SpellcastGame";
import dictionaryRaw from "./game/dictionary.txt?raw";
import {
  createRoom,
  joinRoom,
  startRoom,
  leaveRoom,
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
const landing = createLandingOverlay({
  initialName: loadStoredName(),
  initialRoom: existingRoomFromPath ?? ""
});

landing.showView(existingRoomFromPath ? "join" : "menu");

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
  setAppPath(HOME_PATH, true);
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

if (existingRoomFromPath) {
  landing.showView("join");
  landing.joinRoomInput.value = existingRoomFromPath;
  landing.setMessage(`Joining room ${existingRoomFromPath}.`, "info");
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
  landing.setMessage("");
  renderLobby(response.room);
  connectRealtime(response.roomId, response.player.id);
}

async function leaveCurrentRoom() {
  if (!lobbyContext) return;
  landing.setBusy(true, "Leaving room...");
  try {
    await leaveRoom(lobbyContext.roomId, lobbyContext.playerId);
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
    isHost: player.id === room.hostId
  }));
  const canStart = isHost && room.players.length >= 2;
  const shareUrl = buildShareUrl(room.id);
  landing.updateLobby({
    roomCode: room.id,
    shareUrl,
    players,
    canStart,
    isHost,
    status: room.status,
    minPlayersMet: room.players.length >= 2
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
      isHost: player.id === room.hostId
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
    gems: player.gems
  }));
  game?.syncRoomPlayers(snapshot);
}

function startSpellcast(roomState?: InitialRoomState, options?: { multiplayer?: MultiplayerController }) {
  if (game) {
    game.dispose();
  }
  game = new SpellcastGame(app, dictionary, roomState, options);
  if (!roomState?.roomId) {
    soundManager.play("game-start");
  }
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

function detectRoomIdFromLocation(): string | null {
  const relative = getRelativePath();
  const match = relative.match(/\/room\/([A-Z0-9]+)/i);
  return match ? match[1].toUpperCase() : null;
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
  players: Array<{ id: string; name: string; isHost: boolean }>;
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
  const shareInput = document.createElement("input");
  shareInput.className = "lobby-share__input";
  shareInput.readOnly = true;
  const shareCopy = document.createElement("button");
  shareCopy.className = "hud__btn";
  shareCopy.textContent = "Copy Link";
  shareCopy.addEventListener("click", () => {
    navigator.clipboard
      .writeText(shareInput.value)
      .then(() => {
        shareCopy.textContent = "Copied!";
        window.setTimeout(() => (shareCopy.textContent = "Copy Link"), 1500);
      })
      .catch(() => {
        shareCopy.textContent = "Copy failed";
        window.setTimeout(() => (shareCopy.textContent = "Copy Link"), 1500);
      });
  });
  lobbyShareWrap.append(shareLabel, shareInput, shareCopy);

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
  lobbyLeaveBtn.className = "hud__btn";
  lobbyLeaveBtn.textContent = "Leave Lobby";
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
        item.textContent = player.name + (player.isHost ? " (Host)" : "");
        lobbyPlayersList.appendChild(item);
      });
      if (!data.players.length) {
        const empty = document.createElement("li");
        empty.textContent = "Waiting for players...";
        lobbyPlayersList.appendChild(empty);
      }
      lobbyStartBtn.textContent = data.isHost ? "Start Game" : "Waiting for Host";
      lobbyStartBtn.disabled = !data.canStart;
      if (!data.isHost) {
        lobbyStatusText.textContent = "Waiting for the host to start the game.";
      } else if (!data.minPlayersMet) {
        lobbyStatusText.textContent = "Need at least 2 players to start.";
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

// Hot module replace support when running dev server
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    disconnectRealtime();
    game?.dispose();
  });
}
