import {
  Color,
  OrthographicCamera,
  Raycaster,
  Scene,
  Vector2,
  WebGLRenderer
} from "three";
import type { GameSnapshot } from "../../shared/gameTypes";
import { LETTER_VALUES } from "./../../shared/constants";
import { WordBoard, Tile } from "./WordBoard";
import { soundManager } from "../audio/SoundManager";

export interface Player {
  id: string;
  name: string;
  score: number;
  gems: number;
  isHost: boolean;
}

export interface InitialRoomState {
  roomId: string;
  playerId: string;
  players: Player[];
  game?: GameSnapshot;
}

export interface MultiplayerController {
  submitWord(tileIds: string[]): void | Promise<void>;
  shuffle(): void | Promise<void>;
  requestSwapMode(): void | Promise<void>;
  applySwap(tileId: string, letter: string): void | Promise<void>;
  cancelSwap(): void | Promise<void>;
  updateSelection(tileIds: string[]): void | Promise<void>;
}

export class SpellcastGame {
  private frustumSize = 16;
  private readonly totalRounds = 5;
  private container: HTMLElement;
  private boardArea: HTMLDivElement;
  private boardViewport: HTMLDivElement;
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
  private dictionary: Set<string>;
  private round = 1;
  private roundLabel!: HTMLElement;
  private isModalOpen = false;
  private swapMode = false;
  private gameLog: string[] = [];
  private lastLogLength = 0;
  private players: Player[];
  private roomId?: string;
  private playerId?: string;
  private isMultiplayer = false;
  private multiplayer: MultiplayerController | null = null;
  private currentPlayerIndex = 0;
  private serverCompletionHandled = false;
  private pendingSnapshot?: GameSnapshot;
  private lastSubmissionToken?: string;
  private lastActivePlayerId?: string;
  private wasMyTurn = false;
  private compactLayoutQuery = window.matchMedia("(max-width: 900px), (max-height: 520px)");

  constructor(
    target: HTMLElement,
    dictionary: Set<string>,
    roomState?: InitialRoomState,
    options?: { multiplayer?: MultiplayerController }
  ) {
    this.container = target;
    this.dictionary = dictionary;
    this.multiplayer = options?.multiplayer ?? null;
    this.isMultiplayer = Boolean(roomState ?? options?.multiplayer);
    if (roomState && roomState.players.length) {
      this.players = roomState.players.map((p) => ({
        id: p.id,
        name: p.name,
        score: p.score ?? 0,
        gems: p.gems ?? 3,
        isHost: p.isHost ?? false
      }));
      this.roomId = roomState.roomId;
      this.playerId = roomState.playerId;
    } else {
      this.players = [
        { id: "local-1", name: "Player 1", score: 0, gems: 3, isHost: true },
        { id: "local-2", name: "Player 2", score: 0, gems: 3, isHost: false }
      ];
    }
    this.lastActivePlayerId = this.players[this.currentPlayerIndex]?.id;
    this.container.innerHTML = "";
    this.container.classList.add("game-shell");

    this.boardArea = document.createElement("div");
    this.boardArea.className = "board-area";
    this.boardViewport = document.createElement("div");
    this.boardViewport.className = "board-viewport";
    this.sidebar = document.createElement("div");
    this.sidebar.className = "sidebar";
    this.container.append(this.boardArea, this.sidebar);

    this.wordBox = this.createWordBox();
    this.boardArea.append(this.boardViewport);

    this.renderer = new WebGLRenderer({
      antialias: true
    });
    this.renderer.setClearColor(0x000000, 0);
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
    if (roomState?.game) {
      this.pendingSnapshot = roomState.game;
    } else {
      this.board.setMultipliersEnabled(this.round > 1);
      this.board.setWordMultiplierEnabled(this.round > 1);
    }

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
    if (this.pendingSnapshot) {
      this.applyGameSnapshot(this.pendingSnapshot);
      this.pendingSnapshot = undefined;
    }

    this.onResize();

    window.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("pointerdown", this.onPointerDown);
    window.addEventListener("click", this.onClick);
    window.addEventListener("resize", this.onResize);
    this.submitButton.addEventListener("click", this.onSubmitWord);
    this.resetButton.addEventListener("click", this.onResetWord);
    this.shuffleButton.addEventListener("click", this.onShuffle);
    this.rerollButton.addEventListener("click", this.onRerollLetter);

    this.tick = this.tick.bind(this);
    this.updateTurnUi();
    this.tick();
  }

