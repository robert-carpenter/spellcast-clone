import {
  Color,
  OrthographicCamera,
  Raycaster,
  Scene,
  Vector2,
  WebGLRenderer
} from "three";
import { LETTER_VALUES } from "./constants";
import { WordBoard, Tile } from "./WordBoard";

interface Player {
  id: string;
  name: string;
  score: number;
  gems: number;
}

export class SpellcastGame {
  private frustumSize = 16;
  private container: HTMLElement;
  private boardArea: HTMLDivElement;
  private boardViewport: HTMLDivElement;
  private boardHeader: HTMLElement;
  private sidebar: HTMLDivElement;
  private scene = new Scene();
  private camera: OrthographicCamera;
  private renderer: WebGLRenderer;
  private board: WordBoard;
  private pointer = new Vector2();
  private raycaster = new Raycaster();
  private animationId = 0;
  private wordBox: HTMLElement;
  private playersListEl: HTMLElement;
  private submitButton: HTMLButtonElement;
  private resetButton: HTMLButtonElement;
  private shuffleButton: HTMLButtonElement;
  private rerollButton: HTMLButtonElement;
  private controlsWrap: HTMLElement;
  private powerPanel: HTMLDivElement;

  private players: Player[] = [
    { id: "p1", name: "Arcanist", score: 0, gems: 3 },
    { id: "p2", name: "Mystic", score: 0, gems: 3 },
    { id: "p3", name: "Invoker", score: 0, gems: 3 },
    { id: "p4", name: "Scribe", score: 0, gems: 3 }
  ];
  private currentPlayerIndex = 0;

  constructor(target: HTMLElement) {
    this.container = target;
    this.container.innerHTML = "";
    this.container.classList.add("game-shell");

    this.boardArea = document.createElement("div");
    this.boardArea.className = "board-area";
    this.boardViewport = document.createElement("div");
    this.boardViewport.className = "board-viewport";
    this.sidebar = document.createElement("div");
    this.sidebar.className = "sidebar";
    this.container.append(this.boardArea, this.sidebar);

    this.boardHeader = this.createBoardHeader();
    this.wordBox = this.createWordBox();
    this.boardArea.append(this.boardHeader, this.boardViewport);

    this.renderer = new WebGLRenderer({
      antialias: true
    });
    this.renderer.setClearColor(new Color("#0b0f1a"));
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.boardViewport.appendChild(this.renderer.domElement);

    const aspect = this.boardViewport.clientWidth / this.boardViewport.clientHeight;
    this.camera = new OrthographicCamera(
      (-this.frustumSize * aspect) / 2,
      (this.frustumSize * aspect) / 2,
      this.frustumSize / 2,
      -this.frustumSize / 2,
      0.1,
      50
    );
    this.camera.position.set(0, 0, 15);
    this.camera.lookAt(0, 0, 0);

    this.board = new WordBoard(5, 5);
    this.board.scale.setScalar(1.75); // upscale grid by 75%
    this.scene.add(this.board);
    this.updateBoardPlacement();

    const hud = this.createHud();
    this.controlsWrap = hud.controls;
    this.submitButton = hud.submitBtn;
    this.resetButton = hud.resetBtn;
    const powerUi = this.createPowerPanel();
    this.powerPanel = powerUi.panel;
    this.shuffleButton = powerUi.shuffleBtn;
    this.rerollButton = powerUi.rerollBtn;

    this.playersListEl = this.createSidebar();
    this.renderPlayers();

    this.onResize();

    window.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("click", this.onClick);
    window.addEventListener("resize", this.onResize);
    this.submitButton.addEventListener("click", this.onSubmitWord);
    this.resetButton.addEventListener("click", this.onResetWord);
    this.shuffleButton.addEventListener("click", this.onShuffle);
    this.rerollButton.addEventListener("click", this.onRerollLetter);

    this.tick = this.tick.bind(this);
    this.tick();
  }

  public dispose() {
    cancelAnimationFrame(this.animationId);
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("click", this.onClick);
    window.removeEventListener("resize", this.onResize);
    this.submitButton.removeEventListener("click", this.onSubmitWord);
    this.resetButton.removeEventListener("click", this.onResetWord);
    this.shuffleButton.removeEventListener("click", this.onShuffle);
    this.rerollButton.removeEventListener("click", this.onRerollLetter);
    this.renderer.dispose();
  }

