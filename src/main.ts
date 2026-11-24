import './styles.css';
import { GameEngine } from './gameplay/GameEngine';
import { UIManager } from './ui/UIManager';

const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
const uiRoot = document.getElementById('ui-root') as HTMLElement;

let ui: UIManager | null = null;

const engine = new GameEngine(canvas, (state) => {
  ui?.render(state);
});

ui = new UIManager(uiRoot, engine);
// Trigger initial title screen render now that UIManager is constructed
engine.openScreen('title');

// Expose debug handle for inspection if desired
(window as unknown as { __canopy3d?: GameEngine }).__canopy3d = engine;
