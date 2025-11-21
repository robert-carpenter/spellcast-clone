import "./style.css";
import { SpellcastGame } from "./game/SpellcastGame";

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("App container not found");
}

const game = new SpellcastGame(app);

// Hot module replace support when running dev server
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    game.dispose();
  });
}
