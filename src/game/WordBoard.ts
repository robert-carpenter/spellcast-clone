import {
  CanvasTexture,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Texture
} from "three";
import type { TileModel } from "../../shared/gameTypes";
import { LETTER_VALUES } from "./constants";

export type TileMesh = Mesh<PlaneGeometry, MeshBasicMaterial>;

export type TileState = "base" | "hover" | "selected";
export type Multiplier = "none" | "doubleLetter" | "tripleLetter";
export type WordMultiplier = "none" | "doubleWord";

export interface SelectionResult {
  selection: Tile[];
  success: boolean;
  action?: "added" | "removed";
  reason?: string;
}

export interface Tile {
  id: string;
  mesh: TileMesh;
  letter: string;
  x: number;
  y: number;
  state: TileState;
  hasGem: boolean;
  multiplier: Multiplier;
  badge?: Mesh<PlaneGeometry, MeshBasicMaterial>;
  wordMultiplier: WordMultiplier;
  wordBadge?: Mesh<PlaneGeometry, MeshBasicMaterial>;
}

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const VOWELS = "AEIOU";
const CONSONANTS = LETTERS.split("").filter((ch) => !VOWELS.includes(ch)).join("");
const GEM_CHANCE = 0.5;
const TRIPLE_CHANCE = 0.12;

interface WordBoardOptions {
  vowelRatio?: number;
}

export class WordBoard extends Group {
  public readonly cols: number;
  public readonly rows: number;
  public readonly tileSize = 1.3;

  private tiles: Tile[] = [];
  private tileMap = new Map<string, Tile>();
  private hovered?: Tile;
  private selected = new Set<Tile>();
  private selectedOrder: Tile[] = [];
  private baseGeometry = new PlaneGeometry(1, 1);
  private textureCache = new Map<string, Texture>();
  private connectionsGroup = new Group();
  private connectionGeometry = new PlaneGeometry(1, 1);
  private connectionMaterial: MeshBasicMaterial;
  private connectionPool: Mesh<PlaneGeometry, MeshBasicMaterial>[] = [];
  private activeConnections: Mesh<PlaneGeometry, MeshBasicMaterial>[] = [];
  private connectionThickness = 0.2;
  private badgeGeometry = new PlaneGeometry(0.55, 0.55);
  private badgeMaterials = new Map<Multiplier, MeshBasicMaterial>();
  private wordBadgeGeometry = new PlaneGeometry(0.5, 0.5);
  private wordBadgeMaterial?: MeshBasicMaterial;
  private multipliersEnabled = true;
  private swapMode = false;
  private wordMultiplierEnabled = true;
  private vowelRatio = 0.4;

  constructor(cols = 5, rows = 5, options: WordBoardOptions = {}) {
    super();
    this.cols = cols;
    this.rows = rows;
    this.name = "WordBoard";
    if (typeof options.vowelRatio === "number") {
      this.setVowelRatio(options.vowelRatio);
    }

    this.connectionMaterial = new MeshBasicMaterial({
      color: "#39b9ff",
      transparent: true,
      opacity: 0.9
    });

    this.connectionsGroup.position.z = -0.04;
    this.add(this.connectionsGroup);

    this.buildTiles();
  }

  public allTiles(): Tile[] {
    return this.tiles;
  }

  public getTileById(id: string): Tile | undefined {
    return this.tileMap.get(id);
  }

  public getTileId(tile: Tile): string {
    return tile.id;
  }

  public applyExternalState(states: TileModel[]) {
    const selectionSet = new Set(this.selected);
    states.forEach((state) => {
      const tile = this.tileMap.get(state.id);
      if (!tile) return;
      tile.letter = state.letter;
      tile.hasGem = state.hasGem;
      tile.multiplier = state.multiplier;
      tile.wordMultiplier = state.wordMultiplier;
      const nextState = selectionSet.has(tile)
        ? "selected"
        : tile === this.hovered
          ? "hover"
          : "base";
      this.applyStyle(tile, nextState);
      this.updateMultiplierBadge(tile);
      this.updateWordMultiplierBadge(tile);
      this.updateSwapTint(tile);
    });
    this.updateSelectionLine();
  }

  public setSelectionFromIds(tileIds: string[]) {
    this.clearSelection();
    tileIds.forEach((id) => {
      const tile = this.tileMap.get(id);
      if (!tile) return;
      this.selected.add(tile);
      this.selectedOrder.push(tile);
      this.applyStyle(tile, "selected");
    });
    this.updateSelectionLine();
  }

