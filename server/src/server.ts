import cors from "cors";
import express, { Request, Response } from "express";
import { randomUUID } from "crypto";
import { createServer } from "http";
import { Server as SocketIOServer, Socket } from "socket.io";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  addLogEntry,
  applySwap,
  cancelSwap,
  requestSwapMode,
  shuffleBoard,
  startNewGame,
  submitWord
} from "./gameState.js";
import { Room, Player } from "./types.js";

const app = express();
const httpServer = createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST", "DELETE"]
  }
});
const PORT = Number(process.env.PORT ?? 4000);

app.use(cors());
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const clientDistPath = path.resolve(__dirname, "../../dist");
if (fs.existsSync(clientDistPath)) {
  log("Serving static assets from", clientDistPath);
  app.use(express.static(clientDistPath));
}

const rooms = new Map<string, Room>();
const playerPresence = new Map<
  string,
  { roomId: string; sockets: Set<string>; timeout?: NodeJS.Timeout }
>();
const socketLookup = new Map<string, { roomId: string; playerId: string }>();
const gameResetTimers = new Map<string, NodeJS.Timeout>();

const MAX_PLAYERS = 6;
const DISCONNECT_GRACE_MS = 5 * 60 * 1000; // allow mobile browsers to background for up to 5 minutes
const NEW_GAME_DELAY_MS = 5000;
const DICTIONARY = loadDictionary();

function log(...args: unknown[]) {
  console.log("[server]", ...args);
}

app.get("/api/health", (_req: Request, res: Response) => {
  log("GET /api/health");
  res.json({ status: "ok" });
});

app.post("/api/rooms", (req: Request, res: Response) => {
  log("POST /api/rooms", req.body);
  const { name } = req.body ?? {};
  if (!name || typeof name !== "string") {
    return res.status(400).json({ error: "Host name is required" });
  }

  const roomId = generateRoomId();
  const host: Player = {
    id: randomUUID(),
    name: sanitizeName(name),
    isHost: true,
    score: 0,
    gems: 3,
    joinedAt: Date.now(),
    connected: false,
    isSpectator: false
  };

  const room: Room = {
    id: roomId,
    createdAt: Date.now(),
    hostId: host.id,
    players: [host],
    status: "lobby"
  };
  rooms.set(roomId, room);

  res.status(201).json({
    roomId,
    player: host,
    room
  });
});

app.get("/api/rooms/:roomId", (req: Request, res: Response) => {
  log("GET /api/rooms/:roomId", req.params.roomId);
  const room = rooms.get(req.params.roomId.toUpperCase());
  if (!room) {
    return res.status(404).json({ error: "Room not found" });
  }
  res.json(room);
});

app.post("/api/rooms/:roomId/join", (req: Request, res: Response) => {
  log("POST /api/rooms/:roomId/join", req.params.roomId, req.body);
  const roomId = req.params.roomId.toUpperCase();
  const room = rooms.get(roomId);
  if (!room) {
    return res.status(404).json({ error: "Room not found" });
  }
  if (room.players.length >= MAX_PLAYERS) {
    return res.status(400).json({ error: "Room is full" });
  }

  const { name } = req.body ?? {};
  if (!name || typeof name !== "string") {
    return res.status(400).json({ error: "Player name is required" });
  }

  const sanitized = sanitizeName(name);
  if (!sanitized) {
    return res.status(400).json({ error: "Player name cannot be empty" });
  }

  const joiningMidGame = room.status === "in-progress";
  const player: Player = {
    id: randomUUID(),
    name: sanitized,
    isHost: false,
    score: 0,
    gems: 3,
    joinedAt: Date.now(),
    connected: false,
    isSpectator: joiningMidGame
  };

  room.players.push(player);
  res.status(201).json({
    roomId,
    player,
    room
  });
  broadcastRoom(roomId);
});

