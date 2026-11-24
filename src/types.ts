import * as THREE from 'three';

export type SpeciesId =
  | 'douglas_fir'
  | 'western_red_cedar'
  | 'sitka_spruce'
  | 'bigleaf_maple'
  | 'red_alder'
  | 'western_hemlock';

export type SiteId =
  | 'coastal_homestead'
  | 'misty_creek'
  | 'timber_ridge'
  | 'storm_bluff';

export type ToolId = 'prune' | 'fell' | 'wedge' | 'buck';

export type WeatherId = 'sunny_morning' | 'misty_fog' | 'golden_hour' | 'coastal_gale';

export interface SpeciesSpec {
  id: SpeciesId;
  name: string;
  latinName: string;
  category: 'conifer' | 'deciduous';
  description: string;
  arboristTip: string;
  barkPrimary: string;
  barkSecondary: string;
  barkStyle: 'furrowed' | 'fibrous' | 'scaly' | 'mossy' | 'smooth_lichen' | 'plated';
  heartwoodColor: string;
  sapwoodColor: string;
  foliageColors: string[];
  /** Cut resistance multiplier: <1 cuts faster, >1 tougher hardwood */
  woodDensity: number;
  /** Value per meter of prime trunk timber */
  timberValuePerMeter: number;
  /** Typical height range in meters */
  heightRange: [number, number];
  /** Trunk base radius factor relative to height */
  radiusRatio: number;
  /** Buttress flare multiplier at base */
  buttressFlare: number;
  /** Drooping leader tip (characteristic of Western Hemlock) */
  droopingLeader?: boolean;
  /** Crown shape silhouette */
  crownShape: 'spire' | 'sweeping_cone' | 'tiered_spruce' | 'broad_dome' | 'oval_upright' | 'graceful_feathery';
}

export interface HazardSpec {
  id: string;
  label: string;
  type: 'cabin' | 'shed' | 'barn' | 'fence' | 'truck' | 'gazebo' | 'powerline' | 'sapling';
  x: number;
  z: number;
  radius: number;
  width?: number;
  depth?: number;
  rotation?: number;
}

export interface DropZoneSpec {
  /** Center position of the preferred drop landing strip */
  x: number;
  z: number;
  /** Direction angle in radians from tree base or standalone orientation */
  angle: number;
  length: number;
  width: number;
  label?: string;
}

export interface TreePlacementSpec {
  id: string;
  species: SpeciesId;
  x: number;
  z: number;
  height: number;
  /** Natural lean in radians (direction the tree leans toward) */
  leanAngle: number;
  /** Natural lean magnitude 0..1 (0 = dead plumb, 0.3 = noticeable lean, 0.7 = heavy hazard lean) */
  leanStrength: number;
  /** Primary task for this tree */
  task: 'prune_only' | 'fell' | 'prune_and_fell';
  /** Number of target hazard/deadwood branches to prune */
  hazardBranches: number;
  /** Direction where hazard/overhanging branches should bias toward (radians), optional */
  hazardBranchAngle?: number;
  /** Target safe drop zone for this tree (if task includes felling) */
  dropZone?: DropZoneSpec;
  /** Require bucking into mill logs after felling */
  requireBucking?: boolean;
  /** Optional standing top-down piecing cuts (descending total heights in meters, e.g. [21, 15]) */
  standingTopCutHeights?: number[];
  /** Seed for deterministic procedural tree generation */
  seed: number;
}

export interface ContractSpec {
  id: string;
  index: number;
  title: string;
  subtitle: string;
  site: SiteId;
  weather: WeatherId;
  difficulty: 1 | 2 | 3 | 4 | 5;
  windSpeed: number; // 0..1
  windAngle: number; // radians
  unlockedTools: ToolId[];
  briefing: string;
  tips: string[];
  trees: TreePlacementSpec[];
  hazards: HazardSpec[];
  basePayout: number;
  isSandbox?: boolean;
}

export interface BranchData {
  id: string;
  treeId: string;
  meshGroup: THREE.Group;
  colliderMesh: THREE.Mesh;
  collarRing: THREE.Mesh;
  attachLocalPos: THREE.Vector3;
  worldDirection: THREE.Vector3;
  radius: number;
  length: number;
  weight: number; // contributes to lean/center-of-gravity
  isTarget: boolean; // deadwood, overhanging, or hazard limb
  isHealthy: boolean;
  /** Crown boughs only interactive for limbing once the tree is on the ground */
  groundLimbOnly?: boolean;
  reason?: 'deadwood' | 'overhanging' | 'weight_balance' | 'storm_cracked';
  cutProgress: number; // 0..1
  pruned: boolean;
}

export type TreeFellStage =
  | 'standing'       // ready to aim
  | 'aimed'          // drop angle locked, ready for face notch
  | 'notched'        // face notch complete, ready for back cut
  | 'hinge_ready'    // back cut cut enough, needs wedge (if back-leaning) or more cut
  | 'falling'        // active falling physics
  | 'fallen'         // resting on ground, ready for optional/required bucking
  | 'bucked';        // all bucking cuts finished

export interface BuckRingData {
  id: string;
  distanceAlongTrunk: number;
  ringMesh: THREE.Mesh;
  cutProgress: number;
  cutDone: boolean;
}

export interface StandingTopCutData {
  id: string;
  /** Local Y along trunkPivot where this standing top cut slices the stem */
  localY: number;
  /** Remaining total tree height (cutHeight + localY) after this round is removed */
  remainingHeight: number;
  /** First segment index detached by this standing cut */
  startSegmentIndex: number;
  ringMesh: THREE.Mesh;
  colliderMesh: THREE.Mesh;
  cutProgress: number;
  cutDone: boolean;
}