  public dispose() {
    cancelAnimationFrame(this.animationId);
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerdown", this.onPointerDown);
    window.removeEventListener("click", this.onClick);
    window.removeEventListener("resize", this.onResize);
    this.submitButton.removeEventListener("click", this.onSubmitWord);
    this.resetButton.removeEventListener("click", this.onResetWord);
    this.shuffleButton.removeEventListener("click", this.onShuffle);
    this.rerollButton.removeEventListener("click", this.onRerollLetter);
    this.renderer.dispose();
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
    heading.innerHTML = `Players <span class="round-indicator">Round ${this.round} of ${this.totalRounds}</span>`;
    this.roundLabel = heading.querySelector(".round-indicator")!;

    const logButton = document.createElement("button");
    logButton.className = "activity-log-btn";
    logButton.setAttribute("aria-label", "View activity log");
    const icon = document.createElement("i");
    icon.className = "fa-solid fa-book";
    logButton.appendChild(icon);
    logButton.addEventListener("click", () => this.showActivityLog());
    heading.appendChild(logButton);

    const list = document.createElement("div");
    list.className = "players";

    const controls = document.createElement("div");
    controls.className = "player-controls";

    const addBtn = document.createElement("button");
    addBtn.className = "player-controls__btn";
    addBtn.textContent = "+";
    addBtn.addEventListener("click", this.onAddPlayer);

    const removeBtn = document.createElement("button");
    removeBtn.className = "player-controls__btn";
    removeBtn.textContent = "−";
    removeBtn.addEventListener("click", this.onRemovePlayer);

    controls.append(removeBtn, addBtn);
    if (this.isMultiplayer) {
      controls.style.display = "none";
      wrap.append(heading, list);
    } else {
      wrap.append(heading, list, controls);
    }
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

  private onAddPlayer = () => {
    if (this.isMultiplayer) return;
    if (this.players.length >= 6) return;
    const id = `p${this.players.length + 1}`;
    this.players.push({
      id,
      name: `Player ${this.players.length + 1}`,
      score: 0,
      gems: 3,
      isHost: false
    });
    this.renderPlayers();
  };

  private onRemovePlayer = () => {
    if (this.isMultiplayer) return;
    if (this.players.length <= 2) return;
    this.players.pop();
    if (this.currentPlayerIndex >= this.players.length) {
      this.currentPlayerIndex = 0;
    }
    this.renderPlayers();
  };

  private updatePointerFromEvent(event: PointerEvent) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  }

  private onPointerMove = (event: PointerEvent) => {
    if (this.isModalOpen) return;
    if (this.isMultiplayer && !this.isMyTurn()) {
      this.board.setHovered(undefined);
      return;
    }
    this.updatePointerFromEvent(event);

    const tile = this.intersectTile();
    this.board.setHovered(tile ?? undefined);
  };

  private onPointerDown = (event: PointerEvent) => {
    this.updatePointerFromEvent(event);
  };

  private onClick = () => {
    if (this.isModalOpen) return;
    if (this.isMultiplayer && !this.isMyTurn()) return;
    const tile = this.intersectTile();
    if (!tile) return;

    if (this.swapMode) {
      this.handleSwapSelection(tile);
      return;
    }

    const result = this.board.selectTile(tile);
    if (!result.success) {
      console.warn(result.reason ?? "Invalid selection.");
      return;
    }

    this.updateWord(result.selection);
    this.broadcastSelection(result.selection);
    if (result.action === "added") {
      soundManager.play("tile-select");
    } else if (result.action === "removed") {
      soundManager.play("tile-deselect");
    }
  };

