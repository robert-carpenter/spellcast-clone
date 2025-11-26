import "dotenv/config";
import cors from "cors";
import express from "express";
import type { Request, Response } from "express";
import { randomUUID, createHmac, timingSafeEqual } from "crypto";
import { createServer } from "http";
import type { Server as HttpServer } from "http";
import { Server as SocketIOServer, Socket } from "socket.io";
import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import {
  addLogEntry,
  applySwap,
  cancelSwap,
  advanceRound,
  advanceTurn,
  requestSwapMode,
  shuffleBoard,
  startNewGame,
  submitWord
} from "../shared/rules.js";
import { Room, Player } from "./types.js";

interface BackendOptions {
  serveClient?: boolean;
  clientDistPath?: string;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_ROUND_COUNT = 5;
const ROUND_OPTIONS = [3, 5];
const rooms = new Map<string, Room>();
const playerPresence = new Map<
  string,
  { roomId: string; sockets: Set<string>; timeout?: NodeJS.Timeout }
>();
const socketLookup = new Map<string, { roomId: string; playerId: string }>();
const gameResetTimers = new Map<string, NodeJS.Timeout>();
let activeIo: SocketIOServer | null = null;

const MAX_PLAYERS = 6;
const DISCONNECT_GRACE_MS = 5 * 60 * 1000; // allow mobile browsers to background for up to 5 minutes
const NEW_GAME_DELAY_MS = 5000;
const DICTIONARY = loadDictionary();
const SESSION_COOKIE = "discord_session";
const STATE_COOKIE = "discord_state";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const DISCORD_API = "https://discord.com/api";
const SESSION_SECRET = process.env.SESSION_SECRET || "changeme";

type ExpressApp = ReturnType<typeof express>;

export function initializeBackend(
  app: ExpressApp,
  httpServer: HttpServer,
  options: BackendOptions = {}
) {
  app.use(cors());
  app.use(express.json());

  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: "*",
      methods: ["GET", "POST", "DELETE"]
    }
  });
  activeIo = io;

  registerHttpRoutes(app, options);
  registerSocketHandlers(io);

  return { io };
}

