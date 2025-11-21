import {
  CanvasTexture,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Texture
} from "three";
import { LETTER_VALUES } from "./constants";

export type TileMesh = Mesh<PlaneGeometry, MeshBasicMaterial>;

export type TileState = "base" | "hover" | "selected";

export type Multiplier = "none" | "doubleLetter" | "tripleLetter";

export interface SelectionResult {
  selection: Tile[];
  success: boolean;
  action?: "added" | "removed";
  reason?: string;
}

export interface Tile {
  mesh: TileMesh;
  letter: string;
  x: number;
  y: number;
  state: TileState;
  hasGem: boolean;
  multiplier: Multiplier;
  badge?: Mesh;
}

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const GEM_CHANCE = 0.25;
const TRIPLE_CHANCE = 0.12;

export class WordBoard extends Group {
  public readonly cols: number;
  public readonly rows: number;
  public readonly tileSize = 1.3;

  private tiles: Tile[] = [];
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

  constructor(cols = 5, rows = 5) {
    super();
    this.cols = cols;
    this.rows = rows;
    this.name = "WordBoard";

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
      multiplier: tile.multiplier
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
      this.applyStyle(tile, this.selected.has(tile) ? "selected" : "base");
      this.updateMultiplierBadge(tile);
    });
    this.updateSelectionLine();
  }

  public rerollLetter(tile: Tile) {
    tile.letter = this.normalizeLetter(this.randomLetter());
    this.applyStyle(tile, this.selected.has(tile) ? "selected" : "base");
    this.updateSelectionLine();
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

    tilesData.forEach((data, index) => {
      const multiplier = index === specialIndex ? specialType : "none";
      const material = new MeshBasicMaterial({
        color: "#ffffff",
        map: this.getLetterTexture(data.letter, "base", data.hasGem),
        transparent: true
      });
      const mesh: TileMesh = new Mesh(this.baseGeometry, material);
      mesh.position.set(data.x * this.tileSize - offsetX, data.y * this.tileSize - offsetY, 0);
      mesh.userData.tileCoordinates = { x: data.x, y: data.y };

      const tile: Tile = {
        mesh,
        letter: data.letter,
        x: data.x,
        y: data.y,
        state: "base",
        hasGem: data.hasGem,
        multiplier
      };
      mesh.userData.tile = tile;
      this.tiles.push(tile);
      this.add(mesh);
      this.updateMultiplierBadge(tile);
    });
  }

  private randomLetter(): string {
    return LETTERS[Math.floor(Math.random() * LETTERS.length)];
  }

  private normalizeLetter(letter: string): string {
    const upper = (letter ?? "").trim().charAt(0).toUpperCase();
    return LETTERS.includes(upper) ? upper : LETTERS[Math.floor(Math.random() * LETTERS.length)];
  }

  private applyStyle(tile: Tile, state: TileState) {
    tile.state = state;
    tile.mesh.material.map = this.getLetterTexture(tile.letter, state, tile.hasGem);
    tile.mesh.material.needsUpdate = true;
  }

  private getLetterTexture(letter: string, state: TileState, hasGem: boolean): Texture {
    const key = `${letter}-${state}-${hasGem ? "gem" : "plain"}`;
    const cached = this.textureCache.get(key);
    if (cached) return cached;

    const tex = this.makeLetterTexture(letter, state, hasGem);
    this.textureCache.set(key, tex);
    return tex;
  }

  private makeLetterTexture(letter: string, state: TileState, hasGem: boolean): Texture {
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
