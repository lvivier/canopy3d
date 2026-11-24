import { CAMPAIGN_CONTRACTS, createSandboxContract } from '../data/contracts';
import { SPECIES_LIST } from '../data/species';
import { GameEngine } from '../gameplay/GameEngine';
import { GameHUDState, SiteId, SpeciesId, ToolId, WeatherId } from '../types';
import { isTouchUi } from './inputHints';

const TOOL_META: Record<ToolId, { name: string; key: string; icon: string; desc: string }> = {
  prune: {
    name: 'Prune Saw',
    key: '1',
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 20l5-5m0 0l9-9a2 2 0 113 3l-9 9m-3-3l3 3M12 9l1 1m2-4l1 1"/></svg>`,
    desc: 'Trim limbs & rebalance lean',
  },
  fell: {
    name: 'Chainsaw',
    key: '2',
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="10" width="8" height="7" rx="2"/><path d="M11 12h8.5a2 2 0 010 4H11"/><path d="M5 10V7h4v3"/></svg>`,
    desc: 'Aim, Face Notch & Back Cut',
  },
  wedge: {
    name: 'Wedge',
    key: '3',
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="4,17 20,17 20,9"/><path d="M12 5v4m-2-2h4"/></svg>`,
    desc: 'Lift back-leaning trunks',
  },
  buck: {
    name: 'Limb & Buck',
    key: '4',
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="8" cy="12" r="5"/><path d="M13 12h8M16 9l2 6M20 9l-1 6"/></svg>`,
    desc: 'Limb fallen logs & slice sawlogs',
  },
};

const SITE_NAMES: Record<SiteId, string> = {
  coastal_homestead: 'Coastal Homestead',
  misty_creek: 'Misty Valley Creek',
  timber_ridge: 'Old-Growth Timber Ridge',
  storm_bluff: 'Storm-Damaged Bluff',
  coastal_town: 'Coastal Town Yards',
  pacific_headland: 'Pacific Headland',
  kootenay_rockies: 'East Kootenay Rockies',
};

const WEATHER_NAMES: Record<WeatherId, string> = {
  sunny_morning: 'Crisp Morning',
  misty_fog: 'Coastal Mist',
  golden_hour: 'Golden Hour',
  coastal_gale: 'Pacific Gusts',
};

export class UIManager {
  private root: HTMLElement;
  private engine: GameEngine;
  private cursorRingEl: HTMLDivElement;
  private cursorRingFill: SVGCircleElement;
  private cursorRingLabel: HTMLDivElement;

  private lastScreen: GameHUDState['screen'] | null = null;
  private lastState: GameHUDState | null = null;

  // Sandbox selector choices
  private sbSpecies: SpeciesId = 'douglas_fir';
  private sbSite: SiteId = 'timber_ridge';
  private sbWeather: WeatherId = 'golden_hour';
  private sbWind = 0.25;

  // Cached playing DOM refs so HUD updates smoothly without rebuilding DOM nodes or breaking clicks
  private playingContainer: HTMLDivElement | null = null;
  private objectivesExpanded = false;
  private hudMenuOpen = false;

  constructor(root: HTMLElement, engine: GameEngine) {
    this.root = root;
    this.engine = engine;

    // Create dedicated high-DPI cursor progress ring overlay
    this.cursorRingEl = document.createElement('div');
    this.cursorRingEl.className = 'cursor-ring';
    this.cursorRingEl.innerHTML = `
      <svg viewBox="0 0 48 48" class="cursor-ring-svg">
        <circle cx="24" cy="24" r="20" class="cursor-ring-bg"/>
        <circle cx="24" cy="24" r="20" class="cursor-ring-fill" stroke-dasharray="125.66" stroke-dashoffset="125.66"/>
      </svg>
      <div class="cursor-ring-label"></div>
    `;
    this.cursorRingFill = this.cursorRingEl.querySelector('.cursor-ring-fill') as SVGCircleElement;
    this.cursorRingLabel = this.cursorRingEl.querySelector('.cursor-ring-label') as HTMLDivElement;
    document.body.appendChild(this.cursorRingEl);

    this.engine.setCursorProgressCallback((visible, x, y, progress, label, tone) => {
      if (!visible) {
        this.cursorRingEl.classList.remove('visible');
        return;
      }
      this.cursorRingEl.classList.add('visible');
      this.cursorRingEl.style.transform = `translate(${x}px, ${y}px)`;
      const circ = 125.66;
      this.cursorRingFill.style.strokeDashoffset = `${circ * (1 - Math.max(0, Math.min(1, progress)))}`;
      this.cursorRingEl.dataset.tone = tone;
      this.cursorRingLabel.textContent = label;
    });
  }

  public render(state: GameHUDState): void {
    this.lastState = state;
    if (state.screen !== this.lastScreen) {
      this.lastScreen = state.screen;
      this.playingContainer = null;
      this.root.innerHTML = '';

      if (state.screen === 'title') this.renderTitleScreen(state);
      else if (state.screen === 'contracts') this.renderContractsScreen(state);
      else if (state.screen === 'sandbox') this.renderSandboxScreen();
      else if (state.screen === 'playing') this.mountPlayingHUD(state);
      else if (state.screen === 'debrief') this.renderDebriefScreen(state);
      return;
    }

    if (state.screen === 'playing') {
      this.updatePlayingHUD(state);
    }
  }

  private renderTitleScreen(state: GameHUDState): void {
    const completedCount = Object.keys(state.completedContracts).length;
    const nextContract =
      CAMPAIGN_CONTRACTS.find((c) => !state.completedContracts[c.id]) ?? CAMPAIGN_CONTRACTS[0];

    const wrap = document.createElement('div');
    wrap.className = 'overlay-screen title-screen';
    wrap.innerHTML = `
      <div class="title-card">
        <div class="eyebrow">PACIFIC NORTHWEST ARBORIST &amp; LOGGING SIM</div>
        <h1 class="game-title">Canopy <span>3D</span></h1>
        <p class="game-subtitle">
          Work as a Pacific Northwest arborist—prune damaged limbs, tame heavy crowns, and remove trees with careful felling cuts.
        </p>

        <div class="title-actions">
          <button class="btn btn-primary btn-lg" id="btn-play-campaign">
            ${completedCount > 0 ? `Continue Job #${nextContract.index}` : 'Start Career Campaign'}
          </button>
          <button class="btn btn-secondary" id="btn-open-contracts">
            Jobs (${completedCount}/${CAMPAIGN_CONTRACTS.length})
          </button>
          <button class="btn btn-secondary" id="btn-open-sandbox">
            Free Cut
          </button>
        </div>

        <div class="species-strip">
          ${SPECIES_LIST.map(
            (s) => `
            <div class="species-pill" title="${s.description}">
              <span class="species-dot" style="background:${s.foliageColors[0]}; border-color:${s.heartwoodColor}"></span>
              <span>${s.name}</span>
            </div>`
          ).join('')}
        </div>

        <div class="controls-legend">
          <span class="legend-row">
            <span class="hint-pointer"><b>Left-Click</b> Aim, Prune, Saw &amp; Wedge</span>
            <span class="hint-touch"><b>Tap</b> Aim, Prune, Saw &amp; Wedge</span>
          </span>
          <span class="legend-row">
            <span class="hint-pointer"><b>Right-Click Drag</b> Orbit Camera</span>
            <span class="hint-touch"><b>Two-finger drag</b> Orbit Camera</span>
          </span>
          <span class="legend-row">
            <span class="hint-pointer"><b>Scroll / Pinch</b> Zoom</span>
            <span class="hint-touch"><b>Pinch</b> Zoom</span>
          </span>
        </div>
      </div>
    `;
    this.root.appendChild(wrap);

    wrap.querySelector('#btn-play-campaign')?.addEventListener('click', () => {
      this.engine.startContract(nextContract);
    });
    wrap.querySelector('#btn-open-contracts')?.addEventListener('click', () => {
      this.engine.openScreen('contracts');
    });
    wrap.querySelector('#btn-open-sandbox')?.addEventListener('click', () => {
      this.engine.openScreen('sandbox');
    });
  }

  private renderContractsScreen(state: GameHUDState): void {
    const wrap = document.createElement('div');
    wrap.className = 'overlay-screen contracts-screen';
    wrap.innerHTML = `
      <div class="panel-shell">
        <div class="panel-header">
          <div>
            <div class="eyebrow">CASCADIA ARBORIST DISPATCH</div>
            <h2>Coastal Work Orders</h2>
          </div>
          <div class="panel-header-right">
            <div class="earnings-badge">$${state.totalEarnings.toLocaleString()} Earned</div>
            <button class="btn btn-ghost" id="btn-back-title">← Back</button>
          </div>
        </div>

        <div class="contracts-grid">
          ${CAMPAIGN_CONTRACTS.map((c) => {
            const done = state.completedContracts[c.id];
            const speciesNames = [...new Set(c.trees.map((t) => SPECIES_LIST.find((s) => s.id === t.species)?.name))].join(', ');
            const stars = done ? '★'.repeat(done.stars) + '☆'.repeat(3 - done.stars) : '';
            const diffStr = '▲'.repeat(c.difficulty);
            return `
              <div class="contract-card ${done ? 'completed' : ''}" data-contract-id="${c.id}">
                <div class="contract-top">
                  <span class="contract-num">Job #${c.index}</span>
                  <span class="contract-diff" title="Difficulty ${c.difficulty}/5">${diffStr}</span>
                </div>
                <h3>${c.title}</h3>
                <div class="contract-meta">${SITE_NAMES[c.site]} · ${WEATHER_NAMES[c.weather]}</div>
                <p class="contract-brief">${c.briefing}</p>
                <div class="contract-tags">
                  <span class="tag">${speciesNames}</span>
                  <span class="tag tag-pay">$${c.basePayout} Base</span>
                </div>
                <div class="contract-footer">
                  <span class="contract-stars">${done ? stars : 'Ready to dispatch'}</span>
                  <span class="contract-go">Launch →</span>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
    this.root.appendChild(wrap);

    wrap.querySelector('#btn-back-title')?.addEventListener('click', () => {
      this.engine.openScreen('title');
    });
    wrap.querySelectorAll('.contract-card').forEach((card) => {
      card.addEventListener('click', () => {
        const id = (card as HTMLElement).dataset.contractId;
        const found = CAMPAIGN_CONTRACTS.find((c) => c.id === id);
        if (found) this.engine.startContract(found);
      });
    });
  }

  private renderSandboxScreen(): void {
    const wrap = document.createElement('div');
    wrap.className = 'overlay-screen sandbox-screen';
    wrap.innerHTML = `
      <div class="panel-shell sandbox-shell">
        <div class="panel-header">
          <div>
            <div class="eyebrow">FREE-CUT PRACTICE</div>
            <h2>Coastal Sandbox Setup</h2>
          </div>
          <button class="btn btn-ghost" id="btn-sb-back">← Back</button>
        </div>

        <div class="sandbox-section">
          <label>Select PNW Tree Species</label>
          <div class="choice-grid species-choices">
            ${SPECIES_LIST.map(
              (s) => `
              <button class="choice-btn ${this.sbSpecies === s.id ? 'active' : ''}" data-species="${s.id}">
                <strong>${s.name}</strong>
                <span>${s.latinName}</span>
                <small>${s.category === 'conifer' ? 'Conifer' : 'Hardwood'} · Density ${Math.round(s.woodDensity * 100)}%</small>
              </button>
            `
            ).join('')}
          </div>
        </div>

        <div class="sandbox-row">
          <div class="sandbox-section">
            <label>Environment Site</label>
            <div class="choice-grid compact">
              ${(Object.keys(SITE_NAMES) as SiteId[])
                .map(
                  (id) =>
                    `<button class="choice-btn ${this.sbSite === id ? 'active' : ''}" data-site="${id}">${SITE_NAMES[id]}</button>`
                )
                .join('')}
            </div>
          </div>

          <div class="sandbox-section">
            <label>Coastal Weather</label>
            <div class="choice-grid compact">
              ${(Object.keys(WEATHER_NAMES) as WeatherId[])
                .map(
                  (id) =>
                    `<button class="choice-btn ${this.sbWeather === id ? 'active' : ''}" data-weather="${id}">${WEATHER_NAMES[id]}</button>`
                )
                .join('')}
            </div>
          </div>
        </div>

        <div class="sandbox-section">
          <label>Coastal Wind Speed: <strong id="sb-wind-val">${Math.round(this.sbWind * 45)} mph</strong></label>
          <input type="range" id="sb-wind-slider" min="0" max="0.8" step="0.05" value="${this.sbWind}" />
        </div>

        <div class="sandbox-actions">
          <button class="btn btn-primary btn-lg" id="btn-launch-sandbox">Enter Forest Clearing →</button>
        </div>
      </div>
    `;
    this.root.appendChild(wrap);

    wrap.querySelector('#btn-sb-back')?.addEventListener('click', () => this.engine.openScreen('title'));
    wrap.querySelectorAll('[data-species]').forEach((el) => {
      el.addEventListener('click', () => {
        this.sbSpecies = (el as HTMLElement).dataset.species as SpeciesId;
        this.renderSandboxScreenRefresh();
      });
    });
    wrap.querySelectorAll('[data-site]').forEach((el) => {
      el.addEventListener('click', () => {
        this.sbSite = (el as HTMLElement).dataset.site as SiteId;
        this.renderSandboxScreenRefresh();
      });
    });
    wrap.querySelectorAll('[data-weather]').forEach((el) => {
      el.addEventListener('click', () => {
        this.sbWeather = (el as HTMLElement).dataset.weather as WeatherId;
        this.renderSandboxScreenRefresh();
      });
    });
    const slider = wrap.querySelector('#sb-wind-slider') as HTMLInputElement;
    const valEl = wrap.querySelector('#sb-wind-val') as HTMLElement;
    slider?.addEventListener('input', () => {
      this.sbWind = parseFloat(slider.value);
      valEl.textContent = `${Math.round(this.sbWind * 45)} mph`;
    });
    wrap.querySelector('#btn-launch-sandbox')?.addEventListener('click', () => {
      const c = createSandboxContract({
        species: this.sbSpecies,
        site: this.sbSite,
        weather: this.sbWeather,
        windSpeed: this.sbWind,
      });
      this.engine.startContract(c);
    });
  }

  private renderSandboxScreenRefresh(): void {
    this.root.innerHTML = '';
    this.renderSandboxScreen();
  }

  private mountPlayingHUD(state: GameHUDState): void {
    const hud = document.createElement('div');
    hud.className = 'hud-layer';
    hud.innerHTML = `
      <div class="hud-top-left">
        <div class="hud-card contract-hud-card" id="contract-hud-card">
          <div class="contract-hud-head">
            <div class="hud-contract-title" id="hud-title"></div>
            <button
              type="button"
              class="objectives-toggle"
              id="btn-toggle-objectives"
              aria-expanded="false"
              title="Show job tasks"
            >
              <span id="hud-obj-count">0/0</span>
              <span class="objectives-chevron" aria-hidden="true">▾</span>
            </button>
          </div>
          <button type="button" class="objective-chip-mobile" id="hud-obj-chip" aria-expanded="false">
            <span class="obj-check" aria-hidden="true">○</span>
            <span class="obj-text" id="hud-obj-chip-text"></span>
          </button>
          <div class="hud-contract-sub" id="hud-sub"></div>
          <ul class="objective-list objectives-panel" id="hud-objectives"></ul>
        </div>
      </div>

      <div class="hud-top-right">
        <div class="hud-toolbar">
          <div class="wind-pill" id="hud-wind" title="Coastal Wind">
            <span class="wind-arrow" id="hud-wind-arrow">↑</span>
            <span id="hud-wind-text">4 mph</span>
          </div>
          <button class="icon-btn hud-toolbar-desktop" id="btn-mute" title="Toggle Sound">🔊</button>
          <button class="icon-btn hud-toolbar-desktop" id="btn-restart" title="Restart Job">↻</button>
          <div class="hud-menu-wrap">
            <button class="icon-btn" id="btn-menu" title="Menu" aria-expanded="false">☰</button>
            <div class="hud-menu-popover" id="hud-menu-popover" hidden>
              <button type="button" class="hud-menu-item" id="btn-menu-mute">🔊 Sound on</button>
              <button type="button" class="hud-menu-item" id="btn-menu-restart">↻ Restart job</button>
              <button type="button" class="hud-menu-item" id="btn-menu-contracts">All Jobs</button>
            </div>
          </div>
        </div>

        <div class="hud-card species-hud-card" id="hud-species-card">
          <div class="species-head">
            <strong id="hud-sp-name"></strong>
            <em id="hud-sp-latin"></em>
          </div>
          <div class="species-stats" id="hud-sp-stats"></div>
          <p class="species-tip" id="hud-sp-tip"></p>
          <div class="lean-readout" id="hud-lean-box">
            <div class="lean-row">
              <span>Lean / Balance</span>
              <span id="hud-lean-label">Balanced</span>
            </div>
            <div class="lean-bar-track">
              <div class="lean-bar-center"></div>
              <div class="lean-bar-fill" id="hud-lean-fill"></div>
            </div>
          </div>
        </div>
      </div>

      <div class="hud-toast" id="hud-toast"></div>

      <div class="hud-cut-gauge" id="hud-cut-gauge">
        <div class="gauge-header">
          <span class="gauge-label" id="gauge-label">Face Notch Depth</span>
          <span class="gauge-status" id="gauge-status">0%</span>
        </div>
        <div class="gauge-track">
          <div class="gauge-sweet" id="gauge-sweet"></div>
          <div class="gauge-danger" id="gauge-danger"></div>
          <div class="gauge-fill" id="gauge-fill"></div>
        </div>
        <div class="gauge-actions" id="gauge-actions">
          <button class="btn-mini" id="btn-reaim">↺ Change Aim Direction</button>
        </div>
      </div>

      <div class="hud-bottom">
        <div class="prompt-banner">
          <div class="prompt-main" id="hud-prompt"></div>
          <div class="prompt-sub" id="hud-subprompt"></div>
        </div>

        <div class="dock-row">
          <button class="orbit-btn" id="btn-orbit-left" title="Orbit Left (← or Q)">⟲</button>
          <div class="tool-dock" id="hud-tool-dock">
            ${(['prune', 'fell', 'wedge', 'buck'] as ToolId[])
              .map(
                (t) => `
              <button class="tool-btn" data-tool="${t}">
                <span class="tool-key">${TOOL_META[t].key}</span>
                <span class="tool-icon">${TOOL_META[t].icon}</span>
                <span class="tool-name">${TOOL_META[t].name}</span>
              </button>
            `
              )
              .join('')}
          </div>
          <button class="orbit-btn" id="btn-orbit-right" title="Orbit Right (→ or E)">⟳</button>
        </div>
      </div>
    `;

    this.root.appendChild(hud);
    this.playingContainer = hud;
    this.objectivesExpanded = false;
    this.hudMenuOpen = false;

    const toggleMute = () => this.engine.toggleMute();
    const restartJob = () => this.engine.replayContract();
    const openContracts = () => this.engine.openScreen('contracts');

    hud.querySelector('#btn-mute')?.addEventListener('click', toggleMute);
    hud.querySelector('#btn-restart')?.addEventListener('click', restartJob);
    hud.querySelector('#btn-menu-mute')?.addEventListener('click', () => {
      toggleMute();
      this.setHudMenuOpen(false);
    });
    hud.querySelector('#btn-menu-restart')?.addEventListener('click', () => {
      restartJob();
      this.setHudMenuOpen(false);
    });
    hud.querySelector('#btn-menu-contracts')?.addEventListener('click', () => {
      openContracts();
      this.setHudMenuOpen(false);
    });

    const menuBtn = hud.querySelector('#btn-menu') as HTMLButtonElement;
    menuBtn?.addEventListener('click', (e) => {
      if (isTouchUi()) {
        e.stopPropagation();
        this.setHudMenuOpen(!this.hudMenuOpen);
      } else {
        openContracts();
      }
    });

    hud.addEventListener('click', (e) => {
      const t = e.target as Node;
      const pop = hud.querySelector('#hud-menu-popover');
      if (
        this.hudMenuOpen &&
        pop &&
        !pop.contains(t) &&
        !menuBtn.contains(t)
      ) {
        this.setHudMenuOpen(false);
      }
    });

    const toggleObjectives = () => {
      this.objectivesExpanded = !this.objectivesExpanded;
      this.syncObjectivesExpandedUi(hud);
    };
    hud.querySelector('#btn-toggle-objectives')?.addEventListener('click', toggleObjectives);
    hud.querySelector('#hud-obj-chip')?.addEventListener('click', toggleObjectives);
    hud.querySelector('#btn-reaim')?.addEventListener('click', () => this.engine.resetAim());
    hud.querySelector('#btn-orbit-left')?.addEventListener('click', () => this.engine.orbitCameraStep(-1));
    hud.querySelector('#btn-orbit-right')?.addEventListener('click', () => this.engine.orbitCameraStep(1));

    hud.querySelector('#hud-objectives')?.addEventListener('click', (e) => {
      const li = (e.target as HTMLElement | null)?.closest('li[data-tree-id]') as HTMLElement | null;
      const treeId = li?.dataset.treeId;
      if (treeId) {
        this.engine.selectTree(treeId);
        if (isTouchUi()) {
          this.objectivesExpanded = false;
          this.syncObjectivesExpandedUi(hud);
        }
      }
    });

    hud.querySelectorAll('.tool-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const t = (btn as HTMLElement).dataset.tool as ToolId;
        this.engine.setTool(t);
      });
    });

    this.syncObjectivesExpandedUi(hud);
    this.updatePlayingHUD(state);
  }

  private setHudMenuOpen(open: boolean): void {
    const hud = this.playingContainer;
    if (!hud) return;
    this.hudMenuOpen = open;
    const pop = hud.querySelector('#hud-menu-popover') as HTMLElement;
    const btn = hud.querySelector('#btn-menu') as HTMLButtonElement;
    if (pop) pop.hidden = !open;
    if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    btn?.classList.toggle('active', open);
  }

  private syncObjectivesExpandedUi(hud: HTMLElement): void {
    const card = hud.querySelector('#contract-hud-card');
    const toggle = hud.querySelector('#btn-toggle-objectives') as HTMLButtonElement | null;
    card?.classList.toggle('objectives-expanded', this.objectivesExpanded);
    toggle?.setAttribute('aria-expanded', this.objectivesExpanded ? 'true' : 'false');
    const chip = hud.querySelector('#hud-obj-chip') as HTMLButtonElement | null;
    chip?.setAttribute('aria-expanded', this.objectivesExpanded ? 'true' : 'false');
  }

  private updatePlayingHUD(state: GameHUDState): void {
    const hud = this.playingContainer;
    if (!hud || !state.contract) return;

    (hud.querySelector('#hud-title') as HTMLElement).textContent = state.contract.title;
    (hud.querySelector('#hud-sub') as HTMLElement).textContent = state.contract.subtitle;

    // Objectives (click any item to focus camera on that tree; only touch DOM when changed so clicks never drop!)
    const objEl = hud.querySelector('#hud-objectives') as HTMLElement;
    const nextObjHtml = state.objectives
      .map(
        (o) => `
      <li class="${o.done ? 'done' : ''} ${o.treeId && o.treeId === state.activeTreeId ? 'active-tree' : ''}" data-tree-id="${o.treeId ?? ''}" title="Click to focus camera on this tree">
        <span class="obj-check">${o.done ? '✓' : '○'}</span>
        <span class="obj-text">${o.text}</span>
        ${o.progress ? `<span class="obj-prog">${o.progress}</span>` : ''}
      </li>`
      )
      .join('');
    if (objEl.innerHTML !== nextObjHtml) {
      objEl.innerHTML = nextObjHtml;
    }

    const doneCount = state.objectives.filter((o) => o.done).length;
    (hud.querySelector('#hud-obj-count') as HTMLElement).textContent = `${doneCount}/${state.objectives.length}`;
    const nextOpen = state.objectives.find((o) => !o.done);
    const chipText = hud.querySelector('#hud-obj-chip-text') as HTMLElement;
    chipText.textContent = nextOpen
      ? nextOpen.text
      : state.objectives.length > 0
        ? 'All tasks complete'
        : '';
    const chipCheck = hud.querySelector('#hud-obj-chip .obj-check') as HTMLElement | null;
    if (chipCheck) {
      chipCheck.textContent = nextOpen ? '○' : state.objectives.length > 0 ? '✓' : '○';
    }

    // Wind & Mute
    const mph = Math.round(state.windSpeed * 45);
    (hud.querySelector('#hud-wind-text') as HTMLElement).textContent = `${mph} mph`;
    const windArrow = hud.querySelector('#hud-wind-arrow') as HTMLElement;
    const deg = (state.windAngle * 180) / Math.PI - state.cameraAngleDeg;
    windArrow.style.transform = `rotate(${deg}deg)`;
    const muteGlyph = state.muted ? '🔇' : '🔊';
    (hud.querySelector('#btn-mute') as HTMLElement).textContent = muteGlyph;
    const menuMute = hud.querySelector('#btn-menu-mute') as HTMLElement;
    if (menuMute) {
      menuMute.textContent = state.muted ? '🔇 Sound off' : '🔊 Sound on';
    }

    // Active Species Card
    const spCard = hud.querySelector('#hud-species-card') as HTMLElement;
    if (state.activeTreeSpecies) {
      spCard.style.display = 'block';
      const sp = state.activeTreeSpecies;
      (hud.querySelector('#hud-sp-name') as HTMLElement).textContent = sp.name;
      (hud.querySelector('#hud-sp-latin') as HTMLElement).textContent = sp.latinName;
      (hud.querySelector('#hud-sp-stats') as HTMLElement).innerHTML = `
        <span>${sp.category === 'conifer' ? 'Conifer' : 'Hardwood'}</span>
        <span>Saw Speed: ${sp.woodDensity < 0.85 ? 'Fast' : sp.woodDensity > 1.15 ? 'Tough' : 'Medium'}</span>
      `;
      (hud.querySelector('#hud-sp-tip') as HTMLElement).textContent = sp.arboristTip;
    } else {
      spCard.style.display = 'none';
    }

    // Lean / Center of Gravity Readout
    const leanBox = hud.querySelector('#hud-lean-box') as HTMLElement;
    if (state.leanInfo.visible) {
      leanBox.style.display = 'block';
      const fill = hud.querySelector('#hud-lean-fill') as HTMLElement;
      const lbl = hud.querySelector('#hud-lean-label') as HTMLElement;
      const v = state.leanInfo.helpsAim; // -1..+1
      const pct = Math.abs(v) * 50;
      fill.style.width = `${Math.max(4, pct)}%`;
      fill.style.left = v >= 0 ? '50%' : `${50 - pct}%`;
      if (state.leanInfo.needsWedge) {
        const hasWedge = state.unlockedTools.includes('wedge');
        fill.style.background = '#f97316';
        lbl.textContent =
          state.leanInfo.wedgesDriven > 0
            ? `Back-Lean (${state.leanInfo.wedgesDriven} Wedge)`
            : hasWedge
              ? 'Back-Lean · Needs Wedge/Prune'
              : 'Back-Lean · Prune Heavy Limbs';
        lbl.style.color = '#fb923c';
      } else if (v > 0.15) {
        fill.style.background = '#34d399';
        lbl.textContent = 'Forward Lean (Favorable)';
        lbl.style.color = '#6ee7b7';
      } else {
        fill.style.background = '#38bdf8';
        lbl.textContent = 'Balanced Plumb';
        lbl.style.color = '#bae6fd';
      }
    } else {
      leanBox.style.display = 'none';
    }

    // Cutting Gauge
    const gaugeEl = hud.querySelector('#hud-cut-gauge') as HTMLElement;
    if (state.gauge.visible) {
      gaugeEl.classList.add('visible');
      (hud.querySelector('#gauge-label') as HTMLElement).textContent = state.gauge.label;
      const stEl = hud.querySelector('#gauge-status') as HTMLElement;
      stEl.textContent = state.gauge.statusText;
      stEl.dataset.tone = state.gauge.statusTone;

      const sweet = hud.querySelector('#gauge-sweet') as HTMLElement;
      sweet.style.left = `${state.gauge.sweetMin * 100}%`;
      sweet.style.width = `${(state.gauge.sweetMax - state.gauge.sweetMin) * 100}%`;

      const danger = hud.querySelector('#gauge-danger') as HTMLElement;
      if (state.gauge.dangerMin !== undefined) {
        danger.style.display = 'block';
        danger.style.left = `${state.gauge.dangerMin * 100}%`;
        danger.style.width = `${(1 - state.gauge.dangerMin) * 100}%`;
      } else {
        danger.style.display = 'none';
      }

      const fill = hud.querySelector('#gauge-fill') as HTMLElement;
      fill.style.width = `${Math.min(100, state.gauge.value * 100)}%`;
      fill.dataset.tone = state.gauge.statusTone;

      const actionsEl = hud.querySelector('#gauge-actions') as HTMLElement;
      actionsEl.style.display = state.activeTreeStage === 'aimed' ? 'flex' : 'none';
    } else {
      gaugeEl.classList.remove('visible');
    }

    // Prompt Banner
    (hud.querySelector('#hud-prompt') as HTMLElement).textContent = state.promptText;
    (hud.querySelector('#hud-subprompt') as HTMLElement).textContent = state.subPromptText;

    // Tool Dock states
    hud.querySelectorAll('.tool-btn').forEach((btn) => {
      const el = btn as HTMLElement;
      const t = el.dataset.tool as ToolId;
      const unlocked = state.unlockedTools.includes(t);
      el.classList.toggle('locked', !unlocked);
      el.classList.toggle('active', state.activeTool === t);
      const pulseWedge = t === 'wedge' && unlocked && state.activeTreeStage === 'hinge_ready';
      const pulseBuck = t === 'buck' && unlocked && state.activeTreeStage === 'fallen';
      el.classList.toggle('attention', pulseWedge || pulseBuck);
    });

    // Toast notification
    const toastEl = hud.querySelector('#hud-toast') as HTMLElement;
    if (state.toast) {
      toastEl.textContent = state.toast.text;
      toastEl.dataset.tone = state.toast.tone;
      toastEl.classList.add('visible');
    } else {
      toastEl.classList.remove('visible');
    }
  }

  private renderDebriefScreen(state: GameHUDState): void {
    const d = state.debrief;
    if (!d || !state.contract) return;

    const wrap = document.createElement('div');
    wrap.className = 'overlay-screen debrief-screen';
    wrap.innerHTML = `
      <div class="debrief-card">
        <div class="eyebrow">${state.contract.title}</div>
        <h2>${d.stars === 3 ? 'Master Arborist Work!' : d.stars === 2 ? 'Job Complete!' : 'Job Logged — Review Safety'}</h2>
        <div class="debrief-stars">${'★'.repeat(d.stars)}<span>${'☆'.repeat(3 - d.stars)}</span></div>

        <div class="debrief-stats">
          <div class="stat-box">
            <label>Accuracy</label>
            <strong>${d.accuracyScore}%</strong>
          </div>
          <div class="stat-box">
            <label>Safety Bonus</label>
            <strong>+$${d.safetyBonus}</strong>
          </div>
          <div class="stat-box">
            <label>Timber Value</label>
            <strong>$${d.timberValue}</strong>
          </div>
          <div class="stat-box highlight">
            <label>Total Earned</label>
            <strong>$${d.totalEarned}</strong>
          </div>
        </div>

        ${
          d.highlights.length > 0
            ? `<div class="debrief-list good">${d.highlights.map((h) => `<div>✓ ${h}</div>`).join('')}</div>`
            : ''
        }
        ${
          d.penalties.length > 0
            ? `<div class="debrief-list warn">${d.penalties.map((p) => `<div>! ${p}</div>`).join('')}</div>`
            : ''
        }

        <div class="debrief-actions">
          ${d.hasNextContract ? `<button class="btn btn-primary btn-lg" id="btn-next-contract">Next Job →</button>` : ''}
          <button class="btn btn-secondary" id="btn-replay">Try Again</button>
          <button class="btn btn-ghost" id="btn-all-contracts">All Jobs</button>
        </div>
      </div>
    `;
    this.root.appendChild(wrap);

    wrap.querySelector('#btn-next-contract')?.addEventListener('click', () => this.engine.startNextContract());
    wrap.querySelector('#btn-replay')?.addEventListener('click', () => this.engine.replayContract());
    wrap.querySelector('#btn-all-contracts')?.addEventListener('click', () => this.engine.openScreen('contracts'));
  }

  public getLastState(): GameHUDState | null {
    return this.lastState;
  }
}