function registerHttpRoutes(app: ExpressApp, options: BackendOptions) {
  const serveClient = options.serveClient ?? true;
  const candidateDirs = [
    options.clientDistPath,
    path.resolve(__dirname, "../client"),
    path.resolve(process.cwd(), "dist/client")
  ].filter((dir): dir is string => Boolean(dir));
  const staticDir = candidateDirs.find((dir) => fs.existsSync(dir));
  const canServeStatic = serveClient && Boolean(staticDir);
  if (canServeStatic && staticDir) {
    log("Serving static assets from", staticDir);
    app.use(express.static(staticDir));
  }

  app.get("/api/health", (_req: Request, res: Response) => {
    log("GET /api/health");
    res.json({ status: "ok" });
  });

  app.get("/auth/discord/login", (_req: Request, res: Response) => {
    const clientId = process.env.DISCORD_CLIENT_ID;
    const redirectUri = process.env.DISCORD_REDIRECT_URI;
    if (!clientId || !redirectUri) {
      return res.status(500).json({ error: "Discord OAuth not configured" });
    }
    const state = randomUUID();
    setCookie(res, STATE_COOKIE, signToken({ state, exp: Date.now() + STATE_TTL_MS }), {
      httpOnly: true,
      sameSite: "lax",
      secure: isProduction(),
      maxAge: STATE_TTL_MS / 1000
    });
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "identify",
      state
    });
    res.redirect(`${DISCORD_API}/oauth2/authorize?${params.toString()}`);
  });

  app.get("/auth/discord/callback", async (req: Request, res: Response) => {
    const code = req.query.code as string | undefined;
    const state = req.query.state as string | undefined;
    const clientId = process.env.DISCORD_CLIENT_ID;
    const clientSecret = process.env.DISCORD_CLIENT_SECRET;
    const redirectUri = process.env.DISCORD_REDIRECT_URI;
    if (!code || !state || !clientId || !clientSecret || !redirectUri) {
      return res.redirect("/?auth=failed");
    }

    const storedState = getSessionFromCookie(req, STATE_COOKIE);
    if (!storedState || storedState.state !== state || storedState.exp < Date.now()) {
      return res.redirect("/?auth=failed");
    }

    try {
      const tokenRes = await fetch(`${DISCORD_API}/oauth2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri
        })
      });
      if (!tokenRes.ok) throw new Error("token exchange failed");
      const tokenJson = (await tokenRes.json()) as { access_token?: string; token_type?: string };
      const accessToken = tokenJson.access_token;
      const tokenType = tokenJson.token_type;
      if (!accessToken || !tokenType) throw new Error("missing token");

      const userRes = await fetch(`${DISCORD_API}/users/@me`, {
        headers: { Authorization: `${tokenType} ${accessToken}` }
      });
      if (!userRes.ok) throw new Error("user fetch failed");
      const user = (await userRes.json()) as { id: string; username: string; global_name?: string };
      const displayName = user.global_name || user.username || "Wizard";

      const session = signToken({
        id: user.id,
        name: displayName,
        exp: Date.now() + SESSION_TTL_MS
      });
      setCookie(res, SESSION_COOKIE, session, {
        httpOnly: true,
        sameSite: "lax",
        secure: isProduction(),
        maxAge: SESSION_TTL_MS / 1000
      });
      clearCookie(res, STATE_COOKIE);
      res.redirect("/");
    } catch (error) {
      console.warn("discord auth failed", error);
      res.redirect("/?auth=failed");
    }
  });

  app.get("/auth/session", (req: Request, res: Response) => {
    const session = getSessionFromCookie(req, SESSION_COOKIE);
    if (!session || session.exp < Date.now()) {
      clearCookie(res, SESSION_COOKIE);
      return res.status(401).json({ authenticated: false });
    }
    res.json({ authenticated: true, user: { id: session.id, name: session.name } });
  });

  app.post("/auth/logout", (_req: Request, res: Response) => {
    clearCookie(res, SESSION_COOKIE);
    res.json({ success: true });
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
      status: "lobby",
      rounds: DEFAULT_ROUND_COUNT
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
  const eligibleToJoinActive =
    joiningMidGame && room.game && room.game.round === 1 && !room.game.completed;
  const player: Player = {
    id: randomUUID(),
    name: sanitized,
    isHost: false,
    score: 0,
    gems: 3,
    joinedAt: Date.now(),
    connected: false,
    isSpectator: joiningMidGame && !eligibleToJoinActive
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
  shuffleActivePlayers(room);
  room.status = "in-progress";
  clearGameReset(roomId);
  startNewGame(room, room.rounds);
  broadcastRoom(roomId);
  res.json({ room });
  });

  app.patch("/api/rooms/:roomId/settings", (req: Request, res: Response) => {
    log("PATCH /api/rooms/:roomId/settings", req.params.roomId, req.body);
    const roomId = req.params.roomId.toUpperCase();
    const room = rooms.get(roomId);
    if (!room) {
      return res.status(404).json({ error: "Room not found" });
    }
    const { playerId, rounds } = req.body ?? {};
    if (typeof playerId !== "string") {
      return res.status(400).json({ error: "playerId is required" });
    }
    if (room.hostId !== playerId) {
      return res.status(403).json({ error: "Only the host can update settings" });
    }
    if (room.status !== "lobby") {
      return res.status(400).json({ error: "Cannot change settings after the game starts" });
    }
    const parsedRounds = Number(rounds);
    if (!ROUND_OPTIONS.includes(parsedRounds)) {
      return res.status(400).json({ error: "Invalid round selection" });
    }
    room.rounds = parsedRounds;
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

  if (canServeStatic && staticDir) {
    app.get("*", (_req: Request, res: Response) => {
      res.sendFile(path.join(staticDir, "index.html"));
    });
  }
}

function registerSocketHandlers(io: SocketIOServer) {
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

    socket.on("game:skip", (payload: { playerId?: string }) => {
      log("game:skip", playerId, payload);
      const currentRoom = rooms.get(roomCode);
      if (!currentRoom) return;
      if (currentRoom.hostId !== playerId) {
        return socket.emit("game:error", { message: "Only the host can skip turns." });
      }
      if (!currentRoom.game || currentRoom.status !== "in-progress") {
        return socket.emit("game:error", { message: "No active game to skip." });
      }
      const targetId = typeof payload?.playerId === "string" ? payload.playerId : undefined;
      const currentPlayer = currentRoom.players[currentRoom.game.currentPlayerIndex];
      if (!currentPlayer || (targetId && targetId !== currentPlayer.id)) {
        return socket.emit("game:error", { message: "Player is not currently taking a turn." });
      }
      advanceTurn(currentRoom);
      if (currentRoom.game && currentPlayer) {
        addLogEntry(
          currentRoom.game,
          `Round ${currentRoom.game.round}: ${currentPlayer.name}'s turn was skipped by the host.`
        );
      }
      broadcastRoom(roomCode);
    });

    socket.on("disconnect", () => {
      log("socket disconnected", socket.id);
      handleSocketDisconnect(socket.id);
    });
  });
}

