import * as THREE from 'three';
import {
  BranchData,
  BuckRingData,
  ContractSpec,
  GameHUDState,
  StandingTopCutData,
  ToolId,
  TreeRuntime,
} from '../types';
import { CAMPAIGN_CONTRACTS } from '../data/contracts';
import { AudioEngine } from '../audio/AudioEngine';
import { buildEnvironment, BuiltEnvironment } from '../graphics/EnvironmentBuilder';
import { buildTreeRuntime, recomputeTreeLean, syncTrunkCutVisuals } from '../graphics/TreeGenerator';
import { CameraController, CameraKeyframe } from './CameraController';
import { ParticleSystem } from './ParticleSystem';
import {
  cameraOrbitZoomHint,
  introSkipHint,
  localizeControlCopy,
  orbitOnlyHint,
} from '../ui/inputHints';

type HUDListener = (state: GameHUDState) => void;

const STORAGE_KEY = 'canopy3d_save_v1';

interface SavedProgress {
  completedContracts: Record<string, { stars: number; score: number; earnings: number }>;
  totalEarnings: number;
}

export class GameEngine {
  private canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private cameraCtrl: CameraController;
  private particles: ParticleSystem;
  public audio: AudioEngine;

  private env: BuiltEnvironment | null = null;
  private trees: TreeRuntime[] = [];
  private currentContract: ContractSpec | null = null;

  private screen: GameHUDState['screen'] = 'title';
  private activeTool: ToolId = 'prune';
  private activeTreeId: string | null = null;

  // Pointer & raycasting
  private raycaster = new THREE.Raycaster();
  private pointerNDC = new THREE.Vector2();
  private pointerScreen = { x: 0, y: 0 };
  private isLeftDown = false;
  private hoveredBranch: BranchData | null = null;
  private hoveredBuckRing: { tree: TreeRuntime; ring: BuckRingData } | null = null;
  private hoveredTopCut: { tree: TreeRuntime; cut: StandingTopCutData } | null = null;
  private cuttingBranch: BranchData | null = null;
  private cuttingBuck: { tree: TreeRuntime; ring: BuckRingData } | null = null;
  private cuttingTopCut: { tree: TreeRuntime; cut: StandingTopCutData } | null = null;
  private cuttingTrunkStage: 'none' | 'notch' | 'backcut' = 'none';
  private groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private _occBox = new THREE.Box3();
  private _occCenter = new THREE.Vector3();
  private _occSize = new THREE.Vector3();

  // 3D Diegetic Visual Guides
  private aimGuideGroup: THREE.Group;
  private aimShadowMesh: THREE.Mesh;
  private aimCenterLine: THREE.Mesh;
  private aimArrowHead: THREE.Mesh;
  private leanArrowGroup: THREE.Group;
  private leanShaft: THREE.Mesh;
  private leanTip: THREE.Mesh;
  private trunkCutHighlight: THREE.Mesh;

  // Dynamic cursor progress callback
  private cursorProgressCb?: (visible: boolean, x: number, y: number, progress: number, label: string, tone: string) => void;

  // Loop & state
  private clock = new THREE.Clock();
  private elapsed = 0;
  private animFrameId = 0;
  private hudListener: HUDListener;
  private hudEmitTimer = 0;
  private toastCounter = 0;
  private currentToast: GameHUDState['toast'] = undefined;
  private toastExpireAt = 0;

  // Animated 3-blow ("tok-tok-tok") ghostly orange felling wedge insertion
  private activeWedgeAnim: {
    tree: TreeRuntime;
    wedgeIndex: number;
    elapsed: number;
    blowsFired: number;
    startDist: number;
    endDist: number;
    currentProgress: number;
    targetProgress: number;
    flashIntensity: number;
  } | null = null;

  // Persistent progression
  private completedContracts: Record<string, { stars: number; score: number; earnings: number }> = {};
  private totalEarnings = 0;
  private debriefData: GameHUDState['debrief'] = undefined;
  private contractFinished = false;
  private completionDelay = 0;

  constructor(canvas: HTMLCanvasElement, hudListener: HUDListener) {
    this.canvas = canvas;
    this.hudListener = hudListener;

    this.loadProgress();

    // Renderer setup with rich filmic tone mapping & crisp shadows
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.26;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(46, window.innerWidth / window.innerHeight, 0.25, 400);
    this.cameraCtrl = new CameraController(this.camera, canvas);
    this.particles = new ParticleSystem(this.scene);
    this.audio = new AudioEngine();

    // Build reusable 3D aiming & cutting guides
    this.aimGuideGroup = new THREE.Group();
    this.aimGuideGroup.visible = false;

    const shadowGeo = new THREE.PlaneGeometry(1, 1);
    shadowGeo.rotateX(-Math.PI / 2);
    shadowGeo.translate(0.5, 0.09, 0);
    this.aimShadowMesh = new THREE.Mesh(
      shadowGeo,
      new THREE.MeshBasicMaterial({
        color: '#22c55e',
        transparent: true,
        opacity: 0.34,
        side: THREE.DoubleSide,
        depthWrite: false,
      })
    );
    this.aimGuideGroup.add(this.aimShadowMesh);

    const lineGeo = new THREE.PlaneGeometry(1, 0.22);
    lineGeo.rotateX(-Math.PI / 2);
    lineGeo.translate(0.5, 0.11, 0);
    this.aimCenterLine = new THREE.Mesh(
      lineGeo,
      new THREE.MeshBasicMaterial({
        color: '#86efac',
        transparent: true,
        opacity: 0.9,
        side: THREE.DoubleSide,
        depthWrite: false,
      })
    );
    this.aimGuideGroup.add(this.aimCenterLine);

    const headGeo = new THREE.ConeGeometry(0.65, 1.3, 4);
    headGeo.rotateZ(-Math.PI / 2);
    headGeo.rotateX(Math.PI / 4);
    this.aimArrowHead = new THREE.Mesh(
      headGeo,
      new THREE.MeshBasicMaterial({
        color: '#86efac',
        transparent: true,
        opacity: 0.92,
      })
    );
    this.aimArrowHead.position.y = 0.22;
    this.aimGuideGroup.add(this.aimArrowHead);
    this.scene.add(this.aimGuideGroup);

    // Lean + Wind vector indicator arrow near base of tree
    this.leanArrowGroup = new THREE.Group();
    this.leanArrowGroup.visible = false;
    const shaftGeo = new THREE.BoxGeometry(1, 0.1, 0.18);
    shaftGeo.translate(0.5, 0.18, 0);
    const leanMat = new THREE.MeshBasicMaterial({ color: '#f59e0b', transparent: true, opacity: 0.85 });
    this.leanShaft = new THREE.Mesh(shaftGeo, leanMat);
    const tipGeo = new THREE.ConeGeometry(0.32, 0.7, 6);
    tipGeo.rotateZ(-Math.PI / 2);
    this.leanTip = new THREE.Mesh(tipGeo, leanMat);
    this.leanTip.position.y = 0.18;
    this.leanArrowGroup.add(this.leanShaft, this.leanTip);
    this.scene.add(this.leanArrowGroup);

    // Glowing trunk cut guide ring (shows where to hold click for notch/backcut/wedge)
    this.trunkCutHighlight = new THREE.Mesh(
      new THREE.TorusGeometry(1, 0.08, 10, 28),
      new THREE.MeshBasicMaterial({
        color: '#fbbf24',
        transparent: true,
        opacity: 0.88,
      })
    );
    this.trunkCutHighlight.rotation.x = Math.PI / 2;
    this.trunkCutHighlight.visible = false;
    this.scene.add(this.trunkCutHighlight);

    this.bindInputEvents();

    // Load a lush PNW title diorama right away!
    this.loadDioramaScene();
    this.emitHUD();
    this.loop();
  }

  public setCursorProgressCallback(
    cb: (visible: boolean, x: number, y: number, progress: number, label: string, tone: string) => void
  ): void {
    this.cursorProgressCb = cb;
  }