  private onSubmitWord = () => {
    const selection = this.board.getSelection();
    if (!selection.length) {
      console.warn("Select tiles to form a word.");
      return;
    }
    if (this.isMultiplayer && !this.isMyTurn()) {
      console.warn("Wait for your turn before submitting.");
      return;
    }

    const word = selection.map((t) => t.letter).join("");
    const normalizedWord = word.toUpperCase();
    if (!this.dictionary.has(normalizedWord)) {
      console.warn(`"${word}" is not a valid word.`);
      this.setWordBoxValidity(false);
      return;
    }

    if (this.isMultiplayer && this.multiplayer) {
      const player = this.players[this.currentPlayerIndex];
      const tileIds = selection.map((tile) => this.board.getTileId(tile));
      const submissionKey = `${this.round}:${player?.id ?? "unknown"}:${normalizedWord}`;
      this.lastSubmissionToken = submissionKey;
      soundManager.play("word-submit");
      this.multiplayer.submitWord(tileIds);
      this.board.clearSelection();
      this.updateWord([]);
      this.broadcastSelection([]);
      return;
    }

    const points = this.calculateWordScore(selection, word.length >= 6);
    const gemsEarned = this.board.collectGemsFromSelection();
    const player = this.players[this.currentPlayerIndex];

    player.score += points;
    player.gems += gemsEarned;
    const submissionKey = `${this.round}:${player.id}:${normalizedWord}`;
    this.lastSubmissionToken = submissionKey;
    soundManager.play("word-submit");
    this.logEvent(
      `Round ${this.round}: ${player.name} scored ${points} pts${gemsEarned ? ` and earned ${gemsEarned} gem(s)` : ""} with "${word.toUpperCase()}".`
    );
    this.board.refreshTiles(selection);
    this.board.clearSelection();
    this.updateWord([]);
    this.broadcastSelection([]);
    this.advanceTurn();
  };

  private onShuffle = async () => {
    if (this.isMultiplayer && !this.isMyTurn()) {
      console.warn("Wait for your turn to use Shuffle.");
      return;
    }
    if (this.swapMode) {
      if (this.isMultiplayer && this.multiplayer) {
        this.multiplayer.cancelSwap();
      } else {
        this.exitSwapMode();
      }
    }
    const player = this.players[this.currentPlayerIndex];
    if (player.gems < 1) {
      console.warn("Need 1 gem to shuffle.");
      return;
    }
    const confirmed = await this.showConfirmation("Shuffle the board for 1 gem?");
    if (!confirmed) return;

    if (this.isMultiplayer && this.multiplayer) {
      this.multiplayer.shuffle();
      this.board.clearSelection();
      this.updateWord([]);
      this.broadcastSelection([]);
      return;
    }

    player.gems -= 1;
    this.board.shuffleLetters();
    this.board.clearSelection();
    this.updateWord([]);
    this.broadcastSelection([]);
    this.renderPlayers();
    this.logEvent(`Round ${this.round}: ${player.name} used Shuffle (-1 gem).`);
  };

  private onResetWord = () => {
    this.board.clearSelection();
    this.updateWord([]);
    this.broadcastSelection([]);
  };