  private createBoardHeader() {
    const header = document.createElement("div");
    header.className = "board-header";
    header.textContent = "Spellcast Clone";
    return header;
  }

  private createHud() {
    const hud = document.createElement("div");
    hud.className = "hud";

    const controls = document.createElement("div");
    controls.className = "hud__controls";

    const submitBtn = document.createElement("button");
    submitBtn.textContent = "Submit Word";
    submitBtn.className = "hud__btn primary";

    const resetBtn = document.createElement("button");
    resetBtn.textContent = "Reset Word";
    resetBtn.className = "hud__btn";

    controls.append(submitBtn, resetBtn);
    hud.append(controls);
    this.boardViewport.appendChild(hud);

    return { controls, submitBtn, resetBtn };
  }

  private createPowerPanel() {
    const panel = document.createElement("div");
    panel.className = "power-panel";

    const title = document.createElement("div");
    title.className = "power-panel__title";
    title.textContent = "Power Ups";

    const controls = document.createElement("div");
    controls.className = "power-panel__controls";

    const shuffleBtn = document.createElement("button");
    shuffleBtn.textContent = "Shuffle (1 gem)";
    shuffleBtn.className = "power-panel__btn";

    const rerollBtn = document.createElement("button");
    rerollBtn.textContent = "Swap Letter (3 gems)";
    rerollBtn.className = "power-panel__btn";

    controls.append(shuffleBtn, rerollBtn);
    panel.append(title, controls);
    this.boardViewport.appendChild(panel);

    return { panel, shuffleBtn, rerollBtn };
  }
  private createWordBox() {
    const box = document.createElement("div");
    box.className = "word-box";
    box.textContent = "—";
    this.boardViewport.appendChild(box);
    return box;
  }

  private createSidebar() {
    const wrap = document.createElement("div");
    wrap.className = "sidebar__content";

    const heading = document.createElement("div");
    heading.className = "sidebar__heading";
    heading.textContent = "Players";

    const list = document.createElement("div");
    list.className = "players";

    wrap.append(heading, list);
    this.sidebar.appendChild(wrap);
    return list;
  }

  private renderPlayers() {
    this.playersListEl.innerHTML = "";
    this.players.forEach((player, index) => {
      const item = document.createElement("div");
      item.className = "player";
      if (index === this.currentPlayerIndex) item.classList.add("player--active");

      const name = document.createElement("div");
      name.className = "player__name";
      name.textContent = player.name;

      const meta = document.createElement("div");
      meta.className = "player__meta";
      meta.innerHTML = `<span class="pill pill--score">${player.score} pts</span><span class="pill pill--gem">${player.gems} gems</span>`;

      item.append(name, meta);
      this.playersListEl.appendChild(item);
    });
  }

  private onPointerMove = (event: PointerEvent) => {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    const tile = this.intersectTile();
    this.board.setHovered(tile ?? undefined);
  };

  private onClick = () => {
    const tile = this.intersectTile();
    if (!tile) return;
    const result = this.board.selectTile(tile);
    if (!result.success) {
      console.warn(result.reason ?? "Invalid selection.");
      return;
    }

    this.updateWord(result.selection);
  };

  private onSubmitWord = () => {
    const selection = this.board.getSelection();
    if (!selection.length) {
      console.warn("Select tiles to form a word.");
      return;
    }

    const word = selection.map((t) => t.letter).join("");
    const points = this.calculateWordScore(selection);
    const gemsEarned = this.board.collectGemsFromSelection();
    const player = this.players[this.currentPlayerIndex];

    player.score += points;
    player.gems += gemsEarned;

    this.board.clearSelection();
    this.updateWord([]);
    this.advanceTurn();
  };

  private onShuffle = () => {
    const player = this.players[this.currentPlayerIndex];
    if (player.gems < 1) {
      console.warn("Need 1 gem to shuffle.");
      return;
    }
    player.gems -= 1;
    this.board.shuffleLetters();
    this.board.clearSelection();
    this.updateWord([]);
    this.renderPlayers();
  };

  private onResetWord = () => {
    this.board.clearSelection();
    this.updateWord([]);
  };