  public setHovered(tile?: Tile) {
    if (this.hovered === tile) return;

    if (this.hovered && !this.selected.has(this.hovered)) {
      this.applyStyle(this.hovered, "base");
    }

    this.hovered = tile;

    if (this.hovered && !this.selected.has(this.hovered)) {
      this.applyStyle(this.hovered, "hover");
    }
  }

  public selectTile(tile: Tile): SelectionResult {
    const last = this.selectedOrder[this.selectedOrder.length - 1];

    if (this.selected.has(tile)) {
      if (last !== tile) {
        return {
          selection: [...this.selectedOrder],
          success: false,
          reason: "Undo letters in reverse order."
        };
      }

      this.selected.delete(tile);
      this.selectedOrder.pop();
      this.applyStyle(tile, tile === this.hovered ? "hover" : "base");
      this.updateSelectionLine();
      return {
        selection: [...this.selectedOrder],
        success: true,
        action: "removed"
      };
    }

    if (last && !this.areNeighbors(last, tile)) {
      return {
        selection: [...this.selectedOrder],
        success: false,
        reason: "Next letter must touch the previous tile."
      };
    }

    this.selected.add(tile);
    this.selectedOrder.push(tile);
    this.applyStyle(tile, "selected");
    this.updateSelectionLine();
    return {
      selection: [...this.selectedOrder],
      success: true,
      action: "added"
    };
  }

  public clearSelection() {
    for (const tile of this.selected) {
      this.applyStyle(tile, tile === this.hovered ? "hover" : "base");
    }
    this.selected.clear();
    this.selectedOrder = [];
    this.updateSelectionLine();
  }

  public getSelection(): Tile[] {
    return [...this.selectedOrder];
  }

  public collectGemsFromSelection(): number {
    let collected = 0;
    for (const tile of this.selectedOrder) {
      if (tile.hasGem) {
        collected += 1;
        tile.hasGem = false;
        this.applyStyle(tile, tile.state);
      }
    }
    return collected;
  }

  public shuffleLetters() {
    if (!this.tiles.length) return;
    const payload = this.tiles.map((tile) => ({
      letter: tile.letter,
      hasGem: tile.hasGem,
      multiplier: tile.multiplier,
      wordMultiplier: tile.wordMultiplier
    }));

    for (let i = payload.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [payload[i], payload[j]] = [payload[j], payload[i]];
    }

    this.tiles.forEach((tile, index) => {
      const data = payload[index];
      tile.letter = data.letter;
      tile.hasGem = data.hasGem;
      tile.multiplier = data.multiplier;
      tile.wordMultiplier = data.wordMultiplier;
      this.applyStyle(tile, this.selected.has(tile) ? "selected" : "base");
      this.updateMultiplierBadge(tile);
      this.updateWordMultiplierBadge(tile);
    });
    this.updateSelectionLine();
  }

  public rerollLetter(tile: Tile) {
    tile.letter = this.normalizeLetter(this.randomLetter());
    this.applyStyle(tile, this.selected.has(tile) ? "selected" : "base");
    this.updateSelectionLine();
  }

  public swapTileLetter(tile: Tile, letter: string) {
    tile.letter = this.normalizeLetter(letter);
    this.applyStyle(tile, this.selected.has(tile) ? "selected" : "base");
  }

  public setSwapMode(active: boolean) {
    if (this.swapMode === active) return;
    this.swapMode = active;
    this.tiles.forEach((tile) => this.updateSwapTint(tile));
  }

  public setVowelRatio(ratio: number) {
    if (Number.isNaN(ratio)) return;
    this.vowelRatio = Math.min(0.9, Math.max(0.1, ratio));
  }

  public refreshTiles(tiles: Tile[], resetWordMultiplier = false) {
    let consumedLetterMultiplier = false;
    let consumedWordMultiplier = false;

    tiles.forEach((tile) => {
      if (tile.multiplier !== "none") consumedLetterMultiplier = true;
      if (tile.wordMultiplier === "doubleWord") consumedWordMultiplier = true;

      tile.letter = this.normalizeLetter(this.randomLetter());
      tile.hasGem = Math.random() < GEM_CHANCE;
      tile.multiplier = "none";
      if (resetWordMultiplier || tile.wordMultiplier === "doubleWord") {
        tile.wordMultiplier = "none";
      }

      this.applyStyle(tile, this.selected.has(tile) ? "selected" : "base");
      this.updateMultiplierBadge(tile);
      this.updateWordMultiplierBadge(tile);
      this.updateSwapTint(tile);
    });

    this.ensureMultiplier(tiles);
    if (
      this.wordMultiplierEnabled &&
      (resetWordMultiplier ||
        consumedWordMultiplier ||
        !this.tiles.some((t) => t.wordMultiplier === "doubleWord"))
    ) {
      this.ensureWordMultiplier(tiles);
    }

    this.updateSelectionLine();
  }