app.post("/api/rooms/:roomId/start", (req: Request, res: Response) => {
  log("POST /api/rooms/:roomId/start", req.params.roomId, req.body);
  const roomId = req.params.roomId.toUpperCase();
  const room = rooms.get(roomId);
  if (!room) {
    return res.status(404).json({ error: "Room not found" });
  }
  if (room.status === "in-progress") {
    return res.status(400).json({ error: "Game already started" });
  }
  const { playerId } = req.body ?? {};
  if (!playerId || typeof playerId !== "string") {
    return res.status(400).json({ error: "playerId is required" });
  }
  if (room.hostId !== playerId) {
    return res.status(403).json({ error: "Only the host can start the game" });
  }
  const activePlayers = room.players.filter((player) => !player.isSpectator);
  if (!activePlayers.length) {
    return res.status(400).json({ error: "Need at least one active player to start" });
  }
  room.status = "in-progress";
  clearGameReset(roomId);
  startNewGame(room);
  broadcastRoom(roomId);
  res.json({ room });
});

app.delete("/api/rooms/:roomId/players/:playerId", (req: Request, res: Response) => {
  log("DELETE /api/rooms/:roomId/players/:playerId", req.params.roomId, req.params.playerId);
  const roomId = req.params.roomId.toUpperCase();
  const playerId = req.params.playerId;
  const room = rooms.get(roomId);
  if (!room) {
    return res.status(404).json({ error: "Room not found" });
  }
  const requesterId =
    typeof req.body?.requesterId === "string" ? (req.body.requesterId as string) : undefined;
  if (!requesterId) {
    return res.status(400).json({ error: "requesterId is required" });
  }
  const isSelfRemoval = requesterId === playerId;
  const isHostRequest = requesterId === room.hostId;
  if (!isSelfRemoval && !isHostRequest) {
    return res.status(403).json({ error: "Only the host can remove other players" });
  }

  const removed = forceRemovePlayer(roomId, playerId);
  if (!removed) {
    return res.status(404).json({ error: "Player not found" });
  }
  res.status(204).send();
});

io.on("connection", (socket) => {
  log("socket connected", socket.id, socket.handshake.auth);
  const { roomId, playerId } = (socket.handshake.auth ?? {}) as {
    roomId?: string;
    playerId?: string;
  };
  if (typeof roomId !== "string" || typeof playerId !== "string") {
    socket.emit("room:error", { message: "roomId and playerId required" });
    return socket.disconnect(true);
  }
  const roomCode = roomId.toUpperCase();
  const room = rooms.get(roomCode);
  const player = room?.players.find((entry) => entry.id === playerId);
  if (!room || !player) {
    socket.emit("room:error", { message: "Room not found or player missing" });
    return socket.disconnect(true);
  }

  socket.join(roomCode);
  log("socket join room", socket.id, roomCode);
  registerPresence(playerId, roomCode, socket);
  socket.emit("room:update", room);

  socket.on("game:submitWord", (payload: { tileIds?: string[] }) => {
    log("game:submitWord", playerId, payload);
    const currentRoom = rooms.get(roomCode);
    if (!currentRoom) return;
    const result = submitWord(currentRoom, playerId, payload?.tileIds ?? [], DICTIONARY);
    if (!result.success) {
      return socket.emit("game:error", { message: result.error ?? "Unable to submit word." });
    }
    broadcastRoom(roomCode);
    if (currentRoom.game?.completed) {
      scheduleGameReset(roomCode);
    } else {
      clearGameReset(roomCode);
    }
  });

  socket.on("game:shuffle", () => {
    log("game:shuffle", playerId);
    const currentRoom = rooms.get(roomCode);
    if (!currentRoom) return;
    if (!ensurePlayerTurn(currentRoom, playerId)) {
      return socket.emit("game:error", { message: "It is not your turn." });
    }
    const result = shuffleBoard(currentRoom, playerId);
    if (!result.success) {
      return socket.emit("game:error", { message: result.error ?? "Unable to shuffle." });
    }
    if (currentRoom.game) {
      const player = currentRoom.players.find((p) => p.id === playerId);
      if (player) {
        addLogEntry(
          currentRoom.game,
          `Round ${currentRoom.game.round}: ${player.name} used Shuffle (-1 gem).`
        );
      }
    }
    broadcastRoom(roomCode);
    clearGameReset(roomCode);
  });

  socket.on("game:swap:start", () => {
    log("game:swap:start", playerId);
    const currentRoom = rooms.get(roomCode);
    if (!currentRoom) return;
    if (!ensurePlayerTurn(currentRoom, playerId)) {
      return socket.emit("game:error", { message: "It is not your turn." });
    }
    const result = requestSwapMode(currentRoom, playerId);
    if (!result.success) {
      return socket.emit("game:error", { message: result.error ?? "Unable to swap." });
    }
    broadcastRoom(roomCode);
  });

  socket.on("game:swap:apply", (payload: { tileId?: string; letter?: string }) => {
    log("game:swap:apply", playerId, payload);
    const currentRoom = rooms.get(roomCode);
    if (!currentRoom) return;
    const tileId = payload?.tileId;
    const letter = payload?.letter;
    if (!tileId || !letter) {
      return socket.emit("game:error", { message: "Tile and letter are required." });
    }
    const result = applySwap(currentRoom, playerId, tileId, letter);
    if (!result.success) {
      return socket.emit("game:error", { message: result.error ?? "Unable to swap." });
    }
    if (currentRoom.game) {
      const player = currentRoom.players.find((p) => p.id === playerId);
      if (player) {
        addLogEntry(
          currentRoom.game,
          `Round ${currentRoom.game.round}: ${player.name} swapped a letter (-3 gems).`
        );
      }
    }
    broadcastRoom(roomCode);
    clearGameReset(roomCode);
  });

  socket.on("game:swap:cancel", () => {
    log("game:swap:cancel", playerId);
    const currentRoom = rooms.get(roomCode);
    if (!currentRoom) return;
    cancelSwap(currentRoom, playerId);
    broadcastRoom(roomCode);
    clearGameReset(roomCode);
  });

  socket.on("game:selection", (payload: { tileIds?: string[] }) => {
    log("game:selection", playerId, payload);
    const currentRoom = rooms.get(roomCode);
    if (!currentRoom) return;
    const sender = currentRoom.players.find((player) => player.id === playerId);
    if (sender?.isSpectator) return;
    const tileIds = Array.isArray(payload?.tileIds)
      ? payload.tileIds.filter((id): id is string => typeof id === "string")
      : [];
    socket.to(roomCode).emit("game:selection", { playerId, tileIds });
  });

  socket.on("disconnect", () => {
    log("socket disconnected", socket.id);
    handleSocketDisconnect(socket.id);
  });
});