  private onRerollLetter = () => {
    if (this.swapMode) {
      if (this.isMultiplayer && this.multiplayer) {
        this.multiplayer.cancelSwap();
      } else {
        this.exitSwapMode();
      }
      return;
    }
    if (this.isMultiplayer && !this.isMyTurn()) {
      console.warn("Wait for your turn to use Swap.");
      return;
    }
    if (this.isMultiplayer && this.multiplayer) {
      this.multiplayer.requestSwapMode();
      this.board.clearSelection();
      this.board.setHovered(undefined);
      this.updateWord([]);
      this.broadcastSelection([]);
      return;
    }
    const player = this.players[this.currentPlayerIndex];
    if (player.gems < 3) {
      console.warn("Need 3 gems to swap a letter.");
      return;
    }
    this.swapMode = true;
    this.board.setSwapMode(true);
    this.board.clearSelection();
    this.board.setHovered(undefined);
    this.updateWord([]);
  };

  private exitSwapMode() {
    if (!this.swapMode) return;
    this.swapMode = false;
    this.board.setSwapMode(false);
    this.board.setHovered(undefined);
  }

  private advanceTurn() {
    const previousId = this.players[this.currentPlayerIndex]?.id;
    this.currentPlayerIndex = (this.currentPlayerIndex + 1) % this.players.length;
    if (this.currentPlayerIndex === 0) {
      if (this.round < this.totalRounds) {
        this.round += 1;
        this.updateRoundLabel();
        this.board.setMultipliersEnabled(this.round > 1);
        this.board.setWordMultiplierEnabled(this.round > 1);
        this.board.refreshTiles(this.board.allTiles(), true);
        this.board.clearSelection();
        this.updateWord([]);
        this.broadcastSelection([]);
      } else {
        this.endGame();
      }
    }
    this.onTurnChanged(this.players[this.currentPlayerIndex]?.id, previousId);
    this.renderPlayers();
  }

  private calculateWordScore(selection: Tile[], hasLongWordBonus: boolean): number {
    const baseScore = selection.reduce((total, tile) => {
      const base = LETTER_VALUES[tile.letter.toLowerCase()] ?? 0;
      const letterMultiplier =
        tile.multiplier === "tripleLetter" ? 3 : tile.multiplier === "doubleLetter" ? 2 : 1;
      return total + base * letterMultiplier;
    }, 0);
    const hasDoubleWord = selection.some((tile) => tile.wordMultiplier === "doubleWord");
    const total = hasDoubleWord ? baseScore * 2 : baseScore;
    return total + (hasLongWordBonus ? 10 : 0);
  }

  private updateWord(selection: Tile[]) {
    const word = selection.map((t) => t.letter).join("").toUpperCase();
    this.wordBox.textContent = word || "—";
    if (!word) {
      this.setWordBoxValidity(null);
      return;
    }
    const isValid = this.dictionary.has(word);
    this.setWordBoxValidity(isValid);
  }