function log(...args: unknown[]) {
  console.log("[server]", ...args);
}

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
  if (room && activeIo) {
    activeIo.to(roomId).emit("room:update", room);
  }
}

function shuffleActivePlayers(room: Room) {
  const active = room.players.filter((player) => !player.isSpectator);
  for (let i = active.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [active[i], active[j]] = [active[j], active[i]];
  }
  const spectators = room.players.filter((player) => player.isSpectator);
  room.players = [...active, ...spectators];
}

function signToken(payload: Record<string, unknown>): string {
  const json = JSON.stringify(payload);
  const data = Buffer.from(json).toString("base64url");
  const sig = createHmac("sha256", SESSION_SECRET).update(data).digest("base64url");
  return `${data}.${sig}`;
}

function verifyToken<T>(token: string): T | null {
  const [data, sig] = token.split(".");
  if (!data || !sig) return null;
  const expected = createHmac("sha256", SESSION_SECRET).update(data).digest("base64url");
  if (!safeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const json = Buffer.from(data, "base64url").toString("utf8");
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.cookie;
  if (!header) return {};
  const parts = header.split(";");
  return parts.reduce((acc: Record<string, string>, part: string) => {
    const [key, ...rest] = part.split("=");
    acc[key.trim()] = decodeURIComponent(rest.join("=").trim());
    return acc;
  }, {} as Record<string, string>);
}

function getSessionFromCookie(req: Request, name: string): { id: string; name: string; exp: number; state?: string } | null {
  const cookies = parseCookies(req);
  const token = cookies[name];
  if (!token) return null;
  return verifyToken<{ id: string; name: string; exp: number; state?: string }>(token);
}

function setCookie(
  res: Response,
  name: string,
  value: string,
  options: { httpOnly?: boolean; secure?: boolean; sameSite?: "lax" | "strict" | "none"; maxAge?: number }
) {
  const attrs = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    options.httpOnly ? "HttpOnly" : "",
    options.secure ? "Secure" : "",
    options.sameSite ? `SameSite=${options.sameSite}` : "SameSite=Lax",
    typeof options.maxAge === "number" ? `Max-Age=${Math.floor(options.maxAge)}` : ""
  ]
    .filter(Boolean)
    .join("; ");
  res.append("Set-Cookie", attrs);
}

function clearCookie(res: Response, name: string) {
  res.append("Set-Cookie", `${name}=; Path=/; Max-Age=0; SameSite=Lax`);
}

