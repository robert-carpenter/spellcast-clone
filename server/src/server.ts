import cors from "cors";
import express, { Request, Response } from "express";
import { randomUUID } from "crypto";
import { createServer } from "http";
import { Server as SocketIOServer, Socket } from "socket.io";
import { Room, Player } from "./types";

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

const rooms = new Map<string, Room>();
const playerPresence = new Map<
  string,
  { roomId: string; sockets: Set<string>; timeout?: NodeJS.Timeout }
>();
const socketLookup = new Map<string, { roomId: string; playerId: string }>();

const MAX_PLAYERS = 6;
const DISCONNECT_GRACE_MS = 10_000;

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.post("/api/rooms", (req: Request, res: Response) => {
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
    joinedAt: Date.now()
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

app.get("/api/rooms/:roomId", (req, res) => {
  const room = rooms.get(req.params.roomId.toUpperCase());
  if (!room) {
    return res.status(404).json({ error: "Room not found" });
  }
  res.json(room);
});

app.post("/api/rooms/:roomId/join", (req: Request, res: Response) => {
  const roomId = req.params.roomId.toUpperCase();
  const room = rooms.get(roomId);
  if (!room) {
    return res.status(404).json({ error: "Room not found" });
  }
  if (room.status !== "lobby") {
    return res.status(400).json({ error: "Game already in progress" });
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

  const player: Player = {
    id: randomUUID(),
    name: sanitized,
    isHost: false,
    score: 0,
    gems: 3,
    joinedAt: Date.now()
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
  room.status = "in-progress";
  broadcastRoom(roomId);
  res.json({ room });
});

app.delete("/api/rooms/:roomId/players/:playerId", (req: Request, res: Response) => {
  const roomId = req.params.roomId.toUpperCase();
  const playerId = req.params.playerId;
  const room = rooms.get(roomId);
  if (!room) {
    return res.status(404).json({ error: "Room not found" });
  }

  const removed = forceRemovePlayer(roomId, playerId);
  if (!removed) {
    return res.status(404).json({ error: "Player not found" });
  }
  res.status(204).send();
});

io.on("connection", (socket) => {
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
  registerPresence(playerId, roomCode, socket);
  socket.emit("room:update", room);

  socket.on("disconnect", () => {
    handleSocketDisconnect(socket.id);
  });
});

httpServer.listen(PORT, () => {
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
  const idx = room.players.findIndex((p) => p.id === playerId);
  if (idx === -1) return false;

  room.players.splice(idx, 1);
  if (!room.players.length) {
    rooms.delete(roomId);
    io.to(roomId).emit("room:update", { ...room, players: [] });
    return true;
  }

  if (room.hostId === playerId) {
    room.hostId = room.players[0].id;
    room.players[0].isHost = true;
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
}

function handleSocketDisconnect(socketId: string) {
  const ctx = socketLookup.get(socketId);
  if (!ctx) return;
  socketLookup.delete(socketId);
  const presence = playerPresence.get(ctx.playerId);
  if (!presence) return;
  presence.sockets.delete(socketId);
  if (presence.sockets.size === 0) {
    presence.timeout = setTimeout(() => {
      playerPresence.delete(ctx.playerId);
      removePlayerFromRoom(ctx.roomId, ctx.playerId);
    }, DISCONNECT_GRACE_MS);
  }
}