  private onRerollLetter = () => {
    const selection = this.board.getSelection();
    const player = this.players[this.currentPlayerIndex];
    if (player.gems < 1) {
      console.warn("Need 1 gem to change a letter.");
      return;
    }
    if (!selection.length) {
      console.warn("Select a tile to change its letter.");
      return;
    }

    player.gems -= 1;
    const tile = selection[selection.length - 1];
    this.board.rerollLetter(tile);
    this.updateWord(this.board.getSelection());
    this.renderPlayers();
  };

  private advanceTurn() {
    this.currentPlayerIndex = (this.currentPlayerIndex + 1) % this.players.length;
    this.renderPlayers();
  }

  private calculateWordScore(selection: Tile[]): number {
    return selection.reduce((total, tile) => {
      const base = LETTER_VALUES[tile.letter.toLowerCase()] ?? 0;
      const multiplier =
        tile.multiplier === "tripleLetter" ? 3 : tile.multiplier === "doubleLetter" ? 2 : 1;
      return total + base * multiplier;
    }, 0);
  }

  private updateWord(selection: Tile[]) {
    const word = selection.map((t) => t.letter).join("").toUpperCase();
    this.wordBox.textContent = word || "—";
  }

  private onResize = () => {
    const width = this.boardViewport.clientWidth;
    const height = this.boardViewport.clientHeight;
    if (!width || !height) return;
    const aspect = width / height;

    this.camera.left = (-this.frustumSize * aspect) / 2;
    this.camera.right = (this.frustumSize * aspect) / 2;
    this.camera.top = this.frustumSize / 2;
    this.camera.bottom = -this.frustumSize / 2;
    this.camera.updateProjectionMatrix();

    this.renderer.setSize(width, height);
    this.updateBoardPlacement();
    this.updateWordBoxLayout();
  };

  private intersectTile(): Tile | null {
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const intersects = this.raycaster.intersectObjects(this.board.children, false);
    if (!intersects.length) return null;
    const picked = intersects[0].object;
    const tile = picked.userData.tile as Tile | undefined;
    return tile ?? null;
  }

  private updateBoardPlacement() {
    const aspect =
      this.boardViewport.clientWidth && this.boardViewport.clientHeight
        ? this.boardViewport.clientWidth / this.boardViewport.clientHeight
        : 1;
    const leftBound = (-this.frustumSize * aspect) / 2;
    const boardWorldWidth = this.board.width() * this.board.scale.x;
    const margin = 1.1;
    const centerX = leftBound + margin + boardWorldWidth / 2;
    this.board.position.set(centerX, 0, 0);
    this.updateWordBoxLayout();
  }

  private updateWordBoxLayout() {
    const widthPx = this.boardViewport.clientWidth;
    const heightPx = this.boardViewport.clientHeight;
    if (!widthPx || !heightPx) return;

    const aspect = widthPx / heightPx;
    const boardWorldWidth = this.board.width() * this.board.scale.x;
    const boardWorldHeight = this.board.height() * this.board.scale.y;
    const leftBound = (-this.frustumSize * aspect) / 2;
    const topBound = this.frustumSize / 2;
    const pxPerWorldX = widthPx / (this.frustumSize * aspect);
    const pxPerWorldY = heightPx / this.frustumSize;

    const boardLeftWorld = this.board.position.x - boardWorldWidth / 2;
    const boardTopWorld = this.board.position.y + boardWorldHeight / 2;

    const boardWidthPx = boardWorldWidth * pxPerWorldX;
    const boardLeftPx = (boardLeftWorld - leftBound) * pxPerWorldX;
    const boardTopPx = (topBound - boardTopWorld) * pxPerWorldY;
    const boxHeight = this.wordBox.offsetHeight || 54;
    const marginPx = 8;
    const topPx = Math.max(boardTopPx - boxHeight - marginPx, 0);

    this.wordBox.style.width = `${boardWidthPx}px`;
    this.wordBox.style.left = `${boardLeftPx}px`;
    this.wordBox.style.top = `${(boxHeight / 2) - 10}px`;
    this.boardHeader.style.width = `${boardWidthPx}px`;
    this.boardHeader.style.marginLeft = `${boardLeftPx}px`;
    if (this.controlsWrap) {
      this.controlsWrap.style.width = `${boardWidthPx}px`;
      this.controlsWrap.style.marginLeft = `8px`;
    }
  }

  private tick() {
    this.animationId = requestAnimationFrame(this.tick);
    this.renderer.render(this.scene, this.camera);
  }
}