  public setMultipliersEnabled(enabled: boolean) {
    this.multipliersEnabled = enabled;
    if (!enabled) {
      this.tiles.forEach((tile) => {
        tile.multiplier = "none";
        this.applyStyle(tile, this.selected.has(tile) ? "selected" : "base");
        this.updateMultiplierBadge(tile);
      });
    } else {
      this.ensureMultiplier();
    }
  }

  public setWordMultiplierEnabled(enabled: boolean) {
    this.wordMultiplierEnabled = enabled;
    if (!enabled) {
      this.tiles.forEach((tile) => {
        tile.wordMultiplier = "none";
        this.updateWordMultiplierBadge(tile);
      });
    } else {
      this.ensureWordMultiplier();
    }
  }

  public width(): number {
    return (this.cols - 1) * this.tileSize;
  }

  public height(): number {
    return (this.rows - 1) * this.tileSize;
  }

  private areNeighbors(a: Tile, b: Tile): boolean {
    const dx = Math.abs(a.x - b.x);
    const dy = Math.abs(a.y - b.y);
    return dx <= 1 && dy <= 1 && !(dx === 0 && dy === 0);
  }

  private acquireConnectionMesh(): Mesh<PlaneGeometry, MeshBasicMaterial> {
    const mesh = this.connectionPool.pop();
    if (mesh) {
      mesh.visible = true;
      return mesh;
    }

    const newMesh = new Mesh(this.connectionGeometry, this.connectionMaterial);
    newMesh.visible = true;
    newMesh.renderOrder = -1;
    return newMesh;
  }

  private releaseActiveConnections() {
    for (const mesh of this.activeConnections) {
      mesh.visible = false;
      this.connectionsGroup.remove(mesh);
      this.connectionPool.push(mesh);
    }
    this.activeConnections = [];
  }

  private ensureMultiplier(exclude: Tile[] = []) {
    if (!this.multipliersEnabled) return;
    const existing = this.tiles.find((tile) => tile.multiplier !== "none");
    if (existing) return;

    const excludedSet = new Set(exclude);
    let candidates = this.tiles.filter((tile) => tile.multiplier === "none" && !excludedSet.has(tile));
    if (!candidates.length) {
      candidates = this.tiles.filter((tile) => tile.multiplier === "none");
    }
    if (!candidates.length) return;

    const target = candidates[Math.floor(Math.random() * candidates.length)];
    target.multiplier = Math.random() < TRIPLE_CHANCE ? "tripleLetter" : "doubleLetter";
    this.applyStyle(target, this.selected.has(target) ? "selected" : "base");
    this.updateMultiplierBadge(target);
  }

  private ensureWordMultiplier(exclude: Tile[] = []) {
    if (!this.wordMultiplierEnabled) return;
    const existing = this.tiles.find((tile) => tile.wordMultiplier === "doubleWord");
    if (existing) return;

    const excludedSet = new Set(exclude);
    let candidates = this.tiles.filter(
      (tile) => tile.wordMultiplier === "none" && !excludedSet.has(tile)
    );
    if (!candidates.length) {
      candidates = this.tiles.filter((tile) => tile.wordMultiplier === "none");
    }
    if (!candidates.length) return;

    const target = candidates[Math.floor(Math.random() * candidates.length)];
    target.wordMultiplier = "doubleWord";
    this.updateWordMultiplierBadge(target);
  }

  private createMultiplierBadge(multiplier: Multiplier): Mesh {
    let material = this.badgeMaterials.get(multiplier);
    if (!material) {
      const texture = this.generateBadgeTexture(multiplier);
      material = new MeshBasicMaterial({
        map: texture,
        transparent: true
      });
      this.badgeMaterials.set(multiplier, material);
    }
    const mesh = new Mesh(this.badgeGeometry, material);
    mesh.renderOrder = 5;
    return mesh;
  }