export interface LogSegmentData {
  index: number;
  yStart: number;
  yEnd: number;
  avgRadius: number;
  group: THREE.Group;
  barkMesh: THREE.Mesh;
  bottomCap: THREE.Mesh;
  topCap: THREE.Mesh;
  detached: boolean;
}

export interface TreeRuntime {
  spec: TreePlacementSpec;
  speciesSpec: SpeciesSpec;
  rootGroup: THREE.Group;
  stumpGroup: THREE.Group;
  trunkPivot: THREE.Group; // rotates during felling!
  trunkMesh: THREE.Mesh;
  segments: LogSegmentData[];
  notchCutoutGroup: THREE.Group;
  notchParts: {
    ceiling: THREE.Mesh;
    floor: THREE.Mesh;
  };
  /** Local-space uniforms punching exact Humboldt notch & back-cut kerf in butt-log bark */
  cutShaderUniforms: {
    uSeg0Pos: { value: THREE.Vector3 };
    uCutCenterXZ: { value: THREE.Vector2 };
    uAimDir: { value: THREE.Vector2 };
    uFaceEnabled: { value: number };
    uFaceTopY: { value: number };
    uFaceHingeX: { value: number };
    uFaceSlope: { value: number };
    uBackEnabled: { value: number };
    uBackCenterY: { value: number };
    uBackHalfH: { value: number };
    uBackTipX: { value: number };
  };
  /** Height (in trunkPivot local Y) of the horizontal Humboldt ceiling cut */
  cutTopY: number;
  /** Exact trunk centerline XZ offset (in trunkPivot local coords) at cutTopY */
  cutCenterXZ: THREE.Vector2;
  /** Exact trunk radius at cutTopY */
  cutRadius: number;
  /** Linear trunk radius taper slope (dr/dy) in butt log */
  cutRadiusSlope: number;
  backCutGroup: THREE.Group;
  backCutParts: {
    topFace: THREE.Mesh;
    bottomFace: THREE.Mesh;
    hingeWall: THREE.Mesh;
  };
  wedgeMeshes: THREE.Mesh[];
  branches: BranchData[];
  buckRings: BuckRingData[];
  standingTopCuts: StandingTopCutData[];
  topCutsCompleted: number;
  /** Live effective height of the tree (decreases as standing top rounds are pieced down) */
  currentHeight: number;
  baseRadius: number;
  cutHeight: number;
  stage: TreeFellStage;
  aimAngle: number; // chosen felling direction (radians in XZ plane: cos(a), sin(a))
  notchDepth: number; // 0..0.55 (ideal 0.25..0.35)
  notchQuality: number; // 0..1
  backCutDepth: number; // 0..0.75 (ideal stops leaving 0.08..0.14 hinge)
  hingeIntegrity: number; // 0..1 (1 = clean hinge, 0 = severed/barber chair)
  wedgesDriven: number; // 0..3
  /** Current computed lean vector in XZ plane (updates dynamically as branches are pruned!) */
  currentLeanVec: THREE.Vector2;
  /** Fall physics state */
  fallAngle: number; // 0 -> PI/2
  fallVelocity: number;
  actualFallDirection: number; // radians
  fallBounce: number;
  /** Scoring outcomes */
  landedInDropZone: boolean;
  hitHazards: string[];
  prunedTargetCount: number;
  prunedHealthyPenaltyCount: number;
  limbedCount: number;
  buckedCount: number;
  totalBuckCuts: number;
  completed: boolean;
  /** 1 = fully opaque; lerps down when this tree blocks the camera's view of the active subject */
  occlusionFade: number;
  /** Cached MeshStandardMaterials for smooth occlusion fade (excludes UI rings) */
  occlusionMaterials: Array<{ mat: THREE.Material; baseOpacity: number }>;
  /** Selection highlight ring at base */
  selectionRing: THREE.Mesh;
  /** Drop zone visual meshes */
  dropZoneGroup?: THREE.Group;
}

export interface GameHUDState {
  screen: 'title' | 'contracts' | 'playing' | 'debrief' | 'sandbox';
  contract: ContractSpec | null;
  activeTool: ToolId;
  unlockedTools: ToolId[];
  activeTreeId: string | null;
  activeTreeSpecies: SpeciesSpec | null;
  activeTreeStage: TreeFellStage | null;
  activeTreeTask: TreePlacementSpec['task'] | null;
  promptText: string;
  subPromptText: string;
  /** Active cutting gauge */
  gauge: {
    visible: boolean;
    label: string;
    value: number; // 0..1
    sweetMin: number;
    sweetMax: number;
    dangerMin?: number;
    statusText: string;
    statusTone: 'neutral' | 'good' | 'warn' | 'danger';
  };
  /** Lean / Center-of-gravity readout */
  leanInfo: {
    visible: boolean;
    leanMagnitude: number; // 0..1
    helpsAim: number; // -1 (back-lean) .. +1 (forward lean)
    needsWedge: boolean;
    wedgesDriven: number;
  };
  objectives: Array<{
    id: string;
    text: string;
    done: boolean;
    progress?: string;
  }>;
  windSpeed: number;
  windAngle: number;
  muted: boolean;
  cameraAngleDeg: number;
  /** Contract progress */
  completedContracts: Record<string, { stars: number; score: number; earnings: number }>;
  totalEarnings: number;
  /** Debrief data */
  debrief?: {
    success: boolean;
    stars: number;
    accuracyScore: number;
    safetyBonus: number;
    timberValue: number;
    totalEarned: number;
    penalties: string[];
    highlights: string[];
    hasNextContract: boolean;
  };
  /** Live floating toast notifications */
  toast?: {
    text: string;
    tone: 'info' | 'good' | 'warn' | 'danger';
    id: number;
  };
}
