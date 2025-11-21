import {
  CanvasTexture,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Texture
} from "three";
import { Line2 } from "three/examples/jsm/lines/Line2";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial";
import { LETTER_VALUES } from "./constants";

export type TileMesh = Mesh<PlaneGeometry, MeshBasicMaterial>;

export type TileState = "base" | "hover" | "selected";

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
}

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const GEM_CHANCE = 0.25;

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
  private selectionLine: Line2;
  private selectionLineMaterial: LineMaterial;
  private selectionLineGeometry: LineGeometry;

  constructor(cols = 5, rows = 5) {
    super();
    this.cols = cols;
    this.rows = rows;
    this.name = "WordBoard";

    this.selectionLineGeometry = new LineGeometry();
    this.selectionLineMaterial = new LineMaterial({
      color: 0x39b9ff,
      transparent: true,
      opacity: 0.9,
      linewidth: 5,
      depthTest: false
    });
    this.selectionLineMaterial.resolution.set(window.innerWidth, window.innerHeight);
    this.selectionLine = new Line2(this.selectionLineGeometry, this.selectionLineMaterial);
    this.selectionLine.visible = false;
    this.selectionLine.position.z = -0.05;
    this.add(this.selectionLine);

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
      hasGem: tile.hasGem
    }));

    for (let i = payload.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [payload[i], payload[j]] = [payload[j], payload[i]];
    }

    this.tiles.forEach((tile, index) => {
      const data = payload[index];
      tile.letter = data.letter;
      tile.hasGem = data.hasGem;
      this.applyStyle(tile, this.selected.has(tile) ? "selected" : "base");
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

  public setLineResolution(width: number, height: number) {
    this.selectionLineMaterial.resolution.set(width, height);
  }

  private areNeighbors(a: Tile, b: Tile): boolean {
    const dx = Math.abs(a.x - b.x);
    const dy = Math.abs(a.y - b.y);
    return dx <= 1 && dy <= 1 && !(dx === 0 && dy === 0);
  }

  private updateSelectionLine() {
    if (this.selectedOrder.length < 2) {
      this.selectionLine.visible = false;
      this.selectionLineGeometry.setPositions([]);
      return;
    }

    const segments: number[] = [];
    for (let i = 0; i < this.selectedOrder.length - 1; i += 1) {
      const start = this.selectedOrder[i].mesh.position;
      const end = this.selectedOrder[i + 1].mesh.position;
      segments.push(start.x, start.y, -0.05, end.x, end.y, -0.05);
    }

    this.selectionLineGeometry.setPositions(new Float32Array(segments));
    this.selectionLine.visible = true;
    this.selectionLine.computeLineDistances();
  }

  private buildTiles() {
    const offsetX = (this.cols - 1) * (this.tileSize / 2);
    const offsetY = (this.rows - 1) * (this.tileSize / 2);

    for (let y = 0; y < this.rows; y += 1) {
      for (let x = 0; x < this.cols; x += 1) {
        const letter = this.normalizeLetter(this.randomLetter());
        const hasGem = Math.random() < GEM_CHANCE;
        const material = new MeshBasicMaterial({
          color: "#ffffff",
          map: this.getLetterTexture(letter, "base", hasGem),
          transparent: true
        });
        const mesh: TileMesh = new Mesh(this.baseGeometry, material);
        mesh.position.set(x * this.tileSize - offsetX, y * this.tileSize - offsetY, 0);
        mesh.userData.tileCoordinates = { x, y };

        const tile: Tile = { mesh, letter, x, y, state: "base", hasGem };
        mesh.userData.tile = tile;
        this.tiles.push(tile);
        this.add(mesh);
      }
    }
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
      ctx.translate(size * 0.28, size * 0.72);
      ctx.fillStyle = "#f26cff";
      ctx.strokeStyle = "rgba(0,0,0,0.35)";
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.arc(0, 0, 28, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.moveTo(-6, -12);
      ctx.lineTo(12, 0);
      ctx.lineTo(-6, 12);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    const texture = new CanvasTexture(canvas);
    texture.needsUpdate = true;
    return texture;
  }
}