  private loadProgress(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as SavedProgress;
      this.completedContracts = parsed.completedContracts ?? {};
      this.totalEarnings = parsed.totalEarnings ?? 0;
    } catch {
      // ignore
    }
  }

  private saveProgress(): void {
    try {
      const data: SavedProgress = {
        completedContracts: this.completedContracts,
        totalEarnings: this.totalEarnings,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      // ignore
    }
  }

  private loadDioramaScene(): void {
    this.clearCurrentScene();
    const previewContract = CAMPAIGN_CONTRACTS[2]; // Golden Hour Coastal Homestead with Cedar!
    this.env = buildEnvironment(this.scene, previewContract);
    for (const tSpec of previewContract.trees) {
      const t = buildTreeRuntime(tSpec);
      t.selectionRing.visible = false;
      this.scene.add(t.rootGroup);
      this.trees.push(t);
    }
    this.cameraCtrl.focusOn(new THREE.Vector3(0, 7.2, 0), 30, 1.23, 0.62);
    this.cameraCtrl.applyImmediate();
    this.cameraCtrl.setAutoRotate(0.08);
  }

  private clearCurrentScene(): void {
    this.particles.clearAll();
    if (this.env) {
      this.scene.remove(this.env.group);
      this.env = null;
    }
    for (const t of this.trees) {
      this.scene.remove(t.rootGroup);
      if (t.dropZoneGroup) this.scene.remove(t.dropZoneGroup);
    }
    this.trees = [];
    this.aimGuideGroup.visible = false;
    this.leanArrowGroup.visible = false;
    this.trunkCutHighlight.visible = false;
    this.hoveredBranch = null;
    this.hoveredBuckRing = null;
    this.hoveredTopCut = null;
    this.cuttingBranch = null;
    this.cuttingBuck = null;
    this.cuttingTopCut = null;
    this.cuttingTrunkStage = 'none';
    this.activeWedgeAnim = null;
    this.audio.setSawActive('none');
    this.cameraCtrl.cancelIntro(false);
  }

  public openScreen(screen: GameHUDState['screen']): void {
    this.audio.init();
    this.audio.playClick();
    this.audio.setSawActive('none');
    this.audio.setChainsawSelected(false);
    this.cameraCtrl.cancelIntro(false);
    this.screen = screen;
    if (screen === 'title') {
      this.cameraCtrl.setAutoRotate(0.08);
    }
    this.emitHUD();
  }

  public startContract(contract: ContractSpec): void {
    this.audio.init();
    this.audio.playClick();
    this.clearCurrentScene();

    this.currentContract = contract;
    this.screen = 'playing';
    this.contractFinished = false;
    this.completionDelay = 0;
    this.debriefData = undefined;
    this.cameraCtrl.setAutoRotate(0);

    this.env = buildEnvironment(this.scene, contract);
    this.audio.setWindLevel(contract.windSpeed);

    // Spawn all contract trees & drop zones
    for (const tSpec of contract.trees) {
      const tree = buildTreeRuntime(tSpec);
      this.scene.add(tree.rootGroup);
      if (tSpec.dropZone) {
        tree.dropZoneGroup = this.buildDropZoneVisual(tSpec.dropZone);
        this.scene.add(tree.dropZoneGroup);
      }
      this.trees.push(tree);
    }

    // Select first tree & appropriate starting tool
    const firstTree = this.trees[0] ?? null;
    this.activeTreeId = firstTree ? firstTree.spec.id : null;
    if (firstTree) {
      if (firstTree.spec.task === 'prune_only' || firstTree.spec.task === 'prune_and_fell') {
        this.activeTool = 'prune';
      } else {
        this.activeTool = 'fell';
      }
      this.playContractIntro();
    }

    this.showToast(`Job Started: ${contract.title}`, 'info');
    this.emitHUD();
  }

  public startNextContract(): void {
    if (!this.currentContract) return;
    const idx = CAMPAIGN_CONTRACTS.findIndex((c) => c.id === this.currentContract?.id);
    if (idx >= 0 && idx + 1 < CAMPAIGN_CONTRACTS.length) {
      this.startContract(CAMPAIGN_CONTRACTS[idx + 1]);
    } else {
      this.openScreen('contracts');
    }
  }

  public replayContract(): void {
    if (this.currentContract) {
      this.startContract(this.currentContract);
    }
  }

  public setTool(tool: ToolId): void {
    if (!this.currentContract) return;
    if (!this.currentContract.unlockedTools.includes(tool)) return;
    this.audio.init();
    this.audio.playClick();
    this.activeTool = tool;
    this.cuttingBranch = null;
    this.cuttingBuck = null;
    this.cuttingTrunkStage = 'none';
    this.audio.setSawActive('none');
    this.focusCameraForCurrentState(false);
    this.emitHUD();
  }

  public selectTree(treeId: string, silent = false): void {
    const found = this.trees.find((t) => t.spec.id === treeId);
    if (!found) return;
    if (!silent) this.audio.playClick();
    this.activeTreeId = treeId;

    // Auto-select smart tool for newly clicked tree
    if (found.stage === 'fallen' && this.currentContract?.unlockedTools.includes('buck')) {
      this.activeTool = 'buck';
    } else if (found.spec.task === 'prune_only' || (found.spec.task === 'prune_and_fell' && found.prunedTargetCount < found.spec.hazardBranches)) {
      this.activeTool = 'prune';
    } else if (found.stage === 'hinge_ready' && this.currentContract?.unlockedTools.includes('wedge')) {
      this.activeTool = 'wedge';
    } else if (this.currentContract?.unlockedTools.includes('fell') && found.stage !== 'fallen' && found.stage !== 'bucked') {
      this.activeTool = 'fell';
    }

    this.focusCameraForCurrentState(false);
    this.emitHUD();
  }

  private focusNextIncompleteTree(excludeId?: string): void {
    if (this.contractFinished) return;
    const next = this.trees.find((t) => !t.completed && t.spec.id !== excludeId);
    if (next) {
      this.selectTree(next.spec.id, true);
    }
  }

  public resetAim(): void {
    const tree = this.getActiveTree();
    if (!tree || tree.stage !== 'aimed') return;
    tree.stage = 'standing';
    this.audio.playClick();
    this.focusCameraForCurrentState(false);
    this.emitHUD();
  }

  public orbitCameraStep(dir: -1 | 1): void {
    this.cameraCtrl.orbitStep(dir * 0.52);
  }

  public toggleMute(): void {
    this.audio.init();
    this.audio.toggleMute();
    this.emitHUD();
  }

  private getActiveTree(): TreeRuntime | null {
    if (!this.activeTreeId) return this.trees[0] ?? null;
    return this.trees.find((t) => t.spec.id === this.activeTreeId) ?? this.trees[0] ?? null;
  }

  /**
   * Softly fade non-active playable trees that sit between the camera and the
   * current subject / action focus, so the working tree stays readable.
   * Fallen / bucked trees use a wider XZ corridor test (no strict height gate)
   * so a downed crown lying across the view still dissolves.
   */
  private updatePlayableTreeOcclusion(
    cameraPos: THREE.Vector3,
    targetPos: THREE.Vector3,
    dt: number
  ): void {
    const activeId = this.getActiveTree()?.spec.id ?? null;
    const dx = targetPos.x - cameraPos.x;
    const dy = targetPos.y - cameraPos.y;
    const dz = targetPos.z - cameraPos.z;
    const horizLenSq = dx * dx + dz * dz;
    const invHorizLenSq = horizLenSq > 0.001 ? 1 / horizLenSq : 0;
    const lerpRate = Math.min(1, 8.5 * dt);
    const playing = this.screen === 'playing';

    for (const tree of this.trees) {
      let targetFade = 1;
      const isDowned =
        tree.stage === 'fallen' || tree.stage === 'bucked' || tree.stage === 'falling';
      const minFade = isDowned ? 0.08 : 0.14;

      if (playing && activeId && tree.spec.id !== activeId) {
        this._occBox.setFromObject(tree.rootGroup);
        if (!this._occBox.isEmpty()) {
          this._occBox.getCenter(this._occCenter);
          this._occBox.getSize(this._occSize);
          const rMax = Math.max(this._occSize.x, this._occSize.z) * 0.55;
          const yMin = this._occBox.min.y - 1.5;
          const yMax = this._occBox.max.y + (isDowned ? 6.0 : 2.0);

          // Near-camera dissolve (lens inside / beside another tree's crown or downed canopy)
          const camHoriz = Math.hypot(this._occCenter.x - cameraPos.x, this._occCenter.z - cameraPos.z);
          const nearPad = isDowned ? rMax + 7.5 : rMax + 5.8;
          if (camHoriz < nearPad && cameraPos.y >= yMin && cameraPos.y <= yMax + (isDowned ? 8 : 2)) {
            const nearFactor = THREE.MathUtils.clamp(
              (camHoriz - (rMax * (isDowned ? 0.35 : 0.65) + 1.2)) / (isDowned ? 5.5 : 4.2),
              minFade,
              1
            );
            targetFade = Math.min(targetFade, nearFactor);
          }

          // Also fade when the camera is simply close to any part of a downed canopy AABB
          if (isDowned && this._occBox.distanceToPoint(cameraPos) < 6.5) {
            const d = this._occBox.distanceToPoint(cameraPos);
            targetFade = Math.min(
              targetFade,
              THREE.MathUtils.clamp(d / 6.5, minFade, 1)
            );
          }

          // Sight-corridor fade between camera and the active action focus
          if (invHorizLenSq > 0) {
            const uRaw =
              ((this._occCenter.x - cameraPos.x) * dx + (this._occCenter.z - cameraPos.z) * dz) *
              invHorizLenSq;
            const uLo = isDowned ? -0.2 : -0.15;
            const uHi = isDowned ? 1.05 : 0.95;
            if (uRaw > uLo && uRaw < uHi) {
              const u = THREE.MathUtils.clamp(uRaw, 0, 1);
              const px = cameraPos.x + dx * u;
              const py = cameraPos.y + dy * u;
              const pz = cameraPos.z + dz * u;

              // Downed trees: ignore strict height gate — a horizontal canopy still blocks the view
              const heightOk = isDowned || (py >= yMin && py <= yMax);
              if (heightOk) {
                const perpDist = Math.hypot(this._occCenter.x - px, this._occCenter.z - pz);
                const clearRadius = rMax * (isDowned ? 0.85 : 0.85) + (isDowned ? 2.4 : 1.8) + (1 - u) * 3.0;
                const softBand = isDowned ? 5.5 : 3.8;
                if (perpDist < clearRadius + softBand) {
                  const sightFactor = THREE.MathUtils.clamp(
                    (perpDist - clearRadius) / softBand,
                    minFade,
                    1
                  );
                  targetFade = Math.min(targetFade, sightFactor);
                }
              }
            }
          }
        }
      }

      const nextFade = tree.occlusionFade + (targetFade - tree.occlusionFade) * lerpRate;
      const snapped =
        Math.abs(nextFade - targetFade) < 0.004 ? targetFade : nextFade;
      if (Math.abs(snapped - tree.occlusionFade) < 0.001) continue;
      tree.occlusionFade = snapped;

      this.applyOcclusionMaterials(tree.occlusionMaterials, snapped);
    }
  }

  /**
   * Fade buildings / hazards between the camera and the working tree (same corridor test as trees).
   */
  private updateSceneStructureOcclusion(
    cameraPos: THREE.Vector3,
    targetPos: THREE.Vector3,
    dt: number
  ): void {
    const occluders = this.env?.sceneOccluders;
    if (!occluders?.length || this.screen !== 'playing' || !this.getActiveTree()) return;

    const dx = targetPos.x - cameraPos.x;
    const dy = targetPos.y - cameraPos.y;
    const dz = targetPos.z - cameraPos.z;
    const horizLenSq = dx * dx + dz * dz;
    const invHorizLenSq = horizLenSq > 0.001 ? 1 / horizLenSq : 0;
    const lerpRate = Math.min(1, 8.5 * dt);
    const minFade = 0.1;

    for (const occ of occluders) {
      let targetFade = 1;
      this._occBox.setFromObject(occ.rootGroup);
      if (this._occBox.isEmpty()) continue;

      this._occBox.getCenter(this._occCenter);
      this._occBox.getSize(this._occSize);
      const rMax = Math.max(this._occSize.x, this._occSize.z) * 0.58;
      const yMin = this._occBox.min.y - 1.2;
      const yMax = this._occBox.max.y + 2.5;

      const camHoriz = Math.hypot(this._occCenter.x - cameraPos.x, this._occCenter.z - cameraPos.z);
      const nearPad = rMax + 6.5;
      if (camHoriz < nearPad + 2.5 && cameraPos.y >= yMin - 1 && cameraPos.y <= yMax + 3) {
        const nearFactor = THREE.MathUtils.clamp((camHoriz - (rMax * 0.4 + 1.0)) / 5.0, minFade, 1);
        targetFade = Math.min(targetFade, nearFactor);
      }

      if (this._occBox.distanceToPoint(cameraPos) < 7.5) {
        const d = this._occBox.distanceToPoint(cameraPos);
        targetFade = Math.min(targetFade, THREE.MathUtils.clamp(d / 7.5, minFade, 1));
      }

      if (invHorizLenSq > 0) {
        const uRaw =
          ((this._occCenter.x - cameraPos.x) * dx + (this._occCenter.z - cameraPos.z) * dz) * invHorizLenSq;
        if (uRaw > -0.18 && uRaw < 1.02) {
          const u = THREE.MathUtils.clamp(uRaw, 0, 1);
          const px = cameraPos.x + dx * u;
          const py = cameraPos.y + dy * u;
          const pz = cameraPos.z + dz * u;

          if (py >= yMin && py <= yMax + 1.5) {
            const perpDist = Math.hypot(this._occCenter.x - px, this._occCenter.z - pz);
            const clearRadius = rMax * 0.9 + 2.0 + (1 - u) * 3.2;
            const softBand = 5.0;
            if (perpDist < clearRadius + softBand) {
              const sightFactor = THREE.MathUtils.clamp(
                (perpDist - clearRadius) / softBand,
                minFade,
                1
              );
              targetFade = Math.min(targetFade, sightFactor);
            }
          }
        }
      }

      const nextFade = occ.occlusionFade + (targetFade - occ.occlusionFade) * lerpRate;
      const snapped = Math.abs(nextFade - targetFade) < 0.004 ? targetFade : nextFade;
      if (Math.abs(snapped - occ.occlusionFade) < 0.001) continue;
      occ.occlusionFade = snapped;
      this.applyOcclusionMaterials(occ.occlusionMaterials, snapped);
    }
  }

  private applyOcclusionMaterials(
    occlusionMaterials: Array<{ mat: THREE.Material; baseOpacity: number }>,
    snapped: number
  ): void {
    for (const entry of occlusionMaterials) {
      if (snapped >= 0.995) {
        const nextTransparent = entry.baseOpacity < 0.999;
        entry.mat.opacity = entry.baseOpacity;
        entry.mat.depthWrite = true;
        if (entry.mat.transparent !== nextTransparent) {
          entry.mat.transparent = nextTransparent;
          entry.mat.needsUpdate = true;
        }
      } else {
        entry.mat.opacity = entry.baseOpacity * snapped;
        entry.mat.depthWrite = snapped > 0.72;
        if (!entry.mat.transparent) {
          entry.mat.transparent = true;
          entry.mat.needsUpdate = true;
        }
      }
    }
  }

  private getNextStandingTopCut(tree: TreeRuntime): StandingTopCutData | null {
    if (tree.stage !== 'standing' && tree.stage !== 'aimed') return null;
    for (const cut of tree.standingTopCuts) {
      if (!cut.cutDone) return cut;
    }
    return null;
  }

  private findStandingTopCutUnderRay(maxRayDist = 2.6): { tree: TreeRuntime; cut: StandingTopCutData } | null {
    const targets: THREE.Object3D[] = [];
    const candidates: Array<{ tree: TreeRuntime; cut: StandingTopCutData }> = [];
    for (const t of this.trees) {
      const nextCut = this.getNextStandingTopCut(t);
      if (nextCut) {
        targets.push(nextCut.colliderMesh, nextCut.ringMesh);
        candidates.push({ tree: t, cut: nextCut });
      }
    }
    if (candidates.length === 0) return null;

    const hits = this.raycaster.intersectObjects(targets, false);
    if (hits.length > 0) {
      const { treeId, topCutId } = hits[0].object.userData;
      const match = candidates.find(
        (c) => c.tree.spec.id === treeId && c.cut.id === topCutId
      );
      if (match) return match;
    }

    // Forgiving proximity snap to the glowing golden ring from wide bird's-eye camera angles
    let best: { tree: TreeRuntime; cut: StandingTopCutData } | null = null;
    let bestDist = maxRayDist;
    const wp = new THREE.Vector3();
    for (const cand of candidates) {
      cand.cut.ringMesh.getWorldPosition(wp);
      const d = this.raycaster.ray.distanceToPoint(wp);
      if (d < bestDist) {
        bestDist = d;
        best = cand;
      }
    }
    return best;
  }

  private scoreAzimuthObstruction(
    tree: TreeRuntime,
    az: number,
    distance: number,
    polar: number,
    focusX: number = tree.spec.x,
    focusZ: number = tree.spec.z
  ): number {
    const camHoriz = distance * Math.sin(polar);
    const dirX = Math.cos(az);
    const dirZ = Math.sin(az);
    const camX = focusX + dirX * camHoriz;
    const camZ = focusZ + dirZ * camHoriz;
    let penalty = 0;

    // 1. Penalize tall buildings / structures between camera and target
    const hazards = this.currentContract?.hazards ?? [];
    for (const hz of hazards) {
      if (
        hz.type !== 'cabin' &&
        hz.type !== 'aframe' &&
        hz.type !== 'house' &&
        hz.type !== 'barn' &&
        hz.type !== 'shed' &&
        hz.type !== 'greenhouse' &&
        hz.type !== 'gazebo'
      ) {
        continue;
      }
      const rx = hz.x - focusX;
      const rz = hz.z - focusZ;
      const proj = rx * dirX + rz * dirZ;
      const perp = Math.abs(rx * -dirZ + rz * dirX);
      const clearMargin = hz.radius + 2.4;
      const tallWeight =
        hz.type === 'cabin' || hz.type === 'aframe' || hz.type === 'house' || hz.type === 'barn'
          ? 14
          : 6;

      if (proj > 1.0 && proj < camHoriz + hz.radius && perp < clearMargin) {
        penalty += tallWeight * (1 - perp / clearMargin);
      }
      const camDist = Math.hypot(hz.x - camX, hz.z - camZ);
      if (camDist < hz.radius + 3.5) {
        penalty += tallWeight * 0.75 * (1 - camDist / (hz.radius + 3.5));
      }
    }

    // 2. Penalize other standing playable trees between camera and target (or crowding the lens!)
    for (const other of this.trees) {
      if (other.spec.id === tree.spec.id) continue;
      if (other.stage === 'fallen' || other.stage === 'bucked') continue;

      const crownR = Math.max(3.6, other.currentHeight * 0.28);
      const rx = other.spec.x - focusX;
      const rz = other.spec.z - focusZ;
      const proj = rx * dirX + rz * dirZ;
      const perp = Math.abs(rx * -dirZ + rz * dirX);
      const clearMargin = crownR + 2.8;

      if (proj > 0.8 && proj < camHoriz + crownR + 2.0 && perp < clearMargin) {
        penalty += 18 * (1 - perp / clearMargin);
      }
      const camDist = Math.hypot(other.spec.x - camX, other.spec.z - camZ);
      if (camDist < crownR + 4.5) {
        penalty += 14 * (1 - camDist / (crownR + 4.5));
      }
    }

    return penalty;
  }

  private pickClearPruneAzimuth(
    tree: TreeRuntime,
    tagAngle: number,
    distance: number,
    polar: number
  ): number {
    // ~45° oblique 3/4 view keeps branch-tip foliage off to the side so yellow collar ribbons
    // & tags are completely unobstructed and viewed broadside!
    const offsets = [0.78, -0.78, 0.58, -0.58, 1.02, -1.02];
    let bestAz = tagAngle + 0.78;
    let bestScore = Infinity;

    for (let i = 0; i < offsets.length; i++) {
      const off = offsets[i];
      const az = tagAngle + off;
      // Slight preference for the ~0.78 rad (45°) 3/4 angle when clear of trees & buildings
      const penalty =
        Math.abs(Math.abs(off) - 0.78) * 1.2 +
        (i % 2) * 0.02 +
        this.scoreAzimuthObstruction(tree, az, distance, polar);

      if (penalty < bestScore) {
        bestScore = penalty;
        bestAz = az;
      }
    }

    return bestAz;
  }

  private computeFocusPoseForTree(
    tree: TreeRuntime,
    tool: ToolId
  ): { target: THREE.Vector3; distance: number; polar: number; azimuth?: number } | null {
    const tx = tree.spec.x;
    const tz = tree.spec.z;
    const h = tree.currentHeight;

    if (tool === 'prune') {
      const targetBranches = tree.branches.filter((b) => b.isTarget && !b.pruned);
      let sumX = 0;
      let sumZ = 0;
      let sumY = 0;
      for (const b of targetBranches) {
        sumX += b.worldDirection.x;
        sumZ += b.worldDirection.z;
        sumY += b.attachLocalPos.y;
      }

      const distance = Math.max(13.0, Math.min(38, h * 1.24));
      const polar = 1.28;
      const avgTagY = targetBranches.length > 0 ? sumY / targetBranches.length : h * 0.44;
      const focusY = THREE.MathUtils.clamp(
        avgTagY * 0.6 + h * 0.44 * 0.4,
        Math.max(1.8, h * 0.25),
        h * 0.62
      );

      let azimuth: number | undefined;
      if (Math.hypot(sumX, sumZ) > 0.15) {
        azimuth = this.pickClearPruneAzimuth(tree, Math.atan2(sumZ, sumX), distance, polar);
      } else if (tree.spec.hazardBranchAngle !== undefined) {
        azimuth = this.pickClearPruneAzimuth(tree, tree.spec.hazardBranchAngle, distance, polar);
      }

      return {
        target: new THREE.Vector3(tx, focusY, tz),
        distance,
        polar,
        azimuth,
      };
    } else if (tool === 'fell') {
      if (tree.stage === 'standing') {
        // High bird's-eye slanted view so player clearly sees tree + drop zone + hazards!
        const aimAngle = tree.spec.dropZone ? tree.spec.dropZone.angle : tree.aimAngle;
        const fx = tx + Math.cos(aimAngle) * h * 0.22;
        const fz = tz + Math.sin(aimAngle) * h * 0.22;
        const dist = Math.max(24, h * 1.45);
        const polar = 0.96;
        const azA = aimAngle + Math.PI * 0.72;
        const azB = aimAngle - Math.PI * 0.72;
        const bestAz =
          this.scoreAzimuthObstruction(tree, azB, dist, polar, fx, fz) + 0.5 <
          this.scoreAzimuthObstruction(tree, azA, dist, polar, fx, fz)
            ? azB
            : azA;
        return {
          target: new THREE.Vector3(fx, h * 0.3, fz),
          distance: dist,
          polar,
          azimuth: bestAz,
        };
      } else if (tree.stage === 'aimed') {
        // Focus nicely on the face-notch side of the trunk
        return {
          target: new THREE.Vector3(tx, tree.cutHeight + 0.55, tz),
          distance: Math.max(8.5, tree.baseRadius * 16),
          polar: 1.25,
          azimuth: tree.aimAngle + 0.55,
        };
      } else if (tree.stage === 'notched' || tree.stage === 'hinge_ready') {
        // Pivot cleanly to see the back-cut side AND down the drop direction
        return {
          target: new THREE.Vector3(tx, tree.cutHeight + 0.6, tz),
          distance: Math.max(9.2, tree.baseRadius * 17),
          polar: 1.22,
          azimuth: tree.aimAngle + Math.PI - 0.58,
        };
      }
    } else if (tool === 'wedge') {
      return {
        target: new THREE.Vector3(tx, tree.cutHeight + 0.5, tz),
        distance: Math.max(8.5, tree.baseRadius * 15),
        polar: 1.24,
        azimuth: tree.aimAngle + Math.PI - 0.45,
      };
    } else if (tool === 'buck') {
      const topCut = this.getNextStandingTopCut(tree);
      if (topCut) {
        // Frame the active standing top-down ring AND the Prime Landing / shed shadow below!
        const aimAngle = tree.spec.dropZone ? tree.spec.dropZone.angle : tree.aimAngle;
        return {
          target: new THREE.Vector3(
            tx + Math.cos(aimAngle) * h * 0.14,
            Math.max(h * 0.42, tree.cutHeight + topCut.localY * 0.72),
            tz + Math.sin(aimAngle) * h * 0.14
          ),
          distance: Math.max(25, h * 1.32),
          polar: 1.02,
          azimuth: aimAngle + Math.PI * 0.72,
        };
      } else {
        const midDist = h * 0.36;
        return {
          target: new THREE.Vector3(
            tx + Math.cos(tree.actualFallDirection) * midDist,
            1.2,
            tz + Math.sin(tree.actualFallDirection) * midDist
          ),
          distance: Math.max(15, h * 0.85),
          polar: 0.95,
        };
      }
    }

    return null;
  }

  private focusCameraForCurrentState(immediate: boolean): void {
    const tree = this.getActiveTree();
    if (!tree) return;

    const pose = this.computeFocusPoseForTree(tree, this.activeTool);
    if (pose) {
      this.cameraCtrl.focusOn(pose.target, pose.distance, pose.polar, pose.azimuth);
    }

    if (immediate) this.cameraCtrl.applyImmediate();
  }

  private playContractIntro(): void {
    const firstTree = this.trees[0];
    if (!firstTree) return;

    const rawEnd = this.computeFocusPoseForTree(firstTree, this.activeTool);
    const endAzimuth =
      rawEnd?.azimuth ??
      firstTree.spec.hazardBranchAngle ??
      (firstTree.spec.dropZone ? firstTree.spec.dropZone.angle + Math.PI * 0.72 : 0.72);
    const endPose: CameraKeyframe = {
      target: rawEnd?.target ?? new THREE.Vector3(firstTree.spec.x, firstTree.currentHeight * 0.44, firstTree.spec.z),
      distance: rawEnd?.distance ?? Math.max(19.5, firstTree.currentHeight * 1.24),
      polar: rawEnd?.polar ?? 1.16,
      azimuth: endAzimuth,
    };

    // Compute work-site overview center across all contract trees & nearby landmarks
    const treeCentroid = new THREE.Vector3();
    let maxH = 0;
    for (const t of this.trees) {
      treeCentroid.x += t.spec.x;
      treeCentroid.y += t.currentHeight * 0.38;
      treeCentroid.z += t.spec.z;
      maxH = Math.max(maxH, t.currentHeight);
    }
    treeCentroid.divideScalar(this.trees.length);

    const siteCenter = treeCentroid.clone();
    const hazards = this.currentContract?.hazards ?? [];
    if (hazards.length > 0) {
      let hx = 0;
      let hz = 0;
      for (const hzItem of hazards) {
        hx += hzItem.x;
        hz += hzItem.z;
      }
      siteCenter.x = THREE.MathUtils.lerp(treeCentroid.x, hx / hazards.length, 0.22);
      siteCenter.z = THREE.MathUtils.lerp(treeCentroid.z, hz / hazards.length, 0.22);
    }

    let maxSpread = 0;
    for (const t of this.trees) {
      const d = Math.hypot(t.spec.x - siteCenter.x, t.spec.z - siteCenter.z);
      maxSpread = Math.max(maxSpread, d);
    }

    const keyframes: CameraKeyframe[] = [];
    let duration = 2.7;

    if (this.trees.length === 1) {
      const startDist = THREE.MathUtils.clamp(
        Math.max(endPose.distance * 1.65, maxH * 1.85 + 7),
        24,
        54
      );
      const startTarget = endPose.target.clone().lerp(siteCenter, 0.45);
      startTarget.y = Math.max(endPose.target.y + 1.8, maxH * 0.44);

      const k0: CameraKeyframe = {
        target: startTarget,
        distance: startDist,
        polar: 0.78,
        azimuth: endPose.azimuth - 1.15,
      };
      const k1: CameraKeyframe = {
        target: k0.target.clone().lerp(endPose.target, 0.62),
        distance: THREE.MathUtils.lerp(k0.distance, endPose.distance, 0.55),
        polar: THREE.MathUtils.lerp(k0.polar, endPose.polar, 0.52),
        azimuth: endPose.azimuth - 0.48,
      };
      keyframes.push(k0, k1, endPose);
      duration = 2.7;
    } else {
      // Sweep from wide site overview -> secondary involved trees -> smoothly land on Tree #1
      const secondaryTrees = this.trees.slice(1).reverse();
      const totalSweep = Math.min(1.85, 1.15 + secondaryTrees.length * 0.3);
      const startDist = THREE.MathUtils.clamp(
        Math.max(30, maxSpread * 2.05 + maxH * 1.1),
        30,
        56
      );

      keyframes.push({
        target: new THREE.Vector3(siteCenter.x, Math.max(5.5, maxH * 0.38), siteCenter.z),
        distance: startDist,
        polar: 0.73,
        azimuth: endPose.azimuth - totalSweep,
      });

      secondaryTrees.forEach((st, idx) => {
        const frac = (idx + 1) / (secondaryTrees.length + 1);
        keyframes.push({
          target: new THREE.Vector3(st.spec.x, Math.max(2.6, st.currentHeight * 0.44), st.spec.z),
          distance: THREE.MathUtils.clamp(st.currentHeight * 1.35, 16, 34),
          polar: THREE.MathUtils.lerp(0.96, 1.1, frac),
          azimuth: endPose.azimuth - totalSweep * (1 - frac),
        });
      });

      keyframes.push(endPose);
      duration = Math.min(4.2, 2.7 + secondaryTrees.length * 0.75);
    }

    this.cameraCtrl.playIntro(keyframes, duration, () => {
      this.emitHUD();
    });
  }

  private skipIntroToFocus(): void {
    if (!this.cameraCtrl.isIntroPlaying()) return;
    this.cameraCtrl.cancelIntro(true);
  }

  private buildDropZoneVisual(dz: NonNullable<TreeRuntime['spec']['dropZone']>): THREE.Group {
    const g = new THREE.Group();
    g.position.set(dz.x, 0.05, dz.z);
    g.rotation.y = -dz.angle;

    // Translucent emerald landing corridor mat
    const stripGeo = new THREE.PlaneGeometry(dz.length, dz.width);
    stripGeo.rotateX(-Math.PI / 2);
    const stripMat = new THREE.MeshBasicMaterial({
      color: '#10b981',
      transparent: true,
      opacity: 0.22,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const strip = new THREE.Mesh(stripGeo, stripMat);
    g.add(strip);

    // Crisp dashed-feel glowing border rails
    const borderMat = new THREE.MeshBasicMaterial({
      color: '#34d399',
      transparent: true,
      opacity: 0.75,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    for (const side of [-1, 1]) {
      const rail = new THREE.Mesh(new THREE.PlaneGeometry(dz.length, 0.16), borderMat);
      rail.rotation.x = -Math.PI / 2;
      rail.position.set(0, 0.02, side * (dz.width / 2));
      g.add(rail);
    }
    for (const end of [-1, 1]) {
      const cap = new THREE.Mesh(new THREE.PlaneGeometry(0.16, dz.width), borderMat);
      cap.rotation.x = -Math.PI / 2;
      cap.position.set(end * (dz.length / 2), 0.02, 0);
      g.add(cap);
    }

    // 4 Corner Forestry Stakes with green surveyor flags
    const stakeMat = new THREE.MeshStandardMaterial({
      color: '#d4d4d8',
      roughness: 0.7,
      transparent: true,
      opacity: 1,
    });
    const flagMat = new THREE.MeshBasicMaterial({
      color: '#10b981',
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 1,
    });
    for (const sx of [-dz.length / 2, dz.length / 2]) {
      for (const sz of [-dz.width / 2, dz.width / 2]) {
        const stake = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.15, 6), stakeMat);
        stake.position.set(sx, 0.55, sz);
        g.add(stake);
        const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.36, 0.24), flagMat);
        flag.position.set(sx + 0.18, 0.98, sz);
        g.add(flag);
      }
    }

    g.userData = {
      fade: 1,
      materials: [
        { mat: stripMat, baseOpacity: 0.22 },
        { mat: borderMat, baseOpacity: 0.75 },
        { mat: stakeMat, baseOpacity: 1.0 },
        { mat: flagMat, baseOpacity: 1.0 },
      ],
    };

    return g;
  }

  private bindInputEvents(): void {
    this.cameraCtrl.setMultiTouchBeginListener(() => {
      if (this.isLeftDown) {
        this.isLeftDown = false;
        this.handlePrimaryUp();
      }
    });

    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    });

    this.canvas.addEventListener('pointermove', (e) => {
      this.updatePointerCoords(e);
      if (
        this.screen === 'playing' &&
        !this.cameraCtrl.isUserOrbiting() &&
        !this.cameraCtrl.isIntroPlaying()
      ) {
        this.handlePointerHover();
      }
    });

    this.canvas.addEventListener('pointerdown', (e) => {
      if (this.screen !== 'playing') return;
      if (e.pointerType === 'touch' && this.cameraCtrl.getActiveTouchCount() >= 2) return;
      if (e.button !== 0 || e.shiftKey) return;
      this.audio.init();
      this.updatePointerCoords(e);
      if (this.cameraCtrl.isIntroPlaying()) {
        this.skipIntroToFocus();
        return;
      }
      this.isLeftDown = true;
      this.handlePrimaryDown();
    });

    window.addEventListener('pointerup', (e) => {
      if (e.button !== 0) return;
      if (this.isLeftDown) {
        this.isLeftDown = false;
        this.handlePrimaryUp();
      }
    });

    // Optional keyboard shortcuts for power users (never required!)
    window.addEventListener('keydown', (e) => {
      if (this.screen !== 'playing') return;
      if (
        this.cameraCtrl.isIntroPlaying() &&
        (e.key === 'Escape' || e.key === ' ' || e.key === 'Enter')
      ) {
        e.preventDefault();
        this.skipIntroToFocus();
        return;
      }
      if (e.key === '1') this.setTool('prune');
      else if (e.key === '2') this.setTool('fell');
      else if (e.key === '3') this.setTool('wedge');
      else if (e.key === '4') this.setTool('buck');
      else if (e.key === 'q' || e.key === 'Q') this.orbitCameraStep(-1);
      else if (e.key === 'e' || e.key === 'E') this.orbitCameraStep(1);
      else if (e.key === 'Escape' && this.getActiveTree()?.stage === 'aimed') this.resetAim();
    });
  }

  private updatePointerCoords(e: PointerEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    this.pointerScreen.x = e.clientX;
    this.pointerScreen.y = e.clientY;
    this.pointerNDC.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointerNDC.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  }

  private getObstructingLimbsForRing(tree: TreeRuntime, ring: BuckRingData): BranchData[] {
    return tree.branches.filter((b) => {
      if (b.pruned) return false;
      // Keep lower bare butt-log cut snappy; require limbing overhanging crown boughs further up
      const reach = b.groundLimbOnly ? 3.2 : ring.distanceAlongTrunk < 5.0 ? 1.15 : 1.85;
      return Math.abs(b.attachLocalPos.y - ring.distanceAlongTrunk) < reach;
    });
  }

  private getFallenObstructingLimbs(tree: TreeRuntime): BranchData[] {
    if (tree.stage !== 'fallen') return [];
    const seen = new Set<string>();
    const out: BranchData[] = [];
    for (const r of tree.buckRings) {
      if (r.cutDone) continue;
      for (const b of this.getObstructingLimbsForRing(tree, r)) {
        if (!seen.has(b.id)) {
          seen.add(b.id);
          out.push(b);
        }
      }
    }
    return out;
  }

  private handlePointerHover(): void {
    const activeTree = this.getActiveTree();
    this.raycaster.setFromCamera(this.pointerNDC, this.camera);

    // 1. Prune Mode Hover: raycast standing prunable limbs AND fallen tree limbs
    if (this.activeTool === 'prune') {
      const colliders: THREE.Object3D[] = [];
      for (const t of this.trees) {
        if (t.stage === 'falling' || t.stage === 'bucked') continue;
        // Click & hover right through foreground trees that are ghosted out of the way
        if (t.spec.id !== this.activeTreeId && t.occlusionFade < 0.55) continue;
        const isFallen = t.stage === 'fallen';
        for (const b of t.branches) {
          if (b.pruned) continue;
          if (!isFallen && b.groundLimbOnly) continue;
          colliders.push(b.colliderMesh);
        }
      }
      const hits = this.raycaster.intersectObjects(colliders, false);
      if (hits.length > 0) {
        const { treeId, branchId } = hits[0].object.userData;
        const tree = this.trees.find((t) => t.spec.id === treeId);
        const branch = tree?.branches.find((b) => b.id === branchId) ?? null;
        this.hoveredBranch = branch;
        this.canvas.style.cursor = 'crosshair';
      } else {
        this.hoveredBranch = null;
        this.canvas.style.cursor = '';
      }
      return;
    }

    this.hoveredBranch = null;
    this.hoveredTopCut = null;

    // 1b. Standing Top-Down Piecing Ring Hover (works with EITHER Chainsaw #2 or Limb & Buck #4!)
    if (this.activeTool === 'fell' || this.activeTool === 'buck') {
      const topHit = this.findStandingTopCutUnderRay(2.6);
      if (topHit) {
        this.hoveredTopCut = topHit;
        this.hoveredBuckRing = null;
        this.canvas.style.cursor = 'crosshair';
        return;
      }
    }

    // 2. Fell Mode Aiming: project cursor onto ground plane around active tree
    if (this.activeTool === 'fell' && activeTree && activeTree.stage === 'standing') {
      const hitPt = new THREE.Vector3();
      if (this.raycaster.ray.intersectPlane(this.groundPlane, hitPt)) {
        const dx = hitPt.x - activeTree.spec.x;
        const dz = hitPt.z - activeTree.spec.z;
        if (Math.hypot(dx, dz) > 0.6) {
          activeTree.aimAngle = Math.atan2(dz, dx);
        }
      }
      this.canvas.style.cursor = 'crosshair';
      return;
    }

    // 3. Limb & Buck Mode Hover: raycast clear golden buck rings AND fallen limbs covering the trunk
    if (this.activeTool === 'buck') {
      const clearRings: THREE.Object3D[] = [];
      const fallenBranchColliders: THREE.Object3D[] = [];
      for (const t of this.trees) {
        if (t.stage !== 'fallen') continue;
        for (const r of t.buckRings) {
          if (!r.cutDone && this.getObstructingLimbsForRing(t, r).length === 0) {
            clearRings.push(r.ringMesh);
          }
        }
        for (const b of t.branches) {
          if (!b.pruned) fallenBranchColliders.push(b.colliderMesh);
        }
      }

      const ringHits = this.raycaster.intersectObjects(clearRings, false);
      if (ringHits.length > 0) {
        const { treeId, buckId } = ringHits[0].object.userData;
        const tree = this.trees.find((t) => t.spec.id === treeId);
        const ring = tree?.buckRings.find((r) => r.id === buckId);
        this.hoveredBuckRing = tree && ring ? { tree, ring } : null;
        this.hoveredBranch = null;
        this.canvas.style.cursor = 'crosshair';
        return;
      }

      const branchHits = this.raycaster.intersectObjects(fallenBranchColliders, false);
      if (branchHits.length > 0) {
        const { treeId, branchId } = branchHits[0].object.userData;
        const tree = this.trees.find((t) => t.spec.id === treeId);
        const branch = tree?.branches.find((b) => b.id === branchId) ?? null;
        this.hoveredBranch = branch;
        this.hoveredBuckRing = null;
        this.canvas.style.cursor = 'crosshair';
        return;
      }

      this.hoveredBuckRing = null;
      this.hoveredBranch = null;
      this.canvas.style.cursor = '';
      return;
    }

    this.hoveredBuckRing = null;
    this.canvas.style.cursor =
      this.activeTool === 'fell' || this.activeTool === 'wedge' ? 'pointer' : '';
  }

  private handlePrimaryDown(): void {
    this.raycaster.setFromCamera(this.pointerNDC, this.camera);
    const activeTree = this.getActiveTree();

    // Check if user clicked a DIFFERENT tree trunk to switch focus (when not aiming/cutting active tree)
    const trunkMeshes = this.trees
      .filter((t) => t.spec.id === this.activeTreeId || t.occlusionFade >= 0.55)
      .flatMap((t) => t.segments.map((s) => s.barkMesh));
    const trunkHits = this.raycaster.intersectObjects(trunkMeshes, false);

    // 1. PRUNE TOOL
    if (this.activeTool === 'prune') {
      if (this.hoveredBranch && !this.hoveredBranch.pruned) {
        this.cuttingBranch = this.hoveredBranch;
        if (this.hoveredBranch.treeId !== this.activeTreeId) {
          this.activeTreeId = this.hoveredBranch.treeId;
          this.focusCameraForCurrentState(false);
          this.emitHUD();
        }
        this.audio.setSawActive('prune', 1.0);
        return;
      }
      // Clicking another tree's trunk selects it
      if (trunkHits.length > 0) {
        const clickedId = trunkHits[0].object.userData.treeId as string;
        if (clickedId && clickedId !== this.activeTreeId) {
          this.selectTree(clickedId);
          return;
        }
      }
      return;
    }

    // 2. FELL TOOL
    if (this.activeTool === 'fell') {
      if (!activeTree) return;

      // Standing top-down piecing ring takes priority over locking aim or base cut!
      const topHit = this.hoveredTopCut ?? this.findStandingTopCutUnderRay(2.8);
      if (topHit && !topHit.cut.cutDone) {
        this.cuttingTopCut = topHit;
        if (topHit.tree.spec.id !== this.activeTreeId) {
          this.activeTreeId = topHit.tree.spec.id;
          this.focusCameraForCurrentState(false);
          this.emitHUD();
        }
        this.audio.setSawActive('chainsaw', 1.12, topHit.tree.speciesSpec.woodDensity);
        return;
      }

      // Allow switching to another standing tree if clicked directly while current tree is standing or already fallen
      if (trunkHits.length > 0) {
        const clickedId = trunkHits[0].object.userData.treeId as string;
        const clickedTree = this.trees.find((t) => t.spec.id === clickedId);
        if (clickedTree && clickedId !== this.activeTreeId && clickedTree.stage !== 'fallen' && clickedTree.stage !== 'bucked') {
          this.selectTree(clickedId);
          return;
        }
      }

      if (activeTree.spec.task === 'prune_only') {
        this.showToast('This tree is protected—prune hazard branches only!', 'warn');
        this.audio.playWarningBuzz();
        return;
      }

      if (activeTree.stage === 'standing') {
        // Lock the aimed felling direction!
        activeTree.stage = 'aimed';
        this.positionTrunkCutsForAim(activeTree);
        this.audio.playClick();
        this.focusCameraForCurrentState(false);
        this.showToast('Felling angle locked! Hold Left-Click to saw the Face Notch.', 'info');
        this.emitHUD();
        return;
      }

      if (activeTree.stage === 'aimed') {
        // Start sawing the Face Notch!
        this.cuttingTrunkStage = 'notch';
        this.audio.setSawActive('chainsaw', 1.0, activeTree.speciesSpec.woodDensity);
        return;
      }

      if (activeTree.stage === 'notched' || activeTree.stage === 'hinge_ready') {
        // Start sawing the Back Cut!
        this.cuttingTrunkStage = 'backcut';
        this.audio.setSawActive('chainsaw', 1.15, activeTree.speciesSpec.woodDensity);
        return;
      }
      return;
    }

    // 3. FELLING WEDGE TOOL
    if (this.activeTool === 'wedge') {
      if (!activeTree) return;
      if (activeTree.stage !== 'notched' && activeTree.stage !== 'hinge_ready') {
        this.showToast('Cut the Face Notch and Back Cut before driving wedges!', 'warn');
        this.audio.playWarningBuzz();
        return;
      }
      if (activeTree.backCutDepth < 0.35) {
        this.showToast('Saw deeper into the Back Cut first so a wedge can fit!', 'warn');
        this.audio.playWarningBuzz();
        return;
      }
      this.driveWedge(activeTree);
      return;
    }

    // 4. LIMB & BUCK TOOL
    if (this.activeTool === 'buck') {
      // Standing top-down piecing ring!
      const topHit = this.hoveredTopCut ?? this.findStandingTopCutUnderRay(2.8);
      if (topHit && !topHit.cut.cutDone) {
        this.cuttingTopCut = topHit;
        if (topHit.tree.spec.id !== this.activeTreeId) {
          this.activeTreeId = topHit.tree.spec.id;
          this.focusCameraForCurrentState(false);
          this.emitHUD();
        }
        this.audio.setSawActive('electric_buck', 1.12);
        return;
      }
      // Directly hovered clear sawlog ring
      if (this.hoveredBuckRing && !this.hoveredBuckRing.ring.cutDone) {
        this.cuttingBuck = this.hoveredBuckRing;
        if (this.hoveredBuckRing.tree.spec.id !== this.activeTreeId) {
          this.activeTreeId = this.hoveredBuckRing.tree.spec.id;
          this.focusCameraForCurrentState(false);
          this.emitHUD();
        }
        this.audio.setSawActive('electric_buck', 1.1);
        return;
      }
      // Directly hovered fallen branch/crown bough -> zip it off to limb the log!
      if (this.hoveredBranch && !this.hoveredBranch.pruned) {
        const branchTree = this.trees.find((t) => t.spec.id === this.hoveredBranch?.treeId);
        if (branchTree?.stage === 'fallen') {
          this.cuttingBranch = this.hoveredBranch;
          if (branchTree.spec.id !== this.activeTreeId) {
            this.activeTreeId = branchTree.spec.id;
            this.focusCameraForCurrentState(false);
            this.emitHUD();
          }
          this.audio.setSawActive('electric_buck', 1.15);
          return;
        }
      }
      // Forgiving proximity check near any uncut bucking ring:
      // if clear -> buck it; if buried under crown limbs -> auto-limb the nearest covering bough!
      for (const t of this.trees) {
        if (t.stage !== 'fallen') continue;
        for (const r of t.buckRings) {
          if (r.cutDone) continue;
          const worldP = new THREE.Vector3();
          r.ringMesh.getWorldPosition(worldP);
          const distToRay = this.raycaster.ray.distanceToPoint(worldP);
          if (distToRay < 1.5) {
            const blockers = this.getObstructingLimbsForRing(t, r);
            if (blockers.length === 0) {
              this.cuttingBuck = { tree: t, ring: r };
              this.audio.setSawActive('electric_buck', 1.1);
            } else {
              this.cuttingBranch = blockers[0];
              this.activeTreeId = t.spec.id;
              this.audio.setSawActive('electric_buck', 1.15);
            }
            return;
          }
        }
      }
      // Clicking a standing tree switches focus so players can continue multi-tree jobs seamlessly
      if (trunkHits.length > 0) {
        const clickedId = trunkHits[0].object.userData.treeId as string;
        if (clickedId && clickedId !== this.activeTreeId) {
          this.selectTree(clickedId);
          return;
        }
      }
    }
  }

  private handlePrimaryUp(): void {
    this.audio.setSawActive('none');
    const activeTree = this.getActiveTree();

    if (this.cuttingTrunkStage === 'notch' && activeTree && activeTree.stage === 'aimed') {
      if (activeTree.notchDepth >= 0.2) {
        // Evaluate notch quality (sweet spot 0.25..0.37)
        const distFromIdeal = Math.abs(activeTree.notchDepth - 0.31);
        activeTree.notchQuality = Math.max(0.25, 1 - distFromIdeal * 4.0);
        activeTree.stage = 'notched';
        if (activeTree.notchQuality > 0.78) {
          this.showToast('Textbook Face Notch! Now cut the Back Cut on the far side.', 'good');
          this.audio.playSuccessChime();
        } else {
          this.showToast('Face Notch complete. Proceed to the Back Cut!', 'info');
        }
        this.focusCameraForCurrentState(false);
        this.emitHUD();
      } else {
        this.showToast('Notch too shallow—hold Left-Click longer to reach 25–35%!', 'warn');
      }
    }

    this.cuttingBranch = null;
    this.cuttingBuck = null;
    this.cuttingTopCut = null;
    this.cuttingTrunkStage = 'none';
    if (this.cursorProgressCb) {
      this.cursorProgressCb(false, 0, 0, 0, '', '');
    }
  }

  private placeWedgeAtDist(tree: TreeRuntime, wedgeIdx: number, distAlongAim: number): void {
    const wm = tree.wedgeMeshes[wedgeIdx];
    if (!wm) return;
    const yBack = tree.cutTopY + 0.07;
    const rotY = -tree.aimAngle;
    const cosR = Math.cos(rotY);
    const sinR = Math.sin(rotY);
    const zOff = (wedgeIdx - 1) * tree.cutRadius * 0.52;
    wm.position.set(
      tree.cutCenterXZ.x + distAlongAim * cosR + zOff * sinR,
      yBack,
      tree.cutCenterXZ.y - distAlongAim * sinR + zOff * cosR
    );
    wm.rotation.set(0, rotY, 0.05);
  }

  private getWedgeRange(tree: TreeRuntime, wedgeIdx: number): { startDist: number; endDist: number } {
    const wm = tree.wedgeMeshes[wedgeIdx];
    const wedgeLen = (wm?.userData?.wedgeLen as number | undefined) ?? Math.max(0.48, tree.baseRadius * 1.12);
    return {
      startDist: -(tree.cutRadius + wedgeLen * 0.56),
      endDist: -(tree.cutRadius - wedgeLen * 0.16),
    };
  }

  private positionTrunkCutsForAim(tree: TreeRuntime): void {
    for (let w = 0; w < tree.wedgeMeshes.length; w++) {
      const { startDist, endDist } = this.getWedgeRange(tree, w);
      this.placeWedgeAtDist(tree, w, w < tree.wedgesDriven ? endDist : startDist);
    }
    syncTrunkCutVisuals(tree);
  }

  private fireWedgeHammerBlow(tree: TreeRuntime, blowIdx: number): void {
    this.audio.playWedgeStrike(blowIdx);
    this.cameraCtrl.triggerShake(0.08 + blowIdx * 0.04);

    // Spawn crisp chips at back cut on each axe-head blow
    const worldBack = new THREE.Vector3(
      tree.spec.x - Math.cos(tree.aimAngle) * tree.baseRadius,
      tree.cutHeight + tree.cutTopY + 0.07,
      tree.spec.z - Math.sin(tree.aimAngle) * tree.baseRadius
    );
    this.particles.spawnSawdust(
      worldBack,
      new THREE.Vector3(-Math.cos(tree.aimAngle), 0.45, -Math.sin(tree.aimAngle)),
      tree.speciesSpec.sapwoodColor,
      6 + blowIdx * 3
    );
  }

  private driveWedge(tree: TreeRuntime): void {
    if (this.activeWedgeAnim) return;
    if (tree.wedgesDriven >= 3) {
      this.showToast('Max wedges driven! Finish the back cut carefully to tip it.', 'info');
      return;
    }

    const idx = tree.wedgesDriven;
    const { startDist, endDist } = this.getWedgeRange(tree, idx);
    const wMesh = tree.wedgeMeshes[idx];
    if (wMesh) {
      wMesh.visible = true;
      this.placeWedgeAtDist(tree, idx, startDist);
      const mat = wMesh.material as THREE.MeshStandardMaterial;
      mat.opacity = 0.72;
      mat.emissive.set('#ff6a00');
      mat.emissiveIntensity = 1.5;
    }

    this.activeWedgeAnim = {
      tree,
      wedgeIndex: idx,
      elapsed: 0,
      blowsFired: 1,
      startDist,
      endDist,
      currentProgress: 0,
      targetProgress: 0.34,
      flashIntensity: 1.0,
    };

    // First axe blow fires immediately on click/tap ("tok!")
    this.fireWedgeHammerBlow(tree, 0);
  }

  private updateWedgeAnimation(dt: number): void {
    const anim = this.activeWedgeAnim;
    if (!anim) return;

    const { tree, wedgeIndex } = anim;
    if (tree.stage === 'falling' || tree.stage === 'fallen' || tree.stage === 'bucked') {
      this.activeWedgeAnim = null;
      return;
    }

    anim.elapsed += dt;

    // 3-blow cadence: 0.00s ("tok"), 0.25s ("tok"), 0.50s ("TOK!")
    if (anim.blowsFired === 1 && anim.elapsed >= 0.25) {
      anim.blowsFired = 2;
      anim.targetProgress = 0.7;
      anim.flashIntensity = 1.0;
      this.fireWedgeHammerBlow(tree, 1);
    } else if (anim.blowsFired === 2 && anim.elapsed >= 0.5) {
      anim.blowsFired = 3;
      anim.targetProgress = 1.0;
      anim.flashIntensity = 1.15;
      this.fireWedgeHammerBlow(tree, 2);
    }

    // Snappy hammered insertion motion on each blow
    const snapLerp = Math.min(1, dt * 22);
    anim.currentProgress += (anim.targetProgress - anim.currentProgress) * snapLerp;
    anim.flashIntensity = Math.max(0, anim.flashIntensity - dt * 3.4);

    const dist = THREE.MathUtils.lerp(anim.startDist, anim.endDist, anim.currentProgress);
    this.placeWedgeAtDist(tree, wedgeIndex, dist);

    const wMesh = tree.wedgeMeshes[wedgeIndex];
    if (wMesh) {
      wMesh.visible = true;
      const mat = wMesh.material as THREE.MeshStandardMaterial;
      // Ghostly glowing orange during insertion, solidifying into seated forestry orange
      mat.opacity = THREE.MathUtils.lerp(0.68, 0.96, anim.currentProgress);
      mat.emissive.set('#ff6a00');
      mat.emissiveIntensity = 0.45 + anim.flashIntensity * 1.35;
    }

    // Complete sequence shortly after the 3rd blow drives the wedge home
    if (anim.elapsed >= 0.72) {
      this.placeWedgeAtDist(tree, wedgeIndex, anim.endDist);
      if (wMesh) {
        const mat = wMesh.material as THREE.MeshStandardMaterial;
        mat.opacity = 1.0;
        mat.emissiveIntensity = 0.2;
      }

      tree.wedgesDriven = Math.min(3, tree.wedgesDriven + 1);
      this.activeWedgeAnim = null;

      // Check if wedge lift now overcomes back-lean!
      if (tree.backCutDepth >= 0.72) {
        const pull = this.computeForwardPull(tree);
        if (pull >= -0.05) {
          this.showToast('Wedge lifted the trunk over center — TIMBER!!', 'good');
          this.initiateTreeFall(tree, false);
          return;
        } else {
          this.showToast(`Wedge #${tree.wedgesDriven} driven! Tap another wedge to lift it further.`, 'info');
        }
      } else {
        this.showToast(`Wedge #${tree.wedgesDriven} set! Now continue the Back Cut to 82%.`, 'info');
      }

      this.emitHUD();
    }
  }

  private computeForwardPull(tree: TreeRuntime): number {
    const aimX = Math.cos(tree.aimAngle);
    const aimZ = Math.sin(tree.aimAngle);

    const windSpeed = this.currentContract?.windSpeed ?? 0;
    const windAngle = this.currentContract?.windAngle ?? 0;
    const windFactor = windSpeed * 0.34;
    const totalX = tree.currentLeanVec.x + Math.cos(windAngle) * windFactor;
    const totalZ = tree.currentLeanVec.y + Math.sin(windAngle) * windFactor;

    const dotForward = totalX * aimX + totalZ * aimZ;
    const wedgeLift = tree.wedgesDriven * 0.34;
    return dotForward + wedgeLift;
  }

  private initiateTreeFall(tree: TreeRuntime, severedHinge: boolean): void {
    if (tree.stage === 'falling' || tree.stage === 'fallen' || tree.stage === 'bucked') return;

    this.cuttingTrunkStage = 'none';
    this.isLeftDown = false;
    this.audio.setSawActive('none');
    this.audio.playTimberCreak();

    tree.stage = 'falling';
    tree.fallAngle = 0.02;
    tree.fallVelocity = 0.14;
    // Hide standing-cut guide geometry so the felled butt & stump reveal clean growth-ring end-grain
    tree.notchCutoutGroup.visible = false;
    tree.backCutGroup.visible = false;
    tree.cutShaderUniforms.uFaceEnabled.value = 0;
    tree.cutShaderUniforms.uBackEnabled.value = 0;
    for (const wm of tree.wedgeMeshes) wm.visible = false;

    const windSpeed = this.currentContract?.windSpeed ?? 0;
    const windAngle = this.currentContract?.windAngle ?? 0;

    if (severedHinge) {
      // Hinge severed! Loss of directional control—tree falls toward natural lean + wind!
      tree.hingeIntegrity = 0;
      const fx = tree.currentLeanVec.x + Math.cos(windAngle) * windSpeed * 0.45;
      const fz = tree.currentLeanVec.y + Math.sin(windAngle) * windSpeed * 0.45;
      if (Math.hypot(fx, fz) > 0.06) {
        tree.actualFallDirection = Math.atan2(fz, fx);
      } else {
        tree.actualFallDirection = tree.aimAngle + (Math.random() > 0.5 ? 0.55 : -0.55);
      }
      this.showToast('HINGE SEVERED! Tree is twisting toward its natural lean!', 'danger');
      this.audio.playWarningBuzz();
    } else {
      // Clean hinge guides tree accurately along aimAngle, with tiny realistic wind/notch variance
      const notchErr = (1 - tree.notchQuality) * 0.18;
      const crossWind =
        Math.sin(windAngle - tree.aimAngle) * windSpeed * 0.16 * (1 - tree.notchQuality * 0.5);
      const crossLean =
        (tree.currentLeanVec.x * -Math.sin(tree.aimAngle) +
          tree.currentLeanVec.y * Math.cos(tree.aimAngle)) *
        (0.14 + notchErr);
      tree.actualFallDirection = tree.aimAngle + crossWind + crossLean;
      tree.hingeIntegrity = Math.max(0.65, 1 - Math.abs(tree.backCutDepth - 0.84) * 2.5);
      this.showToast('TIMBER!! Watch her come down!', 'good');
    }

    // Cinematic camera pull-back so player enjoys watching the giant tree crash!
    const fallH = tree.currentHeight;
    const tx = tree.spec.x + Math.cos(tree.actualFallDirection) * fallH * 0.35;
    const tz = tree.spec.z + Math.sin(tree.actualFallDirection) * fallH * 0.35;
    this.cameraCtrl.focusOn(
      new THREE.Vector3(tx, fallH * 0.22, tz),
      Math.max(25, fallH * 1.38),
      1.05,
      tree.actualFallDirection + Math.PI * 0.52
    );

    this.emitHUD();
  }

  private evaluateFallOutcome(tree: TreeRuntime): void {
    const contract = this.currentContract;
    if (!contract) return;

    const dx = Math.cos(tree.actualFallDirection);
    const dz = Math.sin(tree.actualFallDirection);
    const h = tree.currentHeight;
    const hasTopCrown = tree.topCutsCompleted === 0;

    // 1. Check hazard collisions along the entire fallen trunk + crown footprint!
    const hitHazards: string[] = [];
    for (const haz of contract.hazards) {
      let hit = false;
      for (let s = 2; s <= 12; s++) {
        const dist = (s / 12) * h;
        const px = tree.spec.x + dx * dist;
        const pz = tree.spec.z + dz * dist;
        // Wider canopy radius near upper half of tree (narrower once pieced down to a spar!)
        const treeWidthAtS = s > 6 ? (hasTopCrown ? 2.1 : 1.05) : 0.85;
        if (Math.hypot(px - haz.x, pz - haz.z) < haz.radius + treeWidthAtS * 0.55) {
          hit = true;
          break;
        }
      }
      if (hit) {
        hitHazards.push(haz.label);
      }
    }
    tree.hitHazards = hitHazards;

    // 2. Check Drop Zone accuracy
    if (tree.spec.dropZone) {
      const dzSpec = tree.spec.dropZone;
      const midX = tree.spec.x + dx * (h * 0.52);
      const midZ = tree.spec.z + dz * (h * 0.52);

      // Transform midpoint into drop zone local space
      const relX = midX - dzSpec.x;
      const relZ = midZ - dzSpec.z;
      const cosA = Math.cos(-dzSpec.angle);
      const sinA = Math.sin(-dzSpec.angle);
      const localX = relX * cosA - relZ * sinA;
      const localZ = relX * sinA + relZ * cosA;

      const angleDiff = Math.abs(
        Math.atan2(
          Math.sin(tree.actualFallDirection - dzSpec.angle),
          Math.cos(tree.actualFallDirection - dzSpec.angle)
        )
      );

      tree.landedInDropZone =
        Math.abs(localX) < dzSpec.length * 0.52 &&
        Math.abs(localZ) < dzSpec.width * 0.62 &&
        angleDiff < 0.45;
    } else {
      tree.landedInDropZone = hitHazards.length === 0;
    }

    // Show bucking rings on fallen trunk!
    for (const r of tree.buckRings) {
      r.ringMesh.visible = true;
    }

    if (hitHazards.length > 0) {
      this.showToast(`Impact! Damaged: ${hitHazards.join(', ')}`, 'danger');
      this.audio.playWarningBuzz();
    } else if (tree.landedInDropZone) {
      this.showToast('Bullseye Drop! Right in the landing corridor!', 'good');
      this.audio.playSuccessChime();
    } else {
      this.showToast('Safe drop—zero property damage, slightly off target corridor.', 'info');
    }

    // If bucking is required on this tree, prompt & enable bucking
    if (tree.spec.requireBucking && contract.unlockedTools.includes('buck')) {
      this.activeTool = 'buck';
      this.focusCameraForCurrentState(false);
    } else {
      tree.completed = true;
      this.checkContractCompletion();
      this.focusNextIncompleteTree(tree.spec.id);
    }
    this.emitHUD();
  }

  private checkIfAimHitsHazard(tree: TreeRuntime, angle: number): boolean {
    const contract = this.currentContract;
    if (!contract) return false;
    const dx = Math.cos(angle);
    const dz = Math.sin(angle);
    const h = tree.currentHeight;
    const hasTopCrown = tree.topCutsCompleted === 0;
    for (const haz of contract.hazards) {
      for (let s = 2; s <= 12; s++) {
        const dist = (s / 12) * h;
        const px = tree.spec.x + dx * dist;
        const pz = tree.spec.z + dz * dist;
        const w = s > 6 ? (hasTopCrown ? 1.85 : 0.95) : 0.75;
        if (Math.hypot(px - haz.x, pz - haz.z) < haz.radius + w * 0.55) {
          return true;
        }
      }
    }
    return false;
  }

  private checkIfAimInDropZone(tree: TreeRuntime, angle: number): boolean {
    if (!tree.spec.dropZone) return true;
    const dzSpec = tree.spec.dropZone;
    const midX = tree.spec.x + Math.cos(angle) * (tree.currentHeight * 0.52);
    const midZ = tree.spec.z + Math.sin(angle) * (tree.currentHeight * 0.52);
    const relX = midX - dzSpec.x;
    const relZ = midZ - dzSpec.z;
    const cosA = Math.cos(-dzSpec.angle);
    const sinA = Math.sin(-dzSpec.angle);
    const localX = relX * cosA - relZ * sinA;
    const localZ = relX * sinA + relZ * cosA;
    const angleDiff = Math.abs(Math.atan2(Math.sin(angle - dzSpec.angle), Math.cos(angle - dzSpec.angle)));
    return (
      Math.abs(localX) < dzSpec.length * 0.48 &&
      Math.abs(localZ) < dzSpec.width * 0.55 &&
      angleDiff < 0.38
    );
  }

  private checkContractCompletion(): void {
    if (!this.currentContract || this.contractFinished) return;

    const allDone = this.trees.every((t) => {
      if (t.spec.task === 'prune_only') {
        return t.prunedTargetCount >= t.spec.hazardBranches;
      }
      if (t.spec.task === 'fell') {
        if (t.spec.requireBucking) return t.stage === 'bucked';
        return t.stage === 'fallen' || t.stage === 'bucked';
      }
      // prune_and_fell
      const fellDone = t.spec.requireBucking ? t.stage === 'bucked' : t.stage === 'fallen' || t.stage === 'bucked';
      return fellDone;
    });

    if (allDone) {
      this.contractFinished = true;
      this.completionDelay = 1.65;
    }
  }

  private finalizeContractDebrief(): void {
    const contract = this.currentContract;
    if (!contract) return;

    let accuracyPoints = 100;
    let safetyBonus = 150;
    let timberValue = 0;
    const penalties: string[] = [];
    const highlights: string[] = [];
    let anyHazardHit = false;

    for (const t of this.trees) {
      // Pruning evaluation
      if (t.spec.hazardBranches > 0) {
        if (t.prunedTargetCount >= t.spec.hazardBranches) {
          highlights.push(`Cleared all ${t.spec.hazardBranches} hazard limbs on ${t.speciesSpec.name}`);
        } else {
          const missed = t.spec.hazardBranches - t.prunedTargetCount;
          accuracyPoints -= missed * 12;
          penalties.push(`Left ${missed} hazard branch(es) unpruned on ${t.speciesSpec.name}`);
        }
      }
      if (t.prunedHealthyPenaltyCount > 0) {
        accuracyPoints -= t.prunedHealthyPenaltyCount * 10;
        safetyBonus = Math.max(0, safetyBonus - t.prunedHealthyPenaltyCount * 35);
        penalties.push(`Cut ${t.prunedHealthyPenaltyCount} healthy structural branch(es)`);
      }

      // Felling evaluation
      if (t.spec.task !== 'prune_only') {
        if (t.hitHazards.length > 0) {
          anyHazardHit = true;
          accuracyPoints -= 40;
          safetyBonus = 0;
          penalties.push(`${t.speciesSpec.name} struck: ${t.hitHazards.join(', ')}`);
        } else if (t.landedInDropZone) {
          highlights.push(`Pinpoint drop into ${t.spec.dropZone?.label ?? 'Drop Zone'} (${t.speciesSpec.name})`);
        } else {
          accuracyPoints -= 18;
          penalties.push(`${t.speciesSpec.name} landed outside preferred corridor`);
        }

        if (t.hingeIntegrity > 0.75) {
          highlights.push(`Clean hinge control on ${t.speciesSpec.name}`);
        } else if (t.hingeIntegrity === 0) {
          accuracyPoints -= 15;
          penalties.push(`Severed holding hinge on ${t.speciesSpec.name}`);
        }

        if (t.standingTopCuts.length > 0 && t.topCutsCompleted >= t.standingTopCuts.length && t.hitHazards.length === 0) {
          highlights.push(`Pieced down ${t.speciesSpec.name} spar cleanly to fit landing pocket`);
        }

        const logValue = Math.round(
          t.spec.height * t.speciesSpec.timberValuePerMeter * (0.55 + (t.buckedCount / Math.max(1, t.totalBuckCuts)) * 0.45) +
            t.limbedCount * 12
        );
        if (t.limbedCount > 0 && t.buckedCount > 0) {
          highlights.push(`Limbed & bucked clean ${t.speciesSpec.name} sawlogs`);
        }
        timberValue += logValue;
      }
    }

    accuracyPoints = Math.max(0, Math.min(100, Math.round(accuracyPoints)));
    const success = !anyHazardHit || accuracyPoints >= 45;
    let stars = 1;
    if (!anyHazardHit && accuracyPoints >= 85) stars = 3;
    else if (!anyHazardHit && accuracyPoints >= 65) stars = 2;
    else if (anyHazardHit) stars = 1;

    const totalEarned = Math.max(
      100,
      Math.round(contract.basePayout * (accuracyPoints / 100) + safetyBonus + timberValue * 0.25)
    );

    if (!contract.isSandbox) {
      const prev = this.completedContracts[contract.id];
      if (!prev || stars > prev.stars || accuracyPoints > prev.score) {
        this.completedContracts[contract.id] = {
          stars: Math.max(stars, prev?.stars ?? 0),
          score: Math.max(accuracyPoints, prev?.score ?? 0),
          earnings: Math.max(totalEarned, prev?.earnings ?? 0),
        };
      }
      this.totalEarnings += totalEarned;
      this.saveProgress();
    }

    const idx = CAMPAIGN_CONTRACTS.findIndex((c) => c.id === contract.id);
    this.debriefData = {
      success,
      stars,
      accuracyScore: accuracyPoints,
      safetyBonus,
      timberValue,
      totalEarned,
      penalties,
      highlights,
      hasNextContract: !contract.isSandbox && idx >= 0 && idx + 1 < CAMPAIGN_CONTRACTS.length,
    };

    this.screen = 'debrief';
    if (stars >= 2) this.audio.playSuccessChime();
    this.emitHUD();
  }

  private showToast(text: string, tone: 'info' | 'good' | 'warn' | 'danger'): void {
    this.toastCounter++;
    this.currentToast = { text: localizeControlCopy(text), tone, id: this.toastCounter };
    this.toastExpireAt = this.elapsed + 3.8;
    this.emitHUD();
  }

  private updateCutting(dt: number): void {
    const activeTree = this.getActiveTree();

    // 1. Active Branch Pruning (standing) OR Ground Limbing (fallen!)
    if (this.cuttingBranch && this.isLeftDown && (this.activeTool === 'prune' || this.activeTool === 'buck')) {
      const b = this.cuttingBranch;
      const tree = this.trees.find((t) => t.spec.id === b.treeId);
      if (!tree || b.pruned) {
        this.cuttingBranch = null;
        this.audio.setSawActive('none');
        return;
      }

      const isGroundLimbing = tree.stage === 'fallen';
      const cutRate = isGroundLimbing
        ? 2.85 / tree.speciesSpec.woodDensity
        : 0.95 / (tree.speciesSpec.woodDensity * (0.7 + b.radius * 2.2));
      b.cutProgress = Math.min(1, b.cutProgress + cutRate * dt);
      this.audio.setSawActive(
        isGroundLimbing ? 'electric_buck' : 'prune',
        (isGroundLimbing ? 1.05 : 0.8) + b.cutProgress * 0.55
      );

      // Sawdust spray right at branch collar!
      if (Math.random() < 0.65) {
        const collarPos = new THREE.Vector3();
        b.collarRing.getWorldPosition(collarPos);
        this.particles.spawnSawdust(
          collarPos,
          isGroundLimbing
            ? new THREE.Vector3(0, 1.0, 0)
            : b.worldDirection.clone().add(new THREE.Vector3(0, 0.3, 0)),
          tree.speciesSpec.sapwoodColor,
          2
        );
      }

      if (this.cursorProgressCb) {
        this.cursorProgressCb(
          true,
          this.pointerScreen.x,
          this.pointerScreen.y,
          b.cutProgress,
          isGroundLimbing
            ? 'Limbing Fallen Bough...'
            : b.isTarget
              ? 'Pruning Hazard Limb'
              : 'Caution: Healthy Limb!',
          isGroundLimbing || b.isTarget ? 'good' : 'warn'
        );
      }

      if (b.cutProgress >= 1) {
        const previouslyBlocked = isGroundLimbing
          ? tree.buckRings.filter((r) => !r.cutDone && this.getObstructingLimbsForRing(tree, r).length > 0).length
          : 0;

        b.pruned = true;
        b.collarRing.visible = false;
        b.colliderMesh.visible = false;
        this.audio.setSawActive('none');
        this.audio.playBranchSnap();

        this.particles.dissolveLimb(
          b.meshGroup,
          tree.speciesSpec.foliageColors,
          tree.speciesSpec.sapwoodColor
        );

        if (isGroundLimbing) {
          tree.limbedCount++;
          const nowBlocked = tree.buckRings.filter(
            (r) => !r.cutDone && this.getObstructingLimbsForRing(tree, r).length > 0
          ).length;
          if (nowBlocked < previouslyBlocked) {
            if (nowBlocked === 0) {
              this.showToast('Crown limbed clean! All sawlog cuts are now clear to buck.', 'good');
              this.audio.playSuccessChime();
            } else {
              this.showToast('Sawlog cut uncovered! Slice the golden ring.', 'good');
            }
          }
        } else {
          recomputeTreeLean(tree);

          if (b.isTarget) {
            tree.prunedTargetCount++;
            const remaining = Math.max(0, tree.spec.hazardBranches - tree.prunedTargetCount);
            if (remaining === 0) {
              if (tree.spec.task === 'prune_only') {
                tree.completed = true;
                this.showToast(`${tree.speciesSpec.name} crown cleanly pruned!`, 'good');
                this.audio.playSuccessChime();
                this.checkContractCompletion();
                this.focusNextIncompleteTree(tree.spec.id);
              } else {
                this.showToast('Hazard limbs cleared & lean reduced! Switch to Chainsaw to fell.', 'good');
                this.audio.playSuccessChime();
                if (this.currentContract?.unlockedTools.includes('fell')) {
                  this.activeTool = 'fell';
                  this.focusCameraForCurrentState(false);
                }
              }
            } else {
              this.showToast(`Clean collar cut! ${remaining} hazard limb(s) left on this tree.`, 'good');
            }
          } else {
            tree.prunedHealthyPenaltyCount++;
            this.showToast('Oops — that was a healthy structural branch! Stick to amber-flagged limbs.', 'warn');
            this.audio.playWarningBuzz();
          }
        }

        this.cuttingBranch = null;
        if (this.cursorProgressCb) this.cursorProgressCb(false, 0, 0, 0, '', '');
        // Continuous hold-and-sweep limbing on fallen trunks!
        if (isGroundLimbing && this.isLeftDown && this.activeTool === 'buck') {
          this.handlePointerHover();
          if (this.hoveredBranch && !this.hoveredBranch.pruned) {
            const nextTree = this.trees.find((t) => t.spec.id === this.hoveredBranch?.treeId);
            if (nextTree?.stage === 'fallen') {
              this.cuttingBranch = this.hoveredBranch;
              this.audio.setSawActive('electric_buck', 1.15);
            }
          }
        }
        this.emitHUD();
      }
      return;
    }

    // 2. Active Chainsaw Face Notch / Back Cut
    if (this.cuttingTrunkStage !== 'none' && this.isLeftDown && activeTree) {
      const density = activeTree.speciesSpec.woodDensity;
      const radiusFactor = 0.72 + activeTree.baseRadius * 0.85;

      if (this.cuttingTrunkStage === 'notch' && activeTree.stage === 'aimed') {
        const rate = 0.24 / (density * radiusFactor);
        activeTree.notchDepth = Math.min(0.52, activeTree.notchDepth + rate * dt);
        activeTree.notchCutoutGroup.visible = true;
        syncTrunkCutVisuals(activeTree);

        this.audio.setSawActive('chainsaw', 0.85 + activeTree.notchDepth * 1.1, density);

        if (Math.random() < 0.75) {
          const p = new THREE.Vector3(
            activeTree.spec.x + activeTree.cutCenterXZ.x + Math.cos(activeTree.aimAngle) * activeTree.cutRadius * 0.92,
            activeTree.cutHeight + activeTree.cutTopY - 0.12,
            activeTree.spec.z + activeTree.cutCenterXZ.y + Math.sin(activeTree.aimAngle) * activeTree.cutRadius * 0.92
          );
          this.particles.spawnSawdust(
            p,
            new THREE.Vector3(Math.cos(activeTree.aimAngle), 0.35, Math.sin(activeTree.aimAngle)),
            activeTree.speciesSpec.heartwoodColor,
            3
          );
        }

        if (this.cursorProgressCb) {
          const inSweet = activeTree.notchDepth >= 0.24 && activeTree.notchDepth <= 0.38;
          this.cursorProgressCb(
            true,
            this.pointerScreen.x,
            this.pointerScreen.y,
            activeTree.notchDepth / 0.52,
            inSweet ? 'Release Now! (Sweet Spot)' : activeTree.notchDepth > 0.38 ? 'Too Deep!' : 'Cutting Face Notch...',
            inSweet ? 'good' : activeTree.notchDepth > 0.38 ? 'danger' : 'info'
          );
        }
      } else if (
        this.cuttingTrunkStage === 'backcut' &&
        (activeTree.stage === 'notched' || activeTree.stage === 'hinge_ready')
      ) {
        const rate = 0.36 / (density * radiusFactor);
        activeTree.backCutDepth = Math.min(1.0, activeTree.backCutDepth + rate * dt);
        activeTree.backCutGroup.visible = true;
        syncTrunkCutVisuals(activeTree);

        this.audio.setSawActive('chainsaw', 1.05 + activeTree.backCutDepth * 0.6, density);

        if (Math.random() < 0.75) {
          const p = new THREE.Vector3(
            activeTree.spec.x + activeTree.cutCenterXZ.x - Math.cos(activeTree.aimAngle) * activeTree.cutRadius * 0.95,
            activeTree.cutHeight + activeTree.cutTopY + 0.07,
            activeTree.spec.z + activeTree.cutCenterXZ.y - Math.sin(activeTree.aimAngle) * activeTree.cutRadius * 0.95
          );
          this.particles.spawnSawdust(
            p,
            new THREE.Vector3(-Math.cos(activeTree.aimAngle), 0.3, -Math.sin(activeTree.aimAngle)),
            activeTree.speciesSpec.sapwoodColor,
            3
          );
        }

        const forwardPull = this.computeForwardPull(activeTree);
        const hasWedge = this.currentContract?.unlockedTools.includes('wedge') ?? false;
        const tipThreshold = hasWedge ? -0.05 : -0.15;

        if (this.cursorProgressCb) {
          const needsAssist = forwardPull < tipThreshold;
          const label =
            activeTree.backCutDepth > 0.9
              ? 'DANGER: Severing Hinge!'
              : needsAssist && activeTree.backCutDepth > 0.74
                ? hasWedge
                  ? 'Back-Leaning! Use Wedge!'
                  : 'Back-Leaning! Prune Limbs First!'
                : 'Cutting Back Hinge...';
          this.cursorProgressCb(
            true,
            this.pointerScreen.x,
            this.pointerScreen.y,
            activeTree.backCutDepth,
            label,
            activeTree.backCutDepth > 0.9 ? 'danger' : needsAssist && activeTree.backCutDepth > 0.74 ? 'warn' : 'good'
          );
        }

        // Tip threshold around 0.82 (10-15% holding hinge remaining!)
        if (activeTree.backCutDepth >= 0.82 && activeTree.backCutDepth < 0.94) {
          if (forwardPull >= tipThreshold) {
            this.initiateTreeFall(activeTree, false);
            if (this.cursorProgressCb) this.cursorProgressCb(false, 0, 0, 0, '', '');
            return;
          } else if (activeTree.stage !== 'hinge_ready') {
            activeTree.stage = 'hinge_ready';
            activeTree.backCutDepth = 0.83;
            this.cuttingTrunkStage = 'none';
            this.isLeftDown = false;
            this.audio.setSawActive('none');
            if (this.cursorProgressCb) this.cursorProgressCb(false, 0, 0, 0, '', '');
            if (hasWedge) {
              this.showToast('Tree sits back on the saw! Switch to Felling Wedge & tap to tip it forward!', 'warn');
            } else {
              this.showToast('Tree leans back! Prune back-side limbs first, or hold Left-Click to push through.', 'warn');
            }
            this.emitHUD();
            return;
          }
        }

        // Severed hinge if player forces past 94%!
        if (activeTree.backCutDepth >= 0.94) {
          this.initiateTreeFall(activeTree, true);
          if (this.cursorProgressCb) this.cursorProgressCb(false, 0, 0, 0, '', '');
          return;
        }
      }
      return;
    }

    // 2b. Active Standing Top-Down Piecing Cut (works with Chainsaw #2 or Limb & Buck #4)
    if (
      this.cuttingTopCut &&
      this.isLeftDown &&
      (this.activeTool === 'fell' || this.activeTool === 'buck')
    ) {
      const { tree, cut } = this.cuttingTopCut;
      const rate = 0.92 / tree.speciesSpec.woodDensity;
      cut.cutProgress = Math.min(1, cut.cutProgress + rate * dt);
      this.audio.setSawActive(
        this.activeTool === 'fell' ? 'chainsaw' : 'electric_buck',
        1.15,
        tree.speciesSpec.woodDensity
      );

      const cutWorldPos = new THREE.Vector3();
      cut.ringMesh.getWorldPosition(cutWorldPos);
      if (Math.random() < 0.72) {
        this.particles.spawnSawdust(
          cutWorldPos,
          new THREE.Vector3(0, 0.8, 0),
          tree.speciesSpec.heartwoodColor,
          3
        );
      }

      if (this.cursorProgressCb) {
        this.cursorProgressCb(
          true,
          this.pointerScreen.x,
          this.pointerScreen.y,
          cut.cutProgress,
          `Piecing Down (${tree.topCutsCompleted + 1}/${tree.standingTopCuts.length})...`,
          'good'
        );
      }

      if (cut.cutProgress >= 1) {
        cut.cutDone = true;
        cut.ringMesh.visible = false;
        cut.colliderMesh.visible = false;
        tree.topCutsCompleted++;
        this.audio.setSawActive('none');
        this.audio.playBranchSnap();
        this.cameraCtrl.triggerShake(0.16);

        // Reveal clean growth-ring end-grain top cap on the shortened spar!
        const newTopSeg = tree.segments[cut.startSegmentIndex - 1];
        if (newTopSeg) newTopSeg.topCap.visible = true;

        // Collect all upper trunk segments detached by this top cut
        const detachedGroups: THREE.Object3D[] = [];
        const detachedSegSet = new Set<THREE.Object3D>();
        for (let s = cut.startSegmentIndex; s < tree.segments.length; s++) {
          const seg = tree.segments[s];
          if (seg.detached) continue;
          seg.detached = true;
          seg.bottomCap.visible = true;
          detachedGroups.push(seg.group);
          detachedSegSet.add(seg.group);
        }

        // Mark any branches/crown boughs parented onto the removed upper sections as pruned
        for (const b of tree.branches) {
          if (b.pruned) continue;
          if (b.meshGroup.parent && detachedSegSet.has(b.meshGroup.parent)) {
            b.pruned = true;
            b.collarRing.visible = false;
            b.colliderMesh.visible = false;
            if (b.isTarget) tree.prunedTargetCount++;
          }
        }

        // Tip the severed top round slightly into the clear pocket (away from the shed) & dissolve into chips!
        const dropAngle = tree.spec.dropZone ? tree.spec.dropZone.angle : tree.aimAngle;
        const tipAngle = dropAngle - 0.35;
        const tipDir = new THREE.Vector3(Math.cos(tipAngle), 0, Math.sin(tipAngle));
        this.particles.spawnSawdust(
          cutWorldPos,
          new THREE.Vector3(0, 1.3, 0),
          tree.speciesSpec.heartwoodColor,
          16
        );
        this.particles.addFallingTopSection(
          detachedGroups,
          cutWorldPos,
          tipDir,
          tree.speciesSpec.foliageColors,
          tree.speciesSpec.sapwoodColor
        );

        // Shorten effective spar height -> aim shadow & hazard checks shrink immediately!
        tree.currentHeight = cut.remainingHeight;
        recomputeTreeLean(tree);

        const remainingRounds = tree.standingTopCuts.length - tree.topCutsCompleted;
        if (remainingRounds > 0) {
          this.showToast(
            `Topped to ${Math.round(tree.currentHeight)}m — ${remainingRounds} round left to clear the shed!`,
            'info'
          );
        } else {
          this.showToast(
            `Spar pieced down to ${Math.round(tree.currentHeight)}m — aim shadow fits ${tree.spec.dropZone?.label ?? 'drop zone'}!`,
            'good'
          );
          this.audio.playSuccessChime();
          if (this.activeTool === 'buck') {
            this.activeTool = 'fell';
            this.focusCameraForCurrentState(false);
          }
        }

        this.cuttingTopCut = null;
        if (this.cursorProgressCb) this.cursorProgressCb(false, 0, 0, 0, '', '');
        this.emitHUD();
      }
      return;
    }

    // 3. Active Bucking Cut on Fallen Log
    if (this.cuttingBuck && this.isLeftDown && this.activeTool === 'buck') {
      const { tree, ring } = this.cuttingBuck;
      const rate = 1.15 / tree.speciesSpec.woodDensity;
      ring.cutProgress = Math.min(1, ring.cutProgress + rate * dt);
      this.audio.setSawActive('electric_buck', 1.15);

      if (Math.random() < 0.7) {
        const wp = new THREE.Vector3();
        ring.ringMesh.getWorldPosition(wp);
        this.particles.spawnSawdust(wp, new THREE.Vector3(0, 1, 0), tree.speciesSpec.heartwoodColor, 3);
      }

      if (this.cursorProgressCb) {
        this.cursorProgressCb(
          true,
          this.pointerScreen.x,
          this.pointerScreen.y,
          ring.cutProgress,
          'Bucking Sawlog...',
          'good'
        );
      }

      if (ring.cutProgress >= 1) {
        ring.cutDone = true;
        // Remove the guide ring completely — the stem now physically splits into real sawlogs!
        ring.ringMesh.visible = false;
        tree.buckedCount++;
        this.audio.setSawActive('none');
        this.audio.playBranchSnap();
        this.cameraCtrl.triggerShake(0.11);

        // Reveal fresh growth-ring end-grain caps on BOTH newly sliced log faces
        const cutIdx = tree.buckRings.indexOf(ring);
        if (cutIdx >= 0) {
          if (tree.segments[cutIdx]) tree.segments[cutIdx].topCap.visible = true;
          if (tree.segments[cutIdx + 1]) tree.segments[cutIdx + 1].bottomCap.visible = true;
        }

        const cutWorldPos = new THREE.Vector3();
        ring.ringMesh.getWorldPosition(cutWorldPos);
        this.particles.spawnSawdust(cutWorldPos, new THREE.Vector3(0, 1.1, 0), tree.speciesSpec.heartwoodColor, 14);

        // Physically detach & roll any sawlog segment whose both ends are now free!
        const axialDir = new THREE.Vector3(
          Math.cos(tree.actualFallDirection),
          0,
          Math.sin(tree.actualFallDirection)
        );
        let detachedAny = false;
        for (let s = 0; s < tree.segments.length; s++) {
          const seg = tree.segments[s];
          if (seg.detached) continue;
          const bottomFree = s === 0 || Boolean(tree.buckRings[s - 1]?.cutDone);
          const topFree =
            s === tree.segments.length - 1 ||
            Boolean(tree.segments[s + 1]?.detached) ||
            Boolean(tree.buckRings[s]?.cutDone);
          if (bottomFree && topFree) {
            seg.detached = true;
            detachedAny = true;
            const isCrownTip = s === tree.segments.length - 1;
            const axialKick = s <= cutIdx ? -0.72 : 0.72;
            this.particles.addBuckedLogSegment(seg.group, axialDir, seg.avgRadius, axialKick, isCrownTip);
          }
        }

        // If a middle cut was made first (neither neighbor segment is fully free yet),
        // nudge the upper half slightly forward along the stem so a crisp kerf split & end-grain open up!
        if (!detachedAny && cutIdx >= 0) {
          const kerfGap = 0.09;
          for (let s = cutIdx + 1; s < tree.segments.length; s++) {
            if (!tree.segments[s].detached) {
              tree.segments[s].group.position.y += kerfGap;
            }
          }
          for (let r = cutIdx + 1; r < tree.buckRings.length; r++) {
            if (!tree.buckRings[r].cutDone) {
              tree.buckRings[r].ringMesh.position.y += kerfGap;
            }
          }
        }

        if (tree.buckedCount >= tree.totalBuckCuts) {
          tree.stage = 'bucked';
          tree.completed = true;
          this.showToast(`All ${tree.totalBuckCuts} prime sawlogs bucked! (+Timber Bonus)`, 'good');
          this.audio.playSuccessChime();
          this.checkContractCompletion();
          this.focusNextIncompleteTree(tree.spec.id);
        } else {
          this.showToast(`Sawlog sliced free (${tree.buckedCount}/${tree.totalBuckCuts})!`, 'good');
        }

        this.cuttingBuck = null;
        if (this.cursorProgressCb) this.cursorProgressCb(false, 0, 0, 0, '', '');
        this.emitHUD();
      }
    }
  }

  private updateFallingPhysics(dt: number): void {
    for (const tree of this.trees) {
      if (tree.stage !== 'falling') continue;

      const fallH = tree.currentHeight;
      // Realistic rotational gravity acceleration: alpha ~ g * sin(theta) / L
      const gravityTorque = (6.8 / Math.sqrt(fallH * 0.25)) * (0.28 + Math.sin(tree.fallAngle));
      tree.fallVelocity += gravityTorque * dt;
      tree.fallAngle += tree.fallVelocity * dt;

      // Ground impact at ~PI/2 (adjusted slightly for trunk base radius)
      const targetRestAngle = Math.PI / 2 - 0.02;
      if (tree.fallAngle >= targetRestAngle) {
        tree.fallAngle = targetRestAngle;
        tree.stage = 'fallen';
        this.applyTreeFallTransform(tree);

        // Epic earth-shaking thud, camera shake, dust & needle burst!
        const weightScale = fallH / 20;
        this.audio.playTimberCrash(weightScale);
        this.cameraCtrl.triggerShake(0.45 * weightScale);
        this.particles.spawnTimberImpact(
          new THREE.Vector3(tree.spec.x, 0, tree.spec.z),
          tree.actualFallDirection,
          fallH,
          tree.speciesSpec.foliageColors
        );
        this.evaluateFallOutcome(tree);
      } else {
        this.applyTreeFallTransform(tree);
      }
    }
  }

  private applyTreeFallTransform(tree: TreeRuntime): void {
    // Rotate trunkPivot so +Y tips directly toward (cos a, 0, sin a).
    // By right-hand rule, axis = (+Y) x (cos a, 0, sin a) = (sin a, 0, -cos a).
    const a = tree.actualFallDirection;
    const axis = new THREE.Vector3(Math.sin(a), 0, -Math.cos(a)).normalize();
    tree.trunkPivot.quaternion.setFromAxisAngle(axis, tree.fallAngle);
  }

  private updateVisualGuides(dt: number): void {
    const activeTree = this.getActiveTree();
    const windSpeed = this.currentContract?.windSpeed ?? 0.1;
    const windAngle = this.currentContract?.windAngle ?? 0;

    // Gentle living wind sway on standing trees & pulsing highlights!
    for (const tree of this.trees) {
      const isSelected = tree.spec.id === activeTree?.spec.id;
      tree.selectionRing.visible = this.screen === 'playing' && tree.stage !== 'fallen' && tree.stage !== 'bucked';
      if (tree.selectionRing.visible) {
        const sMat = tree.selectionRing.material as THREE.MeshBasicMaterial;
        sMat.color.set(tree.completed ? '#22c55e' : isSelected ? '#34d399' : '#94a3b8');
        sMat.opacity = (isSelected ? 0.65 + Math.sin(this.elapsed * 4) * 0.18 : 0.25) * tree.occlusionFade;
      }

      if (tree.stage !== 'falling' && tree.stage !== 'fallen' && tree.stage !== 'bucked') {
        const swayAmp = (0.005 + windSpeed * 0.022) * (tree.currentHeight / 20);
        const sway = Math.sin(this.elapsed * (1.4 + windSpeed * 2.2) + tree.spec.seed) * swayAmp;
        tree.trunkPivot.rotation.set(
          Math.sin(windAngle) * sway,
          0,
          -Math.cos(windAngle) * sway
        );

        // Sync ghostly glowing orange wedge preview when Wedge tool is poised at the back cut
        const showGhostWedge =
          this.screen === 'playing' &&
          isSelected &&
          this.activeTool === 'wedge' &&
          !this.activeWedgeAnim &&
          (tree.stage === 'notched' || tree.stage === 'hinge_ready') &&
          tree.backCutDepth >= 0.35;
        for (let w = 0; w < tree.wedgeMeshes.length; w++) {
          const isAnim =
            this.activeWedgeAnim?.tree.spec.id === tree.spec.id &&
            this.activeWedgeAnim.wedgeIndex === w;
          if (isAnim) continue;

          const wm = tree.wedgeMeshes[w];
          const wMat = wm.material as THREE.MeshStandardMaterial;
          if (w < tree.wedgesDriven) {
            wm.visible = true;
            wMat.opacity = 1.0;
            wMat.emissiveIntensity = 0.2;
          } else if (showGhostWedge && w === tree.wedgesDriven) {
            const { startDist } = this.getWedgeRange(tree, w);
            const breathe = Math.sin(this.elapsed * 5.0) * 0.045;
            this.placeWedgeAtDist(tree, w, startDist + breathe);
            wm.visible = true;
            wMat.opacity = 0.5 + Math.sin(this.elapsed * 5.0) * 0.16;
            wMat.emissive.set('#ff6a00');
            wMat.emissiveIntensity = 1.05 + Math.sin(this.elapsed * 5.0) * 0.35;
          } else {
            wm.visible = false;
          }
        }
      }

      // Branch collar ring visual feedback (standing pruning vs fallen ground limbing!)
      const isFallen = tree.stage === 'fallen';
      const obstructingSet = isFallen
        ? new Set(this.getFallenObstructingLimbs(tree).map((x) => x.id))
        : null;

      for (const b of tree.branches) {
        if (b.pruned) continue;
        const rMat = b.collarRing.material as THREE.MeshBasicMaterial;
        const isHov = this.hoveredBranch?.id === b.id || this.cuttingBranch?.id === b.id;

        if (isFallen) {
          // Hide collar rings on branches riding on already-detached rolled log segments
          const onDetachedLog = b.meshGroup.parent?.parent !== tree.trunkPivot;
          const blocksBuck = obstructingSet?.has(b.id) ?? false;
          if (!onDetachedLog && (this.activeTool === 'buck' || this.activeTool === 'prune')) {
            if (isHov) {
              rMat.color.set('#86efac');
              rMat.opacity = 0.98;
              rMat.depthTest = false;
              b.collarRing.renderOrder = 6;
              b.collarRing.scale.setScalar(1.25 + Math.sin(this.elapsed * 10) * 0.08);
            } else if (blocksBuck) {
              rMat.color.set('#22c55e');
              rMat.opacity = 0.7 + Math.sin(this.elapsed * 4.5) * 0.2;
              rMat.depthTest = false;
              b.collarRing.renderOrder = 5;
              b.collarRing.scale.setScalar(1.05);
            } else {
              rMat.color.set('#22c55e');
              rMat.opacity = 0.14;
              rMat.depthTest = true;
              b.collarRing.renderOrder = 0;
              b.collarRing.scale.setScalar(0.95);
            }
          } else {
            rMat.opacity = 0.0;
          }
        } else {
          rMat.depthTest = true;
          b.collarRing.renderOrder = 0;
          if (b.groundLimbOnly) {
            rMat.opacity = 0.0;
          } else if (this.cameraCtrl.isIntroPlaying() && b.isTarget) {
            rMat.color.set('#f59e0b');
            rMat.opacity = 0.62 + Math.sin(this.elapsed * 4.5) * 0.24;
            b.collarRing.scale.setScalar(1.06);
          } else if (this.activeTool === 'prune') {
            if (isHov) {
              rMat.color.set(b.isTarget ? '#fef08a' : '#f87171');
              rMat.opacity = 0.98;
              b.collarRing.scale.setScalar(1.18 + Math.sin(this.elapsed * 10) * 0.08);
            } else if (b.isTarget) {
              rMat.color.set('#f59e0b');
              rMat.opacity = 0.55 + Math.sin(this.elapsed * 3.5) * 0.2;
              b.collarRing.scale.setScalar(1.0);
            } else {
              rMat.opacity = 0.0;
            }
          } else {
            rMat.opacity = b.isTarget ? 0.2 : 0.0;
            b.collarRing.scale.setScalar(1.0);
          }
        }
        if (!isSelected && tree.occlusionFade < 0.995) {
          rMat.opacity *= tree.occlusionFade;
        }
      }

      // Bucking ring visual feedback (bright gold X-ray when clear so foliage/neighbors never hide it,
      // muted orange X-ray when still buried under crown limbs that need limbing!)
      for (const r of tree.buckRings) {
        if (!r.ringMesh.visible || r.cutDone) continue;
        const isHov = this.hoveredBuckRing?.ring.id === r.id || this.cuttingBuck?.ring.id === r.id;
        const blocked = isFallen && this.getObstructingLimbsForRing(tree, r).length > 0;
        const mat = r.ringMesh.material as THREE.MeshBasicMaterial;
        if (blocked) {
          mat.color.set('#fb923c');
          mat.opacity = 0.52 + Math.sin(this.elapsed * 3.5) * 0.16;
          mat.depthTest = false;
          r.ringMesh.renderOrder = 8;
          r.ringMesh.scale.setScalar(1.04);
        } else {
          mat.color.set(isHov ? '#ffffff' : '#facc15');
          mat.opacity = 0.96;
          mat.depthTest = false;
          r.ringMesh.renderOrder = 10;
          r.ringMesh.scale.setScalar(isHov ? 1.22 : 1.05 + Math.sin(this.elapsed * 4.5) * 0.06);
        }
      }

      // Standing top-down piecing ring (only the highest uncut ring glows while standing/aimed in Chainsaw or Buck mode!)
      const nextTopCut =
        this.screen === 'playing' && (this.activeTool === 'fell' || this.activeTool === 'buck')
          ? this.getNextStandingTopCut(tree)
          : null;
      for (const cut of tree.standingTopCuts) {
        const showRing = nextTopCut !== null && cut.id === nextTopCut.id;
        cut.ringMesh.visible = showRing;
        if (!showRing) continue;
        const isHov = this.hoveredTopCut?.cut.id === cut.id || this.cuttingTopCut?.cut.id === cut.id;
        const mat = cut.ringMesh.material as THREE.MeshBasicMaterial;
        mat.color.set(isHov ? '#ffffff' : '#facc15');
        mat.opacity = isHov ? 1.0 : 0.92;
        cut.ringMesh.scale.setScalar(isHov ? 1.24 : 1.06 + Math.sin(this.elapsed * 4.8) * 0.08);
      }
    }

    // Fade out & hide landing lane highlights/stakes once a tree is felled or completed
    for (const tree of this.trees) {
      if (!tree.dropZoneGroup) continue;
      const dzData = tree.dropZoneGroup.userData as {
        fade: number;
        materials: Array<{ mat: THREE.Material; baseOpacity: number }>;
      };
      if (!dzData?.materials) continue;

      const isDone = tree.completed || tree.stage === 'fallen' || tree.stage === 'bucked';
      const isActive = activeTree?.spec.id === tree.spec.id;
      const targetFade = isDone ? 0 : isActive ? 1 : 0.45;
      const fadeSpeed = isDone ? 1.8 : 4.2;
      dzData.fade += (targetFade - dzData.fade) * Math.min(1, fadeSpeed * dt);

      if (isDone && dzData.fade < 0.015) {
        dzData.fade = 0;
        tree.dropZoneGroup.visible = false;
      } else {
        tree.dropZoneGroup.visible = true;
        for (const entry of dzData.materials) {
          entry.mat.opacity = entry.baseOpacity * dzData.fade;
          if (entry.baseOpacity >= 0.99) {
            entry.mat.depthWrite = dzData.fade > 0.65;
          }
        }
      }
    }

    const introPlaying = this.cameraCtrl.isIntroPlaying();

    // Hazard perimeter warning rings glow brighter while aiming chainsaw
    if (this.env) {
      const aimingNow =
        this.screen === 'playing' &&
        !introPlaying &&
        this.activeTool === 'fell' &&
        activeTree?.stage === 'standing';
      for (const ring of this.env.hazardWarningRings) {
        const mat = ring.material as THREE.MeshBasicMaterial;
        mat.opacity = aimingNow ? 0.45 + Math.sin(this.elapsed * 4) * 0.14 : 0.16;
      }
    }

    // Directional Felling Sight Guide (also shown in Buck mode when standing top cuts remain so shrinking shadow is visible!)
    const showAimForTopCuts =
      this.activeTool === 'buck' &&
      activeTree !== null &&
      this.getNextStandingTopCut(activeTree) !== null;
    const showAim =
      this.screen === 'playing' &&
      !introPlaying &&
      activeTree !== null &&
      activeTree.spec.task !== 'prune_only' &&
      (this.activeTool === 'fell' || this.activeTool === 'wedge' || showAimForTopCuts) &&
      (activeTree.stage === 'standing' || activeTree.stage === 'aimed' || activeTree.stage === 'notched' || activeTree.stage === 'hinge_ready');

    this.aimGuideGroup.visible = showAim;
    if (showAim && activeTree) {
      this.aimGuideGroup.position.set(activeTree.spec.x, 0, activeTree.spec.z);
      this.aimGuideGroup.rotation.y = -activeTree.aimAngle;
      const len = activeTree.currentHeight;
      this.aimShadowMesh.scale.set(len, 1, 3.6);
      this.aimCenterLine.scale.set(len, 1, 1);
      this.aimArrowHead.position.x = len + 0.35;

      const hitsHazard = this.checkIfAimHitsHazard(activeTree, activeTree.aimAngle);
      const inZone = this.checkIfAimInDropZone(activeTree, activeTree.aimAngle);
      const sMat = this.aimShadowMesh.material as THREE.MeshBasicMaterial;
      const lMat = this.aimCenterLine.material as THREE.MeshBasicMaterial;
      const hMat = this.aimArrowHead.material as THREE.MeshBasicMaterial;

      if (hitsHazard) {
        sMat.color.set('#ef4444');
        lMat.color.set('#fca5a5');
        hMat.color.set('#ef4444');
      } else if (inZone) {
        sMat.color.set('#22c55e');
        lMat.color.set('#86efac');
        hMat.color.set('#4ade80');
      } else {
        sMat.color.set('#eab308');
        lMat.color.set('#fde047');
        hMat.color.set('#facc15');
      }
      sMat.opacity = activeTree.stage === 'standing' ? 0.38 : 0.2;
    }

    // Lean + Wind Vector Arrow at Tree Base
    const showLean =
      this.screen === 'playing' &&
      activeTree !== null &&
      activeTree.stage !== 'falling' &&
      activeTree.stage !== 'fallen' &&
      activeTree.stage !== 'bucked';

    if (showLean && activeTree) {
      const lx = activeTree.currentLeanVec.x + Math.cos(windAngle) * windSpeed * 0.34;
      const lz = activeTree.currentLeanVec.y + Math.sin(windAngle) * windSpeed * 0.34;
      const mag = Math.hypot(lx, lz);
      this.leanArrowGroup.visible = mag > 0.08;
      if (mag > 0.08) {
        const ang = Math.atan2(lz, lx);
        const arrowLen = Math.min(6.5, 1.4 + mag * 7.2);
        this.leanArrowGroup.position.set(activeTree.spec.x, 0.05, activeTree.spec.z);
        this.leanArrowGroup.rotation.y = -ang;
        this.leanShaft.scale.set(arrowLen, 1, 1);
        this.leanTip.position.x = arrowLen + 0.3;
      }
    } else {
      this.leanArrowGroup.visible = false;
    }

    // Glowing Trunk Cut Ring during aimed / notched / hinge_ready
    // Softens once a real cut is visible so it never obscures the carved Humboldt notch!
    const showTrunkRing =
      this.screen === 'playing' &&
      !introPlaying &&
      activeTree !== null &&
      (this.activeTool === 'fell' || this.activeTool === 'wedge') &&
      (activeTree.stage === 'aimed' || activeTree.stage === 'notched' || activeTree.stage === 'hinge_ready');

    this.trunkCutHighlight.visible = showTrunkRing;
    if (showTrunkRing && activeTree) {
      const ringY =
        activeTree.stage === 'aimed'
          ? activeTree.cutHeight + activeTree.cutTopY
          : activeTree.cutHeight + activeTree.cutTopY + 0.07;
      this.trunkCutHighlight.position.set(
        activeTree.spec.x + activeTree.cutCenterXZ.x,
        ringY,
        activeTree.spec.z + activeTree.cutCenterXZ.y
      );
      const pulse = 1.24 + Math.sin(this.elapsed * 5.5) * 0.05;
      this.trunkCutHighlight.scale.setScalar(activeTree.cutRadius * pulse);
      const mat = this.trunkCutHighlight.material as THREE.MeshBasicMaterial;
      const activelyCarved = activeTree.notchDepth > 0.04 || activeTree.backCutDepth > 0.04;
      mat.opacity = activelyCarved ? 0.24 : 0.78;
      mat.color.set(
        activeTree.stage === 'hinge_ready'
          ? '#f97316'
          : activeTree.stage === 'aimed'
            ? '#38bdf8'
            : '#fbbf24'
      );
    }
  }

  private buildHUDState(): GameHUDState {
    const tree = this.getActiveTree();
    const contract = this.currentContract;

    // Build dynamic one-line contextual mouse prompt
    let promptText = '';
    let subPromptText = cameraOrbitZoomHint();

    if (tree && contract) {
      if (this.cameraCtrl.isIntroPlaying()) {
        promptText = `Site Survey · ${contract.title}`;
        subPromptText = introSkipHint();
      } else if (this.activeTool === 'prune') {
        const rem = Math.max(0, tree.spec.hazardBranches - tree.prunedTargetCount);
        if (rem > 0) {
          promptText = `Hover an amber-flagged limb & hold Left-Click to prune (${rem} left)`;
        } else if (tree.spec.task === 'prune_and_fell') {
          promptText = 'All hazard limbs cleared! Select the Chainsaw to fell this tree.';
        } else {
          promptText = 'Tree cleanly pruned! Click another tree or inspect your work.';
        }
      } else if (this.activeTool === 'fell') {
        const nextTopCut = this.getNextStandingTopCut(tree);
        const remTops = tree.standingTopCuts.length - tree.topCutsCompleted;
        if (tree.spec.task === 'prune_only') {
          promptText = 'This tree is protected—switch to the Pruning Saw!';
        } else if (tree.stage === 'standing') {
          if (nextTopCut) {
            promptText = `Too tall (${Math.round(tree.currentHeight)}m) for ${tree.spec.dropZone?.label ?? 'pocket'} — hold Left-Click on the golden ring up the trunk to piece down (${remTops} left)!`;
            subPromptText = 'Works with Chainsaw or Limb & Buck · Aim shadow turns green when spar fits';
          } else {
            promptText = 'Move cursor to aim into the green Drop Zone, then Left-Click to lock';
          }
        } else if (tree.stage === 'aimed') {
          promptText = 'Hold Left-Click to saw the Face Notch — release in the green 30% zone!';
          subPromptText = 'Press Esc or click Re-Aim to change direction before cutting';
        } else if (tree.stage === 'notched') {
          promptText = 'Hold Left-Click to saw the Back Cut until the hinge releases (~82%)!';
        } else if (tree.stage === 'hinge_ready') {
          const hasWedge = contract.unlockedTools.includes('wedge');
          promptText = hasWedge
            ? 'Back-leaning! Select the Felling Wedge & click the trunk to tip it forward!'
            : 'Back-leaning! Prune opposite-side limbs with Prune Saw, or hold Left-Click to push through.';
        } else if (tree.stage === 'falling') {
          promptText = 'TIMBER!!';
        } else {
          promptText = 'Tree felled! Switch to Bucking Saw or select the next standing tree.';
        }
      } else if (this.activeTool === 'wedge') {
        if (tree.stage === 'hinge_ready' || tree.stage === 'notched') {
          promptText = 'Left-Click the trunk to drive Felling Wedges into the back cut!';
        } else {
          promptText = 'Cut the Face Notch and Back Cut with the Chainsaw first.';
        }
      } else if (this.activeTool === 'buck') {
        const nextTopCut = this.getNextStandingTopCut(tree);
        const remTops = tree.standingTopCuts.length - tree.topCutsCompleted;
        if (nextTopCut) {
          promptText = `Hold Left-Click on the golden ring up the trunk to piece down (${Math.round(tree.currentHeight)}m · ${remTops} round${remTops === 1 ? '' : 's'} left)!`;
          subPromptText = 'Shorten the spar until the red aim shadow clears the shed and turns green';
        } else if (tree.stage === 'fallen') {
          const blockers = this.getFallenObstructingLimbs(tree);
          if (blockers.length > 0) {
            promptText =
              'Hold Left-Click on green-ringed fallen boughs to limb the trunk, then slice the golden sawlog rings!';
            subPromptText = `${blockers.length} fallen crown limb(s) covering buried sawlog cuts · ${orbitOnlyHint()}`;
          } else {
            promptText = 'Hover a golden ring on the fallen trunk & hold Left-Click to buck sawlogs!';
          }
        } else {
          promptText = 'Fell a tree first before limbing & bucking logs.';
        }
      }
    }

    // Active Cutting Gauge
    const gauge: GameHUDState['gauge'] = {
      visible: false,
      label: '',
      value: 0,
      sweetMin: 0.25,
      sweetMax: 0.38,
      statusText: '',
      statusTone: 'neutral',
    };

    if (tree && (this.activeTool === 'fell' || this.activeTool === 'wedge')) {
      if (tree.stage === 'aimed') {
        gauge.visible = true;
        gauge.label = 'Face Notch Depth';
        gauge.value = Math.min(1, tree.notchDepth / 0.52);
        gauge.sweetMin = 0.24 / 0.52;
        gauge.sweetMax = 0.38 / 0.52;
        gauge.dangerMin = 0.42 / 0.52;
        const pct = Math.round(tree.notchDepth * 100);
        if (tree.notchDepth >= 0.24 && tree.notchDepth <= 0.38) {
          gauge.statusText = `${pct}% · Ideal Sweet Spot — Release!`;
          gauge.statusTone = 'good';
        } else if (tree.notchDepth > 0.38) {
          gauge.statusText = `${pct}% · Too Deep!`;
          gauge.statusTone = 'danger';
        } else {
          gauge.statusText = `${pct}% · Target 25–35%`;
          gauge.statusTone = 'neutral';
        }
      } else if (tree.stage === 'notched' || tree.stage === 'hinge_ready') {
        gauge.visible = true;
        gauge.label = 'Back Cut & Holding Hinge';
        gauge.value = tree.backCutDepth;
        gauge.sweetMin = 0.78;
        gauge.sweetMax = 0.90;
        gauge.dangerMin = 0.92;
        const pct = Math.round(tree.backCutDepth * 100);
        if (tree.stage === 'hinge_ready') {
          const hasWedge = contract?.unlockedTools.includes('wedge') ?? false;
          gauge.statusText = hasWedge ? `${pct}% · Pinched! Drive Wedges` : `${pct}% · Pinched! Prune Back-Lean`;
          gauge.statusTone = 'warn';
        } else if (tree.backCutDepth >= 0.91) {
          gauge.statusText = `${pct}% · DANGER: Severing Hinge!`;
          gauge.statusTone = 'danger';
        } else if (tree.backCutDepth >= 0.76) {
          gauge.statusText = `${pct}% · Crisp Holding Hinge`;
          gauge.statusTone = 'good';
        } else {
          gauge.statusText = `${pct}% · Stop near 82%`;
          gauge.statusTone = 'neutral';
        }
      }
    }

    // Lean / Center of Gravity Info
    const leanInfo: GameHUDState['leanInfo'] = {
      visible: false,
      leanMagnitude: 0,
      helpsAim: 0,
      needsWedge: false,
      wedgesDriven: 0,
    };

    if (tree && tree.stage !== 'fallen' && tree.stage !== 'bucked' && tree.stage !== 'falling') {
      const pull = this.computeForwardPull(tree);
      const hasWedge = contract?.unlockedTools.includes('wedge') ?? false;
      leanInfo.visible = true;
      leanInfo.leanMagnitude = Math.min(1, tree.currentLeanVec.length() * 1.8);
      leanInfo.helpsAim = Math.max(-1, Math.min(1, pull * 2.2));
      leanInfo.needsWedge = pull < (hasWedge ? -0.05 : -0.15);
      leanInfo.wedgesDriven = tree.wedgesDriven;
    }

    // Contract Objectives checklist
    const objectives: GameHUDState['objectives'] = [];
    if (contract) {
      for (const t of this.trees) {
        if (t.spec.hazardBranches > 0) {
          const done = t.prunedTargetCount >= t.spec.hazardBranches;
          objectives.push({
            id: `${t.spec.id}-prune`,
            treeId: t.spec.id,
            text: `Prune ${t.speciesSpec.name} hazard limbs`,
            done,
            progress: `${t.prunedTargetCount}/${t.spec.hazardBranches}`,
          });
        }
        if (t.standingTopCuts.length > 0) {
          const targetH = Math.round(t.standingTopCuts[t.standingTopCuts.length - 1].remainingHeight);
          const done = t.topCutsCompleted >= t.standingTopCuts.length;
          objectives.push({
            id: `${t.spec.id}-top`,
            treeId: t.spec.id,
            text: `Piece down ${t.speciesSpec.name} to ≤${targetH}m`,
            done,
            progress: `${t.topCutsCompleted}/${t.standingTopCuts.length}`,
          });
        }
        if (t.spec.task !== 'prune_only') {
          const fellDone = t.stage === 'fallen' || t.stage === 'bucked';
          objectives.push({
            id: `${t.spec.id}-fell`,
            treeId: t.spec.id,
            text: `Fell ${t.speciesSpec.name} into ${t.spec.dropZone?.label ?? 'clearing'}`,
            done: fellDone,
            progress: fellDone ? (t.hitHazards.length === 0 ? 'Safe' : 'Hit!') : undefined,
          });
          if (t.spec.requireBucking) {
            objectives.push({
              id: `${t.spec.id}-buck`,
              treeId: t.spec.id,
              text: `Buck ${t.speciesSpec.name} into sawlogs`,
              done: t.stage === 'bucked',
              progress: `${t.buckedCount}/${t.totalBuckCuts}`,
            });
          }
        }
      }
    }

    return {
      screen: this.screen,
      contract,
      activeTool: this.activeTool,
      unlockedTools: contract?.unlockedTools ?? ['prune'],
      activeTreeId: tree?.spec.id ?? null,
      activeTreeSpecies: tree?.speciesSpec ?? null,
      activeTreeStage: tree?.stage ?? null,
      activeTreeTask: tree?.spec.task ?? null,
      promptText: localizeControlCopy(promptText),
      subPromptText: localizeControlCopy(subPromptText),
      gauge,
      leanInfo,
      objectives,
      windSpeed: contract?.windSpeed ?? 0,
      windAngle: contract?.windAngle ?? 0,
      muted: this.audio.isMuted(),
      cameraAngleDeg: this.cameraCtrl.getAzimuthDeg(),
      completedContracts: this.completedContracts,
      totalEarnings: this.totalEarnings,
      debrief: this.debriefData,
      toast: this.elapsed < this.toastExpireAt ? this.currentToast : undefined,
    };
  }

  private emitHUD(): void {
    this.hudListener(this.buildHUDState());
  }

  private loop = (): void => {
    this.animFrameId = requestAnimationFrame(this.loop);
    const dt = Math.min(0.05, this.clock.getDelta());
    this.elapsed += dt;

    this.cameraCtrl.setKeyboardEnabled(this.screen === 'playing');
    this.cameraCtrl.update(dt);
    const chainsawIdling =
      this.screen === 'playing' &&
      this.activeTool === 'fell' &&
      !this.cameraCtrl.isIntroPlaying() &&
      !this.contractFinished;
    this.audio.setChainsawSelected(chainsawIdling);
    this.audio.update(dt);
    const camTarget = this.cameraCtrl.getTarget();
    this.env?.updateBackgroundOcclusion(this.camera.position, camTarget, dt);
    this.updatePlayableTreeOcclusion(this.camera.position, camTarget, dt);
    this.updateSceneStructureOcclusion(this.camera.position, camTarget, dt);

    if (this.screen === 'playing') {
      this.updateCutting(dt);
      this.updateWedgeAnimation(dt);
      this.updateFallingPhysics(dt);
      if (this.contractFinished && this.completionDelay > 0) {
        this.completionDelay -= dt;
        if (this.completionDelay <= 0) {
          this.finalizeContractDebrief();
        }
      }
    }

    this.updateVisualGuides(dt);
    this.particles.update(
      dt,
      this.elapsed,
      this.currentContract?.windSpeed ?? 0.12,
      this.currentContract?.windAngle ?? 0.5
    );

    // Subtle shimmer on creek / coastal inlet / headland cove water
    if (this.env?.waterMesh) {
      const baseWaterY =
        this.currentContract?.site === 'storm_bluff'
          ? -4.5
          : this.currentContract?.site === 'pacific_headland'
            ? -4.2
            : 0.04;
      this.env.waterMesh.position.y = baseWaterY + Math.sin(this.elapsed * 1.8) * 0.02;
    }

    this.renderer.render(this.scene, this.camera);

    // Periodic HUD refresh during active cutting/playing
    this.hudEmitTimer += dt;
    if (this.hudEmitTimer > 0.12) {
      this.hudEmitTimer = 0;
      if (this.screen === 'playing') {
        this.emitHUD();
      }
    }
  };

  public dispose(): void {
    cancelAnimationFrame(this.animFrameId);
    this.audio.dispose();
    this.renderer.dispose();
  }
}