  private generateBadgeTexture(multiplier: Multiplier): CanvasTexture {
    const size = 256;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Failed to get 2d context");

    ctx.fillStyle = multiplier === "tripleLetter" ? "#f2a93d" : "#536cff";
    ctx.strokeStyle = "rgba(0,0,0,0.45)";
    ctx.lineWidth = 18;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - 18, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = "#fff";
    ctx.font = "bold 140px 'Play', 'Segoe UI', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(multiplier === "tripleLetter" ? "TL" : "DL", size / 2, size / 2 + 10);

    const texture = new CanvasTexture(canvas);
    texture.needsUpdate = true;
    return texture;
  }

  private updateMultiplierBadge(tile: Tile) {
    if (tile.badge) {
      tile.mesh.remove(tile.badge);
      tile.badge = undefined;
    }
    if (tile.multiplier === "none") return;

    const badge = this.createMultiplierBadge(tile.multiplier);
    badge.scale.set(.8,.8,.8);
    badge.position.set(-0.45, 0.45, 0.05);
    tile.mesh.add(badge);
    tile.badge = badge;
  }

  private updateSwapTint(tile: Tile) {
    tile.mesh.material.color.set(this.swapMode ? 0xC4E6F5 : 0xffffff);
  }

  private updateWordMultiplierBadge(tile: Tile) {
    if (tile.wordBadge) {
      tile.mesh.remove(tile.wordBadge);
      tile.wordBadge = undefined;
    }
    if (tile.wordMultiplier === "none") return;
    const badge = this.createWordMultiplierBadge();
    badge.position.set(0.45, 0.45, 0.05);
    tile.mesh.add(badge);
    tile.wordBadge = badge;
  }

  private createWordMultiplierBadge(): Mesh<PlaneGeometry, MeshBasicMaterial> {
    if (!this.wordBadgeMaterial) {
      const texture = this.generateWordMultiplierBadgeTexture();
      this.wordBadgeMaterial = new MeshBasicMaterial({
        map: texture,
        transparent: true
      });
    }
    const mesh = new Mesh(this.wordBadgeGeometry, this.wordBadgeMaterial);
    mesh.renderOrder = 5;
    return mesh;
  }

  private generateWordMultiplierBadgeTexture(): CanvasTexture {
    const size = 256;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Failed to get 2d context");

    ctx.fillStyle = "#2cd0a5";
    ctx.strokeStyle = "rgba(0,0,0,0.45)";
    ctx.lineWidth = 18;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - 18, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = "#fff";
    ctx.font = "bold 120px 'Play', 'Segoe UI', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("2W", size / 2, size / 2 + 10);

    const texture = new CanvasTexture(canvas);
    texture.needsUpdate = true;
    return texture;
  }

  private updateSelectionLine() {
    this.releaseActiveConnections();
    if (this.selectedOrder.length < 2) {
      return;
    }

    for (let i = 0; i < this.selectedOrder.length - 1; i += 1) {
      const start = this.selectedOrder[i].mesh.position;
      const end = this.selectedOrder[i + 1].mesh.position;
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const length = Math.hypot(dx, dy) || 0.0001;

      const connection = this.acquireConnectionMesh();
      connection.scale.set(length, this.connectionThickness, 1);
      connection.position.set((start.x + end.x) / 2, (start.y + end.y) / 2, -0.04);
      connection.rotation.set(0, 0, Math.atan2(dy, dx));

      this.connectionsGroup.add(connection);
      this.activeConnections.push(connection);
    }
  }