if (fs.existsSync(clientDistPath)) {
  app.get("*", (_req: Request, res: Response) => {
    res.sendFile(path.join(clientDistPath, "index.html"));
  });
}

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Spellcast server listening on port ${PORT}`);
});

function sanitizeName(raw: string): string {
  return raw.trim().slice(0, 32);
}

function generateRoomId(): string {
  let id: string;
  do {
    id = Array.from({ length: 4 }, () =>
      String.fromCharCode(65 + Math.floor(Math.random() * 26))
    ).join("");
  } while (rooms.has(id));
  return id;
}

function broadcastRoom(roomId: string) {
  const room = rooms.get(roomId);
  if (room) {
    io.to(roomId).emit("room:update", room);
  }
}

function removePlayerFromRoom(roomId: string, playerId: string): boolean {
  const room = rooms.get(roomId);
  if (!room) return false;
  clearGameReset(roomId);
  const idx = room.players.findIndex((p) => p.id === playerId);
  if (idx === -1) return false;

  room.players.splice(idx, 1);
  if (!room.players.length) {
    rooms.delete(roomId);
    io.to(roomId).emit("room:update", { ...room, players: [] });
    return true;
  }

  if (room.hostId === playerId) {
    const nextHost = room.players.find((player) => !player.isSpectator) ?? room.players[0];
    if (nextHost) {
      room.hostId = nextHost.id;
      room.players.forEach((player) => {
        player.isHost = player.id === room.hostId;
      });
    }
  }

  if (room.game) {
    if (room.game.swapModePlayerId === playerId) {
      room.game.swapModePlayerId = undefined;
    }
    if (room.players.length === 0) {
      room.status = "lobby";
      room.game = undefined;
    }
    normalizeCurrentPlayer(room);
  }

  broadcastRoom(roomId);
  return true;
}

function forceRemovePlayer(roomId: string, playerId: string): boolean {
  const presence = playerPresence.get(playerId);
  if (presence) {
    presence.sockets.forEach((socketId) => {
      socketLookup.delete(socketId);
      io.sockets.sockets.get(socketId)?.disconnect(true);
    });
    if (presence.timeout) {
      clearTimeout(presence.timeout);
    }
    playerPresence.delete(playerId);
  }
  return removePlayerFromRoom(roomId, playerId);
}

function registerPresence(playerId: string, roomId: string, socket: Socket) {
  const existing = playerPresence.get(playerId);
  if (existing) {
    if (existing.timeout) {
      clearTimeout(existing.timeout);
      existing.timeout = undefined;
    }
    existing.sockets.add(socket.id);
  } else {
    playerPresence.set(playerId, {
      roomId,
      sockets: new Set([socket.id])
    });
  }
  socketLookup.set(socket.id, { roomId, playerId });

  const room = rooms.get(roomId);
  if (room) {
    const player = room.players.find((p) => p.id === playerId);
    if (player && !player.connected) {
      player.connected = true;
      broadcastRoom(roomId);
    }
  }
}

function handleSocketDisconnect(socketId: string) {
  const ctx = socketLookup.get(socketId);
  if (!ctx) return;
  socketLookup.delete(socketId);
  const presence = playerPresence.get(ctx.playerId);
  if (!presence) return;
  presence.sockets.delete(socketId);
  if (presence.sockets.size === 0) {
    const room = rooms.get(ctx.roomId);
    if (room) {
      const player = room.players.find((p) => p.id === ctx.playerId);
      if (player && player.connected) {
        player.connected = false;
        broadcastRoom(ctx.roomId);
      }
    }
    presence.timeout = setTimeout(() => {
      playerPresence.delete(ctx.playerId);
      removePlayerFromRoom(ctx.roomId, ctx.playerId);
    }, DISCONNECT_GRACE_MS);
  }
}

function scheduleGameReset(roomId: string) {
  if (gameResetTimers.has(roomId)) return;
  const timer = setTimeout(() => {
    gameResetTimers.delete(roomId);
    const room = rooms.get(roomId);
    if (!room) return;
    room.status = "lobby";
    room.game = undefined;
    room.players.forEach((player) => {
      player.isSpectator = false;
    });
    broadcastRoom(roomId);
  }, NEW_GAME_DELAY_MS);
  gameResetTimers.set(roomId, timer);
}

function clearGameReset(roomId: string) {
  const timer = gameResetTimers.get(roomId);
  if (timer) {
    clearTimeout(timer);
    gameResetTimers.delete(roomId);
  }
}

function ensurePlayerTurn(room: Room, playerId: string): boolean {
  const game = room.game;
  if (!game || !room.players.length) return false;
  const hasActive = room.players.some((player) => !player.isSpectator);
  if (!hasActive) return false;
  if (
    game.currentPlayerIndex >= room.players.length ||
    room.players[game.currentPlayerIndex]?.isSpectator
  ) {
    const firstActive = room.players.findIndex((player) => !player.isSpectator);
    if (firstActive === -1) return false;
    game.currentPlayerIndex = firstActive;
  }
  const current = room.players[game.currentPlayerIndex];
  return current?.id === playerId;
}

function loadDictionary(): Set<string> {
  const filePath = path.resolve(__dirname, "../../src/game/dictionary.txt");
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return new Set(
      raw
        .split(/\r?\n/)
        .map((word) => word.trim().toUpperCase())
        .filter(Boolean)
    );
  } catch (error) {
    console.error("Failed to load dictionary file.", error);
    return new Set();
  }
}

function normalizeCurrentPlayer(room: Room) {
  if (!room.game) return;
  if (!room.players.length) {
    room.game.currentPlayerIndex = 0;
    return;
  }
  if (
    room.game.currentPlayerIndex >= room.players.length ||
    room.players[room.game.currentPlayerIndex]?.isSpectator
  ) {
    const firstActive = room.players.findIndex((player) => !player.isSpectator);
    room.game.currentPlayerIndex = firstActive === -1 ? 0 : firstActive;
  }
}