function isProduction() {
  return process.env.NODE_ENV === "production";
}

function removePlayerFromRoom(roomId: string, playerId: string): boolean {
  const room = rooms.get(roomId);
  if (!room) return false;
  clearGameReset(roomId);
  const idx = room.players.findIndex((p) => p.id === playerId);
  if (idx === -1) return false;

  const playersBeforeRemoval = [...room.players];
  const game = room.game;
  const activeGame = Boolean(room.status === "in-progress" && game && !game.completed);
  const wasCurrentPlayer = Boolean(activeGame && game && game.currentPlayerIndex === idx);
  const nextTurn =
    wasCurrentPlayer && game
      ? getNextTurnAfterRemoval(playersBeforeRemoval, idx)
      : null;
  let preservedIndex = game ? game.currentPlayerIndex : 0;
  if (game && !wasCurrentPlayer && game.currentPlayerIndex > idx) {
    preservedIndex = game.currentPlayerIndex - 1;
  }

  room.players.splice(idx, 1);
  if (!room.players.length) {
    rooms.delete(roomId);
    activeIo?.to(roomId).emit("room:update", { ...room, players: [] });
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

  const currentGame = room.game;
  if (currentGame) {
    if (currentGame.swapModePlayerId === playerId) {
      currentGame.swapModePlayerId = undefined;
    }
    if (room.players.length === 0) {
      room.status = "lobby";
      room.game = undefined;
    } else if (wasCurrentPlayer) {
      if (nextTurn) {
        currentGame.currentPlayerIndex = Math.min(nextTurn.index, room.players.length - 1);
        if (nextTurn.wrapped) {
          advanceRound(room);
        }
      } else {
        currentGame.currentPlayerIndex = 0;
        normalizeCurrentPlayer(room);
      }
    }
    if (!wasCurrentPlayer && room.game) {
      room.game.currentPlayerIndex = Math.min(preservedIndex, room.players.length - 1);
      normalizeCurrentPlayer(room);
    }
  }

  broadcastRoom(roomId);
  return true;
}

function forceRemovePlayer(roomId: string, playerId: string): boolean {
  const presence = playerPresence.get(playerId);
  if (presence) {
    presence.sockets.forEach((socketId) => {
      const sock = activeIo?.sockets.sockets.get(socketId);
      if (sock) {
        sock.emit("room:kicked", { roomId });
      }
      socketLookup.delete(socketId);
      sock?.disconnect(true);
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

function getNextTurnAfterRemoval(
  players: Player[],
  removedIndex: number
): { index: number; wrapped: boolean } | null {
  for (let i = removedIndex + 1; i < players.length; i += 1) {
    if (!players[i].isSpectator) {
      return { index: i - 1, wrapped: false };
    }
  }
  for (let i = 0; i < removedIndex; i += 1) {
    if (!players[i].isSpectator) {
      return { index: i, wrapped: true };
    }
  }
  return null;
}

function loadDictionary(): Set<string> {
  const candidates = [
    path.resolve(__dirname, "../../src/game/dictionary.txt"),
    path.resolve(process.cwd(), "src/game/dictionary.txt"),
    path.resolve(__dirname, "../client/dictionary.txt"),
    path.resolve(process.cwd(), "dist/client/dictionary.txt"),
    path.resolve(__dirname, "dictionary.txt")
  ];
  const filePath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!filePath) {
    console.error("Dictionary file not found in expected locations.");
    return new Set();
  }
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

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return pathToFileURL(entry).href === import.meta.url;
}

if (isMainModule()) {
  const app = express();
  const httpServer = createServer(app);
  initializeBackend(app, httpServer, {
    serveClient: true,
    clientDistPath: path.resolve(process.cwd(), "dist/client")
  });
  const PORT = Number(process.env.PORT ?? 4000);
  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Spellcast server listening on port ${PORT}`);
  });
}