  private buildTiles() {
    const offsetX = (this.cols - 1) * (this.tileSize / 2);
    const offsetY = (this.rows - 1) * (this.tileSize / 2);

    const total = this.cols * this.rows;
    const tilesData = [];

    for (let y = 0; y < this.rows; y += 1) {
      for (let x = 0; x < this.cols; x += 1) {
        const letter = this.normalizeLetter(this.randomLetter());
        const hasGem = Math.random() < GEM_CHANCE;
        tilesData.push({ x, y, letter, hasGem });
      }
    }

    const specialIndex = Math.floor(Math.random() * total);
    const specialType: Multiplier = Math.random() < TRIPLE_CHANCE ? "tripleLetter" : "doubleLetter";
    const wordIndex = this.wordMultiplierEnabled ? Math.floor(Math.random() * total) : -1;

    tilesData.forEach((data, index) => {
      const multiplier = index === specialIndex ? specialType : "none";
      const wordMultiplier: WordMultiplier =
        this.wordMultiplierEnabled && index === wordIndex ? "doubleWord" : "none";
      const material = new MeshBasicMaterial({
        color: "#ffffff",
        map: this.getLetterTexture(data.letter, "base", data.hasGem, multiplier),
        transparent: true
      });
      const mesh: TileMesh = new Mesh(this.baseGeometry, material);
      mesh.position.set(data.x * this.tileSize - offsetX, data.y * this.tileSize - offsetY, 0);
      mesh.userData.tileCoordinates = { x: data.x, y: data.y };

      const tile: Tile = {
        id: `${data.x}-${data.y}`,
        mesh,
        letter: data.letter,
        x: data.x,
        y: data.y,
        state: "base",
        hasGem: data.hasGem,
        multiplier,
        wordMultiplier
      };
      mesh.userData.tile = tile;
      mesh.userData.tileId = tile.id;
      this.tiles.push(tile);
      this.tileMap.set(tile.id, tile);
      this.add(mesh);
      this.updateMultiplierBadge(tile);
      this.updateWordMultiplierBadge(tile);
    });

    this.ensureMultiplier();
    this.ensureWordMultiplier();
  }

  private randomLetter(): string {
    const useVowel = Math.random() < this.vowelRatio;
    const pool = useVowel ? VOWELS : CONSONANTS;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  private normalizeLetter(letter: string): string {
    const upper = (letter ?? "").trim().charAt(0).toUpperCase();
    return LETTERS.includes(upper) ? upper : LETTERS[Math.floor(Math.random() * LETTERS.length)];
  }

  private applyStyle(tile: Tile, state: TileState) {
    tile.state = state;
    tile.mesh.material.map = this.getLetterTexture(tile.letter, state, tile.hasGem, tile.multiplier);
    tile.mesh.material.needsUpdate = true;
    this.updateSwapTint(tile);
  }

  private getLetterTexture(letter: string, state: TileState, hasGem: boolean, multiplier: Multiplier): Texture {
    const key = `${letter}-${state}-${hasGem ? "gem" : "plain"}-${multiplier}`;
    const cached = this.textureCache.get(key);
    if (cached) return cached;

    const tex = this.makeLetterTexture(letter, state, hasGem, multiplier);
    this.textureCache.set(key, tex);
    return tex;
  }

  private makeLetterTexture(letter: string, state: TileState, hasGem: boolean, multiplier: Multiplier): Texture {
    const size = 256;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");

    if (!ctx) throw new Error("Failed to get 2d context");

    const palette: Record<TileState, { bg: string; text: string; shadow: string }> = {
      base: { bg: "#f8f9fb", text: "#111111", shadow: "rgba(0,0,0,0.25)" },
      hover: { bg: "#d8dbe3", text: "#111111", shadow: "rgba(0,0,0,0.22)" },
      selected: { bg: "#39b9ff", text: "#f7fbff", shadow: "rgba(8, 85, 140, 0.55)" }
    };

    const colors = palette[state];

    ctx.fillStyle = colors.bg;
    ctx.fillRect(0, 0, size, size);

    ctx.fillStyle = colors.text;
    ctx.font = "bold 140px Play, 'Segoe UI', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.shadowColor = colors.shadow;
    ctx.shadowBlur = state === "selected" ? 22 : 14;
    ctx.fillText(letter, size / 2, size / 2 + 5);

    // Draw letter value bottom right
    const valueColor =
      state === "selected" ? "rgba(245,249,255,0.95)" : "rgba(0,0,0,0.78)";
    const value = LETTER_VALUES[letter.toLowerCase()] ?? 0;
    if (value) {
      ctx.fillStyle = valueColor;
      ctx.font = "bold 46px 'Segoe UI', sans-serif";
      ctx.textAlign = "right";
      ctx.textBaseline = "bottom";
      ctx.shadowColor = "rgba(0,0,0,0.15)";
      ctx.shadowBlur = 6;
      ctx.fillText(String(value), size - 22, size - 18);
    }

    if (hasGem) {
      ctx.save();
      ctx.translate(size * 0.78, size * 0.78);
      ctx.fillStyle = "#f26cff";
      ctx.strokeStyle = "rgba(0,0,0,0.4)";
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.rect(-180, 0, 36, 36);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }

    const texture = new CanvasTexture(canvas);
    texture.needsUpdate = true;
    return texture;
  }
}
