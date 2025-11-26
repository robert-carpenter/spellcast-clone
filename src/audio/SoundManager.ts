import playerJoinUrl from "./sounds/player-join.m4a";
import gameStartUrl from "./sounds/game-start.m4a";
import tileSelectUrl from "./sounds/tile-select.m4a";
import tileDeselectUrl from "./sounds/tile-deselect.m4a";
import wordSubmitUrl from "./sounds/word-submit.m4a";
import turnChangeUrl from "./sounds/turn-change.m4a";

type SoundEffect =
  | "player-join"
  | "game-start"
  | "tile-select"
  | "tile-deselect"
  | "word-submit"
  | "turn-change";

interface SoundConfig {
  url: string;
  volume?: number;
}

const SOUND_TABLE: Record<SoundEffect, SoundConfig> = {
  "player-join": { url: playerJoinUrl, volume: 0.9 },
  "game-start": { url: gameStartUrl, volume: 0.9 },
  "tile-select": { url: tileSelectUrl, volume: 0.7 },
  "tile-deselect": { url: tileDeselectUrl, volume: 0.7 },
  "word-submit": { url: wordSubmitUrl, volume: 0.85 },
  "turn-change": { url: turnChangeUrl, volume: 0.8 }
};

class SoundManager {
  private enabled = true;
  private unlocked = false;
  enable() {
    this.enabled = true;
  }

  disable() {
    this.enabled = false;
  }

  enableAutoUnlock() {
    if (this.unlocked) return;
    if (typeof window === "undefined") return;
    const unlock = () => {
      this.unlocked = true;
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
  }

  play(effect: SoundEffect) {
    if (!this.enabled) return;
    const config = SOUND_TABLE[effect];
    if (!config) return;
    if (!this.unlocked) {
      // Auto-unlock hasn't fired yet; ignore until we have a user gesture.
      return;
    }
    const audio = new Audio(config.url);
    audio.volume = config.volume ?? 1;
    audio.play().catch(() => {
      // browsers may block if not unlocked yet
    });
  }
}

export const soundManager = new SoundManager();
export type { SoundEffect };
