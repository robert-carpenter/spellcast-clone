import "./style.css";
import { SpellcastGame } from "./game/SpellcastGame";
import dictionaryRaw from "./game/dictionary.txt?raw";

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

const game = new SpellcastGame(app, dictionary);

// Hot module replace support when running dev server
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    game.dispose();
  });
}
