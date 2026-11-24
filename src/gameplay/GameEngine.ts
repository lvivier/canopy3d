import * as THREE from 'three';
import {
  BranchData,
  BuckRingData,
  ContractSpec,
  GameHUDState,
  ToolId,
  TreeRuntime,
} from '../types';
import { CAMPAIGN_CONTRACTS } from '../data/contracts';
import { AudioEngine } from '../audio/AudioEngine';
import { buildEnvironment, BuiltEnvironment } from '../graphics/EnvironmentBuilder';
import { buildTreeRuntime, recomputeTreeLean } from '../graphics/TreeGenerator';
import { CameraController } from './CameraController';
import { ParticleSystem } from './ParticleSystem';

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
  private cuttingBranch: BranchData | null = null;
  private cuttingBuck: { tree: TreeRuntime; ring: BuckRingData } | null = null;
  private cuttingTrunkStage: 'none' | 'notch' | 'backcut' = 'none';
  private groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

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
    this.cuttingBranch = null;
    this.cuttingBuck = null;
    this.cuttingTrunkStage = 'none';
    this.audio.setSawActive('none');
  }

  public openScreen(screen: GameHUDState['screen']): void {
    this.audio.init();
    this.audio.playClick();
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
      this.focusCameraForCurrentState(true);
    }

    this.showToast(`Contract Started: ${contract.title}`, 'info');
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

  public selectTree(treeId: string): void {
    const found = this.trees.find((t) => t.spec.id === treeId);
    if (!found) return;
    this.audio.playClick();
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

  private focusCameraForCurrentState(immediate: boolean): void {
    const tree = this.getActiveTree();
    if (!tree) return;

    const tx = tree.spec.x;
    const tz = tree.spec.z;
    const h = tree.spec.height;

    if (this.activeTool === 'prune') {
      this.cameraCtrl.focusOn(
        new THREE.Vector3(tx, h * 0.44, tz),
        Math.max(19.5, h * 1.24),
        1.17
      );
    } else if (this.activeTool === 'fell') {
      if (tree.stage === 'standing') {
        // High bird's-eye slanted view so player clearly sees tree + drop zone + hazards!
        const aimAngle = tree.spec.dropZone ? tree.spec.dropZone.angle : tree.aimAngle;
        this.cameraCtrl.focusOn(
          new THREE.Vector3(tx + Math.cos(aimAngle) * h * 0.22, h * 0.25, tz + Math.sin(aimAngle) * h * 0.22),
          Math.max(24, h * 1.45),
          0.92,
          aimAngle + Math.PI * 0.72
        );
      } else if (tree.stage === 'aimed') {
        // Focus nicely on the face-notch side of the trunk
        this.cameraCtrl.focusOn(
          new THREE.Vector3(tx, tree.cutHeight + 0.55, tz),
          Math.max(8.5, tree.baseRadius * 16),
          1.25,
          tree.aimAngle + 0.55
        );
      } else if (tree.stage === 'notched' || tree.stage === 'hinge_ready') {
        // Pivot cleanly to see the back-cut side AND down the drop direction
        this.cameraCtrl.focusOn(
          new THREE.Vector3(tx, tree.cutHeight + 0.6, tz),
          Math.max(9.2, tree.baseRadius * 17),
          1.22,
          tree.aimAngle + Math.PI - 0.58
        );
      }
    } else if (this.activeTool === 'wedge') {
      this.cameraCtrl.focusOn(
        new THREE.Vector3(tx, tree.cutHeight + 0.5, tz),
        Math.max(8.5, tree.baseRadius * 15),
        1.24,
        tree.aimAngle + Math.PI - 0.45
      );
    } else if (this.activeTool === 'buck') {
      const midDist = h * 0.36;
      this.cameraCtrl.focusOn(
        new THREE.Vector3(
          tx + Math.cos(tree.actualFallDirection) * midDist,
          1.2,
          tz + Math.sin(tree.actualFallDirection) * midDist
        ),
        Math.max(15, h * 0.85),
        0.95
      );
    }

    if (immediate) this.cameraCtrl.applyImmediate();
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
    const stakeMat = new THREE.MeshStandardMaterial({ color: '#d4d4d8', roughness: 0.7 });
    const flagMat = new THREE.MeshBasicMaterial({ color: '#10b981', side: THREE.DoubleSide });
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

    return g;
  }

  private bindInputEvents(): void {
    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    });

    this.canvas.addEventListener('pointermove', (e) => {
      this.updatePointerCoords(e);
      if (this.screen === 'playing' && !this.cameraCtrl.isUserOrbiting()) {
        this.handlePointerHover();
      }
    });

    this.canvas.addEventListener('pointerdown', (e) => {
      if (this.screen !== 'playing') return;
      if (e.button !== 0 || e.shiftKey) return;
      this.audio.init();
      this.updatePointerCoords(e);
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

  private handlePointerHover(): void {
    const activeTree = this.getActiveTree();
    this.raycaster.setFromCamera(this.pointerNDC, this.camera);

    // 1. Prune Mode Hover: raycast all unpruned branch colliders
    if (this.activeTool === 'prune') {
      const colliders: THREE.Object3D[] = [];
      for (const t of this.trees) {
        if (t.stage === 'falling' || t.stage === 'fallen' || t.stage === 'bucked') continue;
        for (const b of t.branches) {
          if (!b.pruned) colliders.push(b.colliderMesh);
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

    // 3. Bucking Mode Hover: raycast golden buck rings on fallen trees
    if (this.activeTool === 'buck') {
      const rings: THREE.Object3D[] = [];
      for (const t of this.trees) {
        if (t.stage !== 'fallen') continue;
        for (const r of t.buckRings) {
          if (!r.cutDone) rings.push(r.ringMesh);
        }
      }
      const hits = this.raycaster.intersectObjects(rings, false);
      if (hits.length > 0) {
        const { treeId, buckId } = hits[0].object.userData;
        const tree = this.trees.find((t) => t.spec.id === treeId);
        const ring = tree?.buckRings.find((r) => r.id === buckId);
        this.hoveredBuckRing = tree && ring ? { tree, ring } : null;
        this.canvas.style.cursor = 'crosshair';
      } else {
        this.hoveredBuckRing = null;
        this.canvas.style.cursor = '';
      }
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
    const trunkMeshes = this.trees.map((t) => t.trunkMesh);
    const trunkHits = this.raycaster.intersectObjects(trunkMeshes, false);

    // 1. PRUNE TOOL
    if (this.activeTool === 'prune') {
      if (this.hoveredBranch && !this.hoveredBranch.pruned) {
        this.cuttingBranch = this.hoveredBranch;
        if (this.hoveredBranch.treeId !== this.activeTreeId) {
          this.activeTreeId = this.hoveredBranch.treeId;
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
        this.audio.setSawActive('chainsaw', 1.0);
        return;
      }

      if (activeTree.stage === 'notched' || activeTree.stage === 'hinge_ready') {
        // Start sawing the Back Cut!
        this.cuttingTrunkStage = 'backcut';
        this.audio.setSawActive('chainsaw', 1.15);
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

    // 4. BUCKING TOOL
    if (this.activeTool === 'buck') {
      if (this.hoveredBuckRing && !this.hoveredBuckRing.ring.cutDone) {
        this.cuttingBuck = this.hoveredBuckRing;
        this.audio.setSawActive('chainsaw', 1.1);
        return;
      }
      // Or allow clicking nearest unbucked ring within easy reach of cursor ray
      for (const t of this.trees) {
        if (t.stage !== 'fallen') continue;
        for (const r of t.buckRings) {
          if (r.cutDone) continue;
          const worldP = new THREE.Vector3();
          r.ringMesh.getWorldPosition(worldP);
          const distToRay = this.raycaster.ray.distanceToPoint(worldP);
          if (distToRay < 1.35) {
            this.cuttingBuck = { tree: t, ring: r };
            this.audio.setSawActive('chainsaw', 1.1);
            return;
          }
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
    this.cuttingTrunkStage = 'none';
    if (this.cursorProgressCb) {
      this.cursorProgressCb(false, 0, 0, 0, '', '');
    }
  }

  private positionTrunkCutsForAim(tree: TreeRuntime): void {
    // Rotate notch & backcut meshes around Y so local +X points along tree.aimAngle!
    // Note: in Three.js, rotating +X by rotY produces (cos(-rotY), 0, sin(-rotY)), so rotY = -aimAngle.
    const rotY = -tree.aimAngle;
    tree.notchCutoutGroup.rotation.y = rotY;
    tree.backCutMesh.rotation.y = rotY;
    for (let w = 0; w < tree.wedgeMeshes.length; w++) {
      const wm = tree.wedgeMeshes[w];
      const zOff = (w - 1) * tree.baseRadius * 0.55;
      const dist = -tree.baseRadius * 1.05;
      // Rotate local (dist, 0.14, zOff) around Y by rotY
      const cosR = Math.cos(rotY);
      const sinR = Math.sin(rotY);
      wm.position.set(dist * cosR + zOff * sinR, 0.14, -dist * sinR + zOff * cosR);
      wm.rotation.set(0, rotY, 0.12);
    }
  }

  private driveWedge(tree: TreeRuntime): void {
    if (tree.wedgesDriven >= 3) {
      this.showToast('Max wedges driven! Finish the back cut carefully to tip it.', 'info');
      return;
    }

    const idx = tree.wedgesDriven;
    tree.wedgesDriven++;
    const wMesh = tree.wedgeMeshes[idx];
    if (wMesh) {
      wMesh.visible = true;
      // Sink slightly inward toward trunk center
      const dirToCenter = new THREE.Vector3(-wMesh.position.x, 0, -wMesh.position.z).normalize();
      wMesh.position.addScaledVector(dirToCenter, tree.baseRadius * 0.25);
    }

    this.audio.playWedgeStrike();
    this.cameraCtrl.triggerShake(0.14);

    // Spawn crisp chips at back cut
    const worldBack = new THREE.Vector3(
      tree.spec.x - Math.cos(tree.aimAngle) * tree.baseRadius,
      tree.cutHeight + 0.18,
      tree.spec.z - Math.sin(tree.aimAngle) * tree.baseRadius
    );
    this.particles.spawnSawdust(
      worldBack,
      new THREE.Vector3(-Math.cos(tree.aimAngle), 0.5, -Math.sin(tree.aimAngle)),
      tree.speciesSpec.sapwoodColor,
      10
    );

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
    const tx = tree.spec.x + Math.cos(tree.actualFallDirection) * tree.spec.height * 0.35;
    const tz = tree.spec.z + Math.sin(tree.actualFallDirection) * tree.spec.height * 0.35;
    this.cameraCtrl.focusOn(
      new THREE.Vector3(tx, tree.spec.height * 0.22, tz),
      Math.max(25, tree.spec.height * 1.38),
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
    const h = tree.spec.height;

    // 1. Check hazard collisions along the entire fallen trunk + crown footprint!
    const hitHazards: string[] = [];
    for (const haz of contract.hazards) {
      let hit = false;
      for (let s = 2; s <= 12; s++) {
        const dist = (s / 12) * h;
        const px = tree.spec.x + dx * dist;
        const pz = tree.spec.z + dz * dist;
        // Wider canopy radius near upper half of tree
        const treeWidthAtS = s > 6 ? 2.1 : 0.85;
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
    }
    this.emitHUD();
  }

  private checkIfAimHitsHazard(tree: TreeRuntime, angle: number): boolean {
    const contract = this.currentContract;
    if (!contract) return false;
    const dx = Math.cos(angle);
    const dz = Math.sin(angle);
    const h = tree.spec.height;
    for (const haz of contract.hazards) {
      for (let s = 2; s <= 12; s++) {
        const dist = (s / 12) * h;
        const px = tree.spec.x + dx * dist;
        const pz = tree.spec.z + dz * dist;
        const w = s > 6 ? 1.85 : 0.75;
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
    const midX = tree.spec.x + Math.cos(angle) * (tree.spec.height * 0.52);
    const midZ = tree.spec.z + Math.sin(angle) * (tree.spec.height * 0.52);
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

        const logValue = Math.round(
          t.spec.height * t.speciesSpec.timberValuePerMeter * (0.55 + (t.buckedCount / Math.max(1, t.totalBuckCuts)) * 0.45)
        );
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
    this.currentToast = { text, tone, id: this.toastCounter };
    this.toastExpireAt = this.elapsed + 3.8;
    this.emitHUD();
  }

  private updateCutting(dt: number): void {
    const activeTree = this.getActiveTree();

    // 1. Active Branch Pruning
    if (this.cuttingBranch && this.isLeftDown && this.activeTool === 'prune') {
      const b = this.cuttingBranch;
      const tree = this.trees.find((t) => t.spec.id === b.treeId);
      if (!tree || b.pruned) {
        this.cuttingBranch = null;
        this.audio.setSawActive('none');
        return;
      }

      const cutRate = 0.95 / (tree.speciesSpec.woodDensity * (0.7 + b.radius * 2.2));
      b.cutProgress = Math.min(1, b.cutProgress + cutRate * dt);
      this.audio.setSawActive('prune', 0.8 + b.cutProgress * 0.6);

      // Sawdust spray right at branch collar!
      if (Math.random() < 0.65) {
        const collarPos = new THREE.Vector3();
        b.collarRing.getWorldPosition(collarPos);
        this.particles.spawnSawdust(
          collarPos,
          b.worldDirection.clone().add(new THREE.Vector3(0, 0.3, 0)),
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
          b.isTarget ? 'Pruning Hazard Limb' : 'Caution: Healthy Limb!',
          b.isTarget ? 'good' : 'warn'
        );
      }

      if (b.cutProgress >= 1) {
        b.pruned = true;
        b.collarRing.visible = false;
        b.colliderMesh.visible = false;
        this.audio.setSawActive('none');
        this.audio.playBranchSnap();

        const collarPos = new THREE.Vector3();
        b.meshGroup.getWorldPosition(collarPos);
        this.particles.spawnFoliageBurst(collarPos, tree.speciesSpec.foliageColors, 12);
        this.particles.addFallingBranch(b.meshGroup, b.worldDirection);

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

        this.cuttingBranch = null;
        if (this.cursorProgressCb) this.cursorProgressCb(false, 0, 0, 0, '', '');
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
        const scaleX = Math.max(0.15, activeTree.notchDepth / 0.34);
        activeTree.notchCutoutGroup.scale.set(scaleX, 0.5 + scaleX * 0.5, 1);

        this.audio.setSawActive('chainsaw', 0.85 + activeTree.notchDepth * 1.1);

        if (Math.random() < 0.75) {
          const p = new THREE.Vector3(
            activeTree.spec.x + Math.cos(activeTree.aimAngle) * activeTree.baseRadius * 0.9,
            activeTree.cutHeight + 0.12,
            activeTree.spec.z + Math.sin(activeTree.aimAngle) * activeTree.baseRadius * 0.9
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
        activeTree.backCutMesh.visible = true;
        activeTree.backCutMesh.scale.set(Math.max(0.15, activeTree.backCutDepth), 1, 1);

        this.audio.setSawActive('chainsaw', 1.05 + activeTree.backCutDepth * 0.6);

        if (Math.random() < 0.75) {
          const p = new THREE.Vector3(
            activeTree.spec.x - Math.cos(activeTree.aimAngle) * activeTree.baseRadius * 0.95,
            activeTree.cutHeight + 0.14,
            activeTree.spec.z - Math.sin(activeTree.aimAngle) * activeTree.baseRadius * 0.95
          );
          this.particles.spawnSawdust(
            p,
            new THREE.Vector3(-Math.cos(activeTree.aimAngle), 0.3, -Math.sin(activeTree.aimAngle)),
            activeTree.speciesSpec.sapwoodColor,
            3
          );
        }

        const forwardPull = this.computeForwardPull(activeTree);

        if (this.cursorProgressCb) {
          const needsWedge = forwardPull < -0.05;
          const label =
            activeTree.backCutDepth > 0.9
              ? 'DANGER: Severing Hinge!'
              : needsWedge && activeTree.backCutDepth > 0.74
                ? 'Back-Leaning! Use Wedge!'
                : 'Cutting Back Hinge...';
          this.cursorProgressCb(
            true,
            this.pointerScreen.x,
            this.pointerScreen.y,
            activeTree.backCutDepth,
            label,
            activeTree.backCutDepth > 0.9 ? 'danger' : needsWedge && activeTree.backCutDepth > 0.74 ? 'warn' : 'good'
          );
        }

        // Tip threshold around 0.82 (10-15% holding hinge remaining!)
        if (activeTree.backCutDepth >= 0.82 && activeTree.backCutDepth < 0.94) {
          if (forwardPull >= -0.05) {
            this.initiateTreeFall(activeTree, false);
            if (this.cursorProgressCb) this.cursorProgressCb(false, 0, 0, 0, '', '');
            return;
          } else if (activeTree.stage !== 'hinge_ready') {
            activeTree.stage = 'hinge_ready';
            this.cuttingTrunkStage = 'none';
            this.isLeftDown = false;
            this.audio.setSawActive('none');
            if (this.cursorProgressCb) this.cursorProgressCb(false, 0, 0, 0, '', '');
            if (this.currentContract?.unlockedTools.includes('wedge')) {
              this.showToast('Tree sits back on the saw! Switch to Felling Wedge & tap to tip it forward!', 'warn');
            } else {
              this.showToast('Tree leans back! Prune back-side limbs first or push cut carefully.', 'warn');
            }
            this.emitHUD();
            return;
          }
        }

        // Severed hinge if player forces past 95%!
        if (activeTree.backCutDepth >= 0.95) {
          this.initiateTreeFall(activeTree, true);
          if (this.cursorProgressCb) this.cursorProgressCb(false, 0, 0, 0, '', '');
          return;
        }
      }
      return;
    }

    // 3. Active Bucking Cut on Fallen Log
    if (this.cuttingBuck && this.isLeftDown && this.activeTool === 'buck') {
      const { tree, ring } = this.cuttingBuck;
      const rate = 1.15 / tree.speciesSpec.woodDensity;
      ring.cutProgress = Math.min(1, ring.cutProgress + rate * dt);
      this.audio.setSawActive('chainsaw', 1.15);

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
        // Turn golden ring into a crisp dark saw-kerf band!
        const mat = ring.ringMesh.material as THREE.MeshBasicMaterial;
        mat.color.set('#1f120b');
        mat.opacity = 0.95;
        ring.ringMesh.scale.setScalar(0.84);
        tree.buckedCount++;
        this.audio.setSawActive('none');
        this.audio.playBranchSnap();

        if (tree.buckedCount >= tree.totalBuckCuts) {
          tree.stage = 'bucked';
          tree.completed = true;
          this.showToast(`All ${tree.totalBuckCuts} prime sawlogs bucked! (+Timber Bonus)`, 'good');
          this.audio.playSuccessChime();
          this.checkContractCompletion();
        } else {
          this.showToast(`Sawlog cut (${tree.buckedCount}/${tree.totalBuckCuts})!`, 'good');
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

      // Realistic rotational gravity acceleration: alpha ~ g * sin(theta) / L
      const gravityTorque = (6.8 / Math.sqrt(tree.spec.height * 0.25)) * (0.28 + Math.sin(tree.fallAngle));
      tree.fallVelocity += gravityTorque * dt;
      tree.fallAngle += tree.fallVelocity * dt;

      // Ground impact at ~PI/2 (adjusted slightly for trunk base radius)
      const targetRestAngle = Math.PI / 2 - 0.02;
      if (tree.fallAngle >= targetRestAngle) {
        tree.fallAngle = targetRestAngle;
        tree.stage = 'fallen';
        this.applyTreeFallTransform(tree);

        // Epic earth-shaking thud, camera shake, dust & needle burst!
        const weightScale = tree.spec.height / 20;
        this.audio.playTimberCrash(weightScale);
        this.cameraCtrl.triggerShake(0.45 * weightScale);
        this.particles.spawnTimberImpact(
          new THREE.Vector3(tree.spec.x, 0, tree.spec.z),
          tree.actualFallDirection,
          tree.spec.height,
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

  private updateVisualGuides(): void {
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
        sMat.opacity = isSelected ? 0.65 + Math.sin(this.elapsed * 4) * 0.18 : 0.25;
      }

      if (tree.stage !== 'falling' && tree.stage !== 'fallen' && tree.stage !== 'bucked') {
        const swayAmp = (0.005 + windSpeed * 0.022) * (tree.spec.height / 20);
        const sway = Math.sin(this.elapsed * (1.4 + windSpeed * 2.2) + tree.spec.seed) * swayAmp;
        tree.trunkPivot.rotation.set(
          Math.sin(windAngle) * sway,
          0,
          -Math.cos(windAngle) * sway
        );
      }

      // Branch collar ring visual feedback
      for (const b of tree.branches) {
        if (b.pruned) continue;
        const rMat = b.collarRing.material as THREE.MeshBasicMaterial;
        const isHov = this.hoveredBranch?.id === b.id || this.cuttingBranch?.id === b.id;
        if (this.activeTool === 'prune') {
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

      // Bucking ring hover pulse
      for (const r of tree.buckRings) {
        if (!r.ringMesh.visible || r.cutDone) continue;
        const isHov = this.hoveredBuckRing?.ring.id === r.id || this.cuttingBuck?.ring.id === r.id;
        const mat = r.ringMesh.material as THREE.MeshBasicMaterial;
        mat.color.set(isHov ? '#ffffff' : '#facc15');
        r.ringMesh.scale.setScalar(isHov ? 1.18 : 1.0 + Math.sin(this.elapsed * 4) * 0.05);
      }
    }

    // Hazard perimeter warning rings glow brighter while aiming chainsaw
    if (this.env) {
      const aimingNow = this.screen === 'playing' && this.activeTool === 'fell' && activeTree?.stage === 'standing';
      for (const ring of this.env.hazardWarningRings) {
        const mat = ring.material as THREE.MeshBasicMaterial;
        mat.opacity = aimingNow ? 0.45 + Math.sin(this.elapsed * 4) * 0.14 : 0.16;
      }
    }

    // Directional Felling Sight Guide
    const showAim =
      this.screen === 'playing' &&
      activeTree !== null &&
      activeTree.spec.task !== 'prune_only' &&
      (this.activeTool === 'fell' || this.activeTool === 'wedge') &&
      (activeTree.stage === 'standing' || activeTree.stage === 'aimed' || activeTree.stage === 'notched' || activeTree.stage === 'hinge_ready');

    this.aimGuideGroup.visible = showAim;
    if (showAim && activeTree) {
      this.aimGuideGroup.position.set(activeTree.spec.x, 0, activeTree.spec.z);
      this.aimGuideGroup.rotation.y = -activeTree.aimAngle;
      const len = activeTree.spec.height;
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
    const showTrunkRing =
      this.screen === 'playing' &&
      activeTree !== null &&
      (this.activeTool === 'fell' || this.activeTool === 'wedge') &&
      (activeTree.stage === 'aimed' || activeTree.stage === 'notched' || activeTree.stage === 'hinge_ready');

    this.trunkCutHighlight.visible = showTrunkRing;
    if (showTrunkRing && activeTree) {
      this.trunkCutHighlight.position.set(activeTree.spec.x, activeTree.cutHeight + 0.14, activeTree.spec.z);
      const pulse = 1.18 + Math.sin(this.elapsed * 5.5) * 0.06;
      this.trunkCutHighlight.scale.setScalar(activeTree.baseRadius * pulse);
      const mat = this.trunkCutHighlight.material as THREE.MeshBasicMaterial;
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
    let subPromptText = 'Right-Click + Drag to Orbit · Scroll to Zoom';

    if (tree && contract) {
      if (this.activeTool === 'prune') {
        const rem = Math.max(0, tree.spec.hazardBranches - tree.prunedTargetCount);
        if (rem > 0) {
          promptText = `Hover an amber-flagged limb & hold Left-Click to prune (${rem} left)`;
        } else if (tree.spec.task === 'prune_and_fell') {
          promptText = 'All hazard limbs cleared! Select the Chainsaw to fell this tree.';
        } else {
          promptText = 'Tree cleanly pruned! Click another tree or inspect your work.';
        }
      } else if (this.activeTool === 'fell') {
        if (tree.spec.task === 'prune_only') {
          promptText = 'This tree is protected—switch to the Pruning Saw!';
        } else if (tree.stage === 'standing') {
          promptText = 'Move cursor to aim into the green Drop Zone, then Left-Click to lock';
        } else if (tree.stage === 'aimed') {
          promptText = 'Hold Left-Click to saw the Face Notch — release in the green 30% zone!';
          subPromptText = 'Press Esc or click Re-Aim to change direction before cutting';
        } else if (tree.stage === 'notched') {
          promptText = 'Hold Left-Click to saw the Back Cut until the hinge releases (~82%)!';
        } else if (tree.stage === 'hinge_ready') {
          promptText = 'Back-leaning! Select the Felling Wedge & click the trunk to tip it forward!';
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
        if (tree.stage === 'fallen') {
          promptText = 'Hover a golden ring on the fallen trunk & hold Left-Click to buck sawlogs!';
        } else {
          promptText = 'Fell a tree first before bucking logs.';
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
          gauge.statusText = `${pct}% · Pinched! Drive Wedges`;
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
      leanInfo.visible = true;
      leanInfo.leanMagnitude = Math.min(1, tree.currentLeanVec.length() * 1.8);
      leanInfo.helpsAim = Math.max(-1, Math.min(1, pull * 2.2));
      leanInfo.needsWedge = pull < -0.05;
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
            text: `Prune ${t.speciesSpec.name} hazard limbs`,
            done,
            progress: `${t.prunedTargetCount}/${t.spec.hazardBranches}`,
          });
        }
        if (t.spec.task !== 'prune_only') {
          const fellDone = t.stage === 'fallen' || t.stage === 'bucked';
          objectives.push({
            id: `${t.spec.id}-fell`,
            text: `Fell ${t.speciesSpec.name} into ${t.spec.dropZone?.label ?? 'clearing'}`,
            done: fellDone,
            progress: fellDone ? (t.hitHazards.length === 0 ? 'Safe' : 'Hit!') : undefined,
          });
          if (t.spec.requireBucking) {
            objectives.push({
              id: `${t.spec.id}-buck`,
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
      promptText,
      subPromptText,
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

    this.cameraCtrl.update(dt);

    if (this.screen === 'playing') {
      this.updateCutting(dt);
      this.updateFallingPhysics(dt);
      if (this.contractFinished && this.completionDelay > 0) {
        this.completionDelay -= dt;
        if (this.completionDelay <= 0) {
          this.finalizeContractDebrief();
        }
      }
    }

    this.updateVisualGuides();
    this.particles.update(
      dt,
      this.elapsed,
      this.currentContract?.windSpeed ?? 0.12,
      this.currentContract?.windAngle ?? 0.5
    );

    // Subtle shimmer on creek / coastal inlet water
    if (this.env?.waterMesh) {
      this.env.waterMesh.position.y =
        (this.currentContract?.site === 'storm_bluff' ? -4.5 : 0.04) +
        Math.sin(this.elapsed * 1.8) * 0.02;
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