  private setWordBoxValidity(state: boolean | null) {
    this.wordBox.classList.remove("word-box--valid", "word-box--invalid");
    if (state === true) {
      this.wordBox.classList.add("word-box--valid");
    } else if (state === false) {
      this.wordBox.classList.add("word-box--invalid");
    }
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

  private isCompactLayout(): boolean {
    return this.compactLayoutQuery.matches;
  }

  private updateWordBoxLayout() {
    if (this.isCompactLayout()) {
      this.wordBox.style.width = "";
      this.wordBox.style.left = "";
      this.wordBox.style.top = "";
      if (this.controlsWrap) {
        this.controlsWrap.style.width = "";
        this.controlsWrap.style.marginLeft = "";
      }
      return;
    }

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
    const marginPx = 15;
    const topPx = 0;

    this.wordBox.style.width = `${boardWidthPx}px`;
    this.wordBox.style.left = `${boardLeftPx}px`;
    this.wordBox.style.top = `${topPx}px`;
    if (this.controlsWrap) {
      this.controlsWrap.style.width = `${boardWidthPx}px`;
      this.controlsWrap.style.marginLeft = `8px`;
    }
  }

  private tick() {
    this.animationId = requestAnimationFrame(this.tick);
    this.renderer.render(this.scene, this.camera);
  }

  private updateRoundLabel() {
    if (this.roundLabel) {
      this.roundLabel.textContent = `Round ${this.round} of ${this.totalRounds}`;
    }
  }

  private showConfirmation(message: string): Promise<boolean> {
    return new Promise((resolve) => {
      this.isModalOpen = true;
      const overlay = document.createElement("div");
      overlay.className = "modal-overlay";
      const modal = document.createElement("div");
      modal.className = "modal";

      const text = document.createElement("p");
      text.textContent = message;

      const actions = document.createElement("div");
      actions.className = "modal__actions";

      const confirmBtn = document.createElement("button");
      confirmBtn.textContent = "Confirm";
      confirmBtn.className = "modal__btn primary";

      const cancelBtn = document.createElement("button");
      cancelBtn.textContent = "Cancel";
      cancelBtn.className = "modal__btn";

      const cleanup = (result: boolean) => {
        this.isModalOpen = false;
        overlay.remove();
        resolve(result);
      };

      confirmBtn.addEventListener("click", () => cleanup(true));
      cancelBtn.addEventListener("click", () => cleanup(false));

      actions.append(confirmBtn, cancelBtn);
      modal.append(text, actions);
      overlay.appendChild(modal);
      document.body.appendChild(overlay);
    });
  }

  private endGame() {
    const sorted = [...this.players].sort((a, b) => b.score - a.score);
    const winner = sorted[0];
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    const modal = document.createElement("div");
    modal.className = "modal";

    const message = document.createElement("p");
    message.innerHTML = `<strong>${winner.name}</strong> won with <strong>${winner.score} points</strong>`;

    const countdown = document.createElement("p");
    countdown.textContent = "A new game will begin in 5 seconds.";

    modal.append(message, countdown);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    let remaining = 5;
    const interval = window.setInterval(() => {
      remaining -= 1;
      countdown.textContent = `A new game will begin in ${remaining} second${remaining === 1 ? "" : "s"}.`;
      if (remaining <= 0) {
        window.clearInterval(interval);
        overlay.remove();
        this.resetGame();
      }
    }, 1000);
  }

  private handleSwapSelection = async (tile: Tile) => {
    const player = this.players[this.currentPlayerIndex];
    if (this.isMultiplayer) {
      if (!this.multiplayer) return;
      const letter = await this.showLetterPicker();
      if (!letter) {
        this.broadcastSelection([]);
        return;
      }
      const tileId = this.board.getTileId(tile);
      this.multiplayer.applySwap(tileId, letter);
      this.board.clearSelection();
      this.board.setHovered(undefined);
      this.updateWord([]);
      this.broadcastSelection([]);
      return;
    }
    if (player.gems < 3) {
      console.warn("Need 3 gems to swap a letter.");
      this.exitSwapMode();
      return;
    }

    const letter = await this.showLetterPicker();
    if (!letter) {
      this.exitSwapMode();
      return;
    }

    player.gems -= 3;
    this.board.swapTileLetter(tile, letter);
    this.board.clearSelection();
    this.board.setHovered(undefined);
    this.updateWord([]);
    this.exitSwapMode();
    this.renderPlayers();
    this.logEvent(`Round ${this.round}: ${player.name} swapped a letter to "${letter}".`);

    this.board.clearSelection();
    this.updateWord([]);
  };

  private showLetterPicker(): Promise<string | null> {
    return new Promise((resolve) => {
      this.isModalOpen = true;
      const overlay = document.createElement("div");
      overlay.className = "modal-overlay";
      const modal = document.createElement("div");
      modal.className = "modal";

      const text = document.createElement("p");
      text.textContent = "Select a new letter";

      const grid = document.createElement("div");
      grid.className = "letter-picker";
      for (let code = 65; code <= 90; code += 1) {
        const letter = String.fromCharCode(code);
        const btn = document.createElement("button");
        btn.className = "letter-picker__btn";
        btn.textContent = letter;
        btn.addEventListener("click", () => cleanup(letter));
        grid.appendChild(btn);
      }

      const actions = document.createElement("div");
      actions.className = "modal__actions";

      const cancelBtn = document.createElement("button");
      cancelBtn.className = "modal__btn";
      cancelBtn.textContent = "Cancel";
      cancelBtn.addEventListener("click", () => cleanup(null));

      actions.append(cancelBtn);
      modal.append(text, grid, actions);
      overlay.appendChild(modal);
      document.body.appendChild(overlay);

      const cleanup = (value: string | null) => {
        this.isModalOpen = false;
        overlay.remove();
        resolve(value);
      };
    });
  }

  private resetGame() {
    this.round = 1;
    this.currentPlayerIndex = 0;
    this.lastSubmissionToken = undefined;
    this.players.forEach((player, index) => {
      player.score = 0;
      player.gems = 3;
      if (!this.isMultiplayer) {
        player.name = `Player ${index + 1}`;
      }
    });
    this.lastActivePlayerId = this.players[0]?.id;
    this.board.setMultipliersEnabled(false);
    this.board.setWordMultiplierEnabled(false);
    this.board.refreshTiles(this.board.allTiles(), true);
    this.board.clearSelection();
    this.updateWord([]);
    this.updateRoundLabel();
    this.renderPlayers();
    this.gameLog = [];
  }

  private showActivityLog() {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    const modal = document.createElement("div");
    modal.className = "modal";
    modal.style.maxHeight = "70vh";
    modal.style.overflowY = "auto";

    const title = document.createElement("h3");
    title.textContent = "Game Activity Log";

    const list = document.createElement("ul");
    list.className = "activity-log";
    if (this.gameLog.length === 0) {
      const empty = document.createElement("p");
      empty.textContent = "No activity yet.";
      modal.append(title, empty);
    } else {
      this.gameLog.slice().forEach((entry) => {
        const item = document.createElement("li");
        item.textContent = entry;
        list.appendChild(item);
      });
      modal.append(title, list);
    }

    const actions = document.createElement("div");
    actions.className = "modal__actions";
    const closeBtn = document.createElement("button");
    closeBtn.className = "modal__btn primary";
    closeBtn.textContent = "Close";
    closeBtn.addEventListener("click", () => overlay.remove());
    actions.append(closeBtn);

    modal.append(actions);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
  }

  public syncRoomPlayers(
    snapshot: Array<{ id: string; name: string; isHost: boolean; score?: number; gems?: number }>
  ) {
    if (!this.roomId) return;
    const lookup = new Map(this.players.map((player) => [player.id, player]));
    const next: Player[] = [];
    snapshot.forEach((incoming) => {
      const existing = lookup.get(incoming.id);
      if (existing) {
        existing.name = incoming.name;
        existing.isHost = incoming.isHost;
        if (typeof incoming.score === "number") existing.score = incoming.score;
        if (typeof incoming.gems === "number") existing.gems = incoming.gems;
        next.push(existing);
      } else {
        next.push({
          id: incoming.id,
          name: incoming.name,
          score: 0,
          gems: 3,
          isHost: incoming.isHost
        });
      }
    });
    this.players = next;
    if (this.players.length === 0) {
      this.currentPlayerIndex = 0;
    } else if (this.currentPlayerIndex >= this.players.length) {
      this.currentPlayerIndex = this.currentPlayerIndex % this.players.length;
    }
    this.renderPlayers();
    this.updateTurnUi();
  }

  private logEvent(entry: string) {
    this.gameLog.push(entry);
    if (this.gameLog.length > 50) {
      this.gameLog.shift();
    }
  }

  private broadcastSelection(selection: Tile[]) {
    if (!this.isMultiplayer || !this.multiplayer) return;
    const ids = selection.map((tile) => this.board.getTileId(tile));
    this.multiplayer.updateSelection(ids);
  }

  private onTurnChanged(newPlayerId?: string, previousPlayerId?: string) {
    if (!newPlayerId || newPlayerId === previousPlayerId) return;
    this.lastActivePlayerId = newPlayerId;
    soundManager.play("turn-change");
  }

  private updateTurnUi() {
    if (!this.isMultiplayer) return;
    const isMyTurn = this.isMyTurn();
    if (this.wasMyTurn !== isMyTurn && isMyTurn) {
      this.board.clearSelection();
      this.board.setHovered(undefined);
      this.updateWord([]);
      this.broadcastSelection([]);
    }
    this.wasMyTurn = isMyTurn;
    this.submitButton.disabled = !isMyTurn;
    this.shuffleButton.disabled = !isMyTurn;
    this.rerollButton.disabled = !isMyTurn;
    if (this.controlsWrap) {
      this.controlsWrap.style.display = isMyTurn ? "flex" : "none";
    }
    if (this.powerPanel) {
      this.powerPanel.style.display = isMyTurn ? "flex" : "none";
    }
  }

  private isMyTurn(): boolean {
    if (!this.isMultiplayer || !this.playerId) return false;
    const current = this.players[this.currentPlayerIndex];
    return current?.id === this.playerId;
  }

  private showServerWinner(winnerId?: string) {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    const modal = document.createElement("div");
    modal.className = "modal";
    const winner =
      winnerId && this.players.find((player) => player.id === winnerId)?.name
        ? this.players.find((player) => player.id === winnerId)!.name
        : "Game";
    const message = document.createElement("p");
    message.innerHTML = `<strong>${winner}</strong> won the match.`;
    const detail = document.createElement("p");
    detail.textContent = "Waiting for the host to start a new game...";
    const actions = document.createElement("div");
    actions.className = "modal__actions";
    const closeBtn = document.createElement("button");
    closeBtn.className = "modal__btn primary";
    closeBtn.textContent = "Close";
    closeBtn.addEventListener("click", () => overlay.remove());
    actions.append(closeBtn);
    modal.append(message, detail, actions);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
  }

  public applyRemoteSelection(playerId: string, tileIds: string[]) {
    if (!this.isMultiplayer) return;
    if (playerId === this.playerId) return;
    if (this.isMyTurn()) return;
    this.board.setSelectionFromIds(tileIds);
    const selection = this.board.getSelection();
    this.updateWord(selection);
  }

  public applyGameSnapshot(snapshot: GameSnapshot) {
    this.board.applyExternalState(snapshot.tiles);
    const previousId = this.players[this.currentPlayerIndex]?.id;
    this.round = snapshot.round;
    this.currentPlayerIndex = snapshot.currentPlayerIndex;
    this.onTurnChanged(this.players[this.currentPlayerIndex]?.id, previousId);
    this.board.setMultipliersEnabled(snapshot.multipliersEnabled);
    this.board.setWordMultiplierEnabled(snapshot.wordMultiplierEnabled);
    this.updateRoundLabel();
    this.board.setSwapMode(snapshot.swapModePlayerId === this.playerId);
    this.swapMode = snapshot.swapModePlayerId === this.playerId;
    if (snapshot.log && snapshot.log.length !== this.lastLogLength) {
      this.gameLog = [...snapshot.log];
      this.lastLogLength = snapshot.log.length;
    }
    if (snapshot.lastSubmission) {
      const token = `${snapshot.round}:${snapshot.lastSubmission.playerId}:${snapshot.lastSubmission.word}`;
      if (token !== this.lastSubmissionToken) {
        this.lastSubmissionToken = token;
        soundManager.play("word-submit");
      }
    }
    this.renderPlayers();
    this.updateTurnUi();
    if (snapshot.completed && !this.serverCompletionHandled) {
      this.serverCompletionHandled = true;
      this.showServerWinner(snapshot.winnerId);
    } else if (!snapshot.completed) {
      this.serverCompletionHandled = false;
    }
  }
}
