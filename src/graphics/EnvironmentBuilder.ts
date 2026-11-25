import * as THREE from 'three';
import { ContractSpec, GraphicsQuality, HazardSpec, SiteId, SpeciesId, WeatherId } from '../types';
import { PNW_SPECIES } from '../data/species';
import { textureCache } from './ProceduralTextures';
import { ensureAoUv, pbrAssets, SITE_TERRAIN_PROFILES } from './PbrAssetManager';
import { createWaterShaderMaterial } from './WaterShader';
import { applyGroundCoverShader, applyGroundedRockShader, applyTerrainDetailShader, FoliageWindUniforms } from './MaterialShaders';
import { buildBackdropConiferCrownAssets, buildBotanicalFoliageCluster, createTreeBotanicalContext } from './FoliageCardBuilder';
import { attachPropModel } from './PropModelLoader';

export interface SceneOccluder {
  rootGroup: THREE.Object3D;
  occlusionFade: number;
  occlusionMaterials: Array<{ mat: THREE.Material; baseOpacity: number }>;
  /** Static world AABB. Hazards do not move, so the fade test fills this once. */
  worldBox?: THREE.Box3;
}

export interface BuiltEnvironment {
  group: THREE.Group;
  hazardGroups: Map<string, THREE.Group>;
  hazardWarningRings: THREE.Mesh[];
  sceneOccluders: SceneOccluder[];
  waterMesh?: THREE.Mesh;
  sunLight: THREE.DirectionalLight;
  hemiLight: THREE.HemisphereLight;
  sunDir: THREE.Vector3;
  skyMesh: THREE.Mesh;
  windAnimatedMeshes: THREE.Object3D[];
  updateEffects: (elapsed: number, windSpeed: number, windAngle: number) => void;
  updateBackgroundOcclusion: (cameraPos: THREE.Vector3, targetPos: THREE.Vector3, dt: number) => void;
}

function collectOcclusionMaterials(root: THREE.Object3D): SceneOccluder['occlusionMaterials'] {
  const occlusionMaterials: SceneOccluder['occlusionMaterials'] = [];
  const seenMats = new Set<THREE.Material>();
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    for (const mat of mats) {
      if (!mat || seenMats.has(mat)) continue;
      if ((mat as THREE.MeshBasicMaterial).isMeshBasicMaterial) continue;
      seenMats.add(mat);
      occlusionMaterials.push({
        mat,
        baseOpacity: mat.opacity ?? 1,
      });
    }
  });
  return occlusionMaterials;
}

function makeRng(seed: number): () => number {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

/**
 * Natural meandering centerline, organic width, and tangent slope for the Misty Creek stream.
 * Curves gracefully around the western sapling (-6.5, 11.0) & pasture fence (-6.0, 12.0),
 * passes right under the rustic footbridge at x ≈ +4.2, and meanders out past the valley fog.
 */
export function getMistyCreekCenterZ(x: number): number {
  const meander =
    12.2 +
    Math.sin(x * 0.105 - 0.85) * 3.4 +
    Math.cos(x * 0.21 + 0.35) * 1.15;
  // Smooth bend curving south (+Z) around the protected sapling (-6.5, 11.0) & pasture fence (-6.0, 12.0)
  const dxSap = x - -6.5;
  const sapAvoid = 9.0 * Math.exp(-(dxSap * dxSap) / (2 * 5.0 * 5.0));
  return meander + sapAvoid;
}

export function getMistyCreekHalfWidth(x: number): number {
  // Wider natural pools on outer bends, narrower riffle crossing at the timber footbridge (x ≈ 4.2)
  const base = 2.45 + Math.sin(x * 0.15 + 1.0) * 0.5 + Math.cos(x * 0.28 - 0.5) * 0.22;
  const dxBridge = x - 4.2;
  const bridgePinch = 0.45 * Math.exp(-(dxBridge * dxBridge) / (2 * 4.5 * 4.5));
  return Math.max(1.75, base - bridgePinch);
}

function getMistyCreekSlope(x: number): number {
  const eps = 0.15;
  return (getMistyCreekCenterZ(x + eps) - getMistyCreekCenterZ(x - eps)) / (2 * eps);
}

function isInMistyCreek(x: number, z: number, margin = 0): boolean {
  const cz = getMistyCreekCenterZ(x);
  const hw = getMistyCreekHalfWidth(x);
  return Math.abs(z - cz) < hw + margin;
}

/**
 * Natural winding rural gravel lane centerline for Coastal Homestead.
 * Runs from a rounded gravel turnaround apron near the cabin (z ≈ -8.2)
 * through gentle S-bends all the way out past the forested horizon (z = +118).
 */
function getHomesteadDrivewayBaseX(z: number): number {
  const nearCurve = Math.sin((z + 2.5) * 0.205) * 2.0;
  const outerMeander =
    Math.sin((z - 18.0) * 0.056) * 5.2 * THREE.MathUtils.smoothstep(z, 14, 42);
  return -0.15 + nearCurve + outerMeander;
}

interface HomesteadDrivewayCurve {
  centerX: (z: number) => number;
  halfWidth: (z: number) => number;
  slope: (z: number) => number;
  zMin: number;
  zMax: number;
  isOnDriveway: (x: number, z: number, margin?: number) => boolean;
}

function createHomesteadDrivewayCurve(contract: ContractSpec): HomesteadDrivewayCurve {
  // Smoothly curve around any standing contract tree that sits close to the base lane
  const treeBends: Array<{ z0: number; amp: number; sigma: number }> = [];
  for (const t of contract.trees) {
    if (t.z < -12 || t.z > 28) continue;
    const bx = getHomesteadDrivewayBaseX(t.z);
    const dx = t.x - bx;
    if (Math.abs(dx) < 3.5) {
      // Deflect cleanly to the clearer side of the tree trunk
      const dir = dx > 0.25 ? -1 : 1;
      const needed = 3.85 - Math.abs(dx);
      treeBends.push({ z0: t.z, amp: dir * needed, sigma: 5.2 });
    }
  }

  const zMin = -11.4;
  const zMax = 118;

  const centerX = (z: number): number => {
    let x = getHomesteadDrivewayBaseX(z);
    for (const b of treeBends) {
      const dz = z - b.z0;
      x += b.amp * Math.exp(-(dz * dz) / (2 * b.sigma * b.sigma));
    }
    return x;
  };

  const halfWidth = (z: number): number => {
    if (z < zMin) return 0;
    // Rounded teardrop gravel turnaround apron near the cabin (z ∈ [-11.4, -4.5])
    const baseLane = 2.15 + Math.sin(z * 0.11 + 0.6) * 0.22;
    const dzApron = z - -8.0;
    const apronFlare = 1.45 * Math.exp(-(dzApron * dzApron) / (2 * 2.5 * 2.5));
    const rawW = baseLane + apronFlare;
    // Smooth semicircular cap closing the north end of the turnaround apron (no flat rectangle!)
    if (z < -8.2) {
      const capT = THREE.MathUtils.clamp((-8.2 - z) / (-8.2 - zMin), 0, 1);
      return rawW * Math.sqrt(Math.max(0, 1 - capT * capT));
    }
    return rawW;
  };

  const slope = (z: number): number => {
    const eps = 0.2;
    return (centerX(z + eps) - centerX(z - eps)) / (2 * eps);
  };

  const isOnDriveway = (x: number, z: number, margin = 0): boolean => {
    if (z < zMin - margin || z > zMax) return false;
    const hw = halfWidth(Math.max(z, zMin + 0.05));
    if (z < zMin) {
      // Circular margin check around the north turnaround cap
      const capX = centerX(-8.2);
      return Math.hypot(x - capX, z - -8.2) < halfWidth(-8.2) + margin;
    }
    return Math.abs(x - centerX(z)) < hw + margin;
  };

  return { centerX, halfWidth, slope, zMin, zMax, isOnDriveway };
}

/**
 * Computes terrain elevation at world (x, z).
 * Central 24m radius is level (0m) for crisp tree felling & structures,
 * transitioning smoothly into undulating coastal PNW forested hills!
 */
export function getTerrainHeight(x: number, z: number, site: SiteId): number {
  const dist = Math.hypot(x, z);
  const flatRadius = site === 'coastal_town' ? 27 : 23;

  const t = Math.min(1, Math.max(0, (dist - flatRadius) / 42));
  const smooth = t * t * (3 - 2 * t);

  if (site === 'misty_creek') {
    const cz = getMistyCreekCenterZ(x);
    const hw = getMistyCreekHalfWidth(x);
    const perpDist = Math.abs(z - cz);
    const bankU = perpDist / hw;
    // Gently carve the outer valley hills down along the meandering creek corridor
    const valleyMask = THREE.MathUtils.smoothstep(bankU, 1.35, 3.6);
    const ridgeNoise =
      Math.sin(x * 0.045 + 0.5) * Math.cos(z * 0.04 - 0.3) * 7.5 +
      Math.sin(x * 0.11 - z * 0.08) * 2.6 +
      Math.cos(dist * 0.06) * 2.2;
    const hillY = dist <= flatRadius ? 0 : smooth * valleyMask * (6.2 + ridgeNoise * 0.85);
    // Carve a natural submerged riverbed trough beneath the meandering waterline
    if (bankU < 1.6) {
      const k = 1 - THREE.MathUtils.smoothstep(bankU, 0.25, 1.6);
      return hillY - 0.56 * k;
    }
    return hillY;
  }

  if (dist <= flatRadius) return 0;

  const ridgeNoise =
    Math.sin(x * 0.045 + 0.5) * Math.cos(z * 0.04 - 0.3) * 7.5 +
    Math.sin(x * 0.11 - z * 0.08) * 2.6 +
    Math.cos(dist * 0.06) * 2.2;

  if (site === 'timber_ridge') {
    return smooth * (9.5 + ridgeNoise * 1.15);
  }
  if (site === 'storm_bluff') {
    // Drops gently toward ocean inlet on +X/+Z, rises behind on -X/-Z
    const cliffSlope = (-x * 0.16 - z * 0.12) * smooth;
    return Math.max(-7, smooth * (4.0 + ridgeNoise * 0.75) + cliffSlope);
  }
  if (site === 'pacific_headland') {
    // Sunlit coastal savanna headland sloping toward a deep Pacific cove on +X/+Z
    const coveSlope = (-x * 0.14 - z * 0.15) * smooth;
    return Math.max(-6.5, smooth * (3.6 + ridgeNoise * 0.68) + coveSlope);
  }
  if (site === 'kootenay_rockies') {
    // Rolling East Kootenay foothills: broad dry-grass hills rising around a level montane bench,
    // staying lower on the north-east vista side so the distant Rocky Mountain peaks shine through
    const rollingHills =
      Math.sin(x * 0.038 + 1.1) * Math.cos(z * 0.034 - 0.6) * 8.8 +
      Math.sin((x + z) * 0.055) * 3.8 +
      Math.cos(dist * 0.048) * 2.6;
    const valleyDip = x > 8 && z < -6 ? -3.4 * smooth : 0;
    return Math.max(-2.5, smooth * (7.2 + rollingHills) + valleyDip);
  }
  if (site === 'coastal_town') {
    // Keep the east-west town street level while wooded hills rise gently behind the neighborhood
    const roadKeepFlat = Math.abs(z - 16.5) < 9 ? 0.15 : 1.0;
    return smooth * roadKeepFlat * (4.2 + ridgeNoise * 0.58);
  }
  if (site === 'coastal_homestead') {
    // Gently grade the winding rural driveway corridor into the outer forested hillside
    const laneDist = z > 12 ? Math.abs(x - getHomesteadDrivewayBaseX(z)) : 99;
    const laneGrade = THREE.MathUtils.smoothstep(laneDist, 2.4, 8.5);
    return smooth * (0.28 + 0.72 * laneGrade) * (5.2 + ridgeNoise * 0.72);
  }
  return smooth * (5.2 + ridgeNoise * 0.72);
}

function createSkyDome(
  weather: WeatherId,
  site: SiteId,
  quality: GraphicsQuality
): {
  skyMesh: THREE.Mesh;
  sunDir: THREE.Vector3;
  fogColor: number;
  fogDensity: number;
  skyTop: THREE.Color;
  skyHorizon: THREE.Color;
  sunColor: THREE.Color;
  updateSky: (elapsed: number, windSpeed: number) => void;
} {
  const palettes: Record<
    WeatherId,
    {
      top: string;
      mid: string;
      horizon: string;
      sun: string;
      sunPos: [number, number, number];
      sunGlow: number;
      fog: number;
      density: number;
      cloudCover: number;
      cloudTint: string;
      cloudDark: string;
    }
  > = {
    sunny_morning: {
      top: site === 'kootenay_rockies' ? '#2c6eb3' : '#3b7bb8',
      mid: '#7fb3d5',
      horizon: '#d8e9df',
      sun: '#fff4cf',
      sunPos: [45, 38, -32],
      sunGlow: 1.0,
      fog: 0xcde0d8,
      density: 0.0072,
      cloudCover: site === 'kootenay_rockies' ? 0.24 : 0.36,
      cloudTint: '#ffffff',
      cloudDark: '#a8c2d6',
    },
    misty_fog: {
      top: '#5e7884',
      mid: '#8ea5ab',
      horizon: '#c7d5d2',
      sun: '#f0f4e8',
      sunPos: [30, 34, -40],
      sunGlow: 0.55,
      fog: 0xbfcfcc,
      density: 0.0125,
      cloudCover: 0.68,
      cloudTint: '#e3ece9',
      cloudDark: '#8ea3a8',
    },
    light_rain: {
      top: '#3d4f59',
      mid: '#637880',
      horizon: '#94a8a9',
      sun: '#c2d3d8',
      sunPos: [18, 42, -36],
      sunGlow: 0.22,
      fog: 0x899ea1,
      density: 0.0118,
      cloudCover: 0.86,
      cloudTint: '#b4c4c9',
      cloudDark: '#596b73',
    },
    golden_hour: {
      top: '#2e4e72',
      mid: '#9e8476',
      horizon: '#ebc192',
      sun: '#ffd584',
      sunPos: [-52, 22, -38],
      sunGlow: 1.05,
      fog: 0xd9bfa0,
      density: 0.0085,
      cloudCover: 0.48,
      cloudTint: '#ffd8a3',
      cloudDark: '#6c6878',
    },
    coastal_gale: {
      top: '#384c59',
      mid: '#647984',
      horizon: '#9eb1b5',
      sun: '#d8e3e6',
      sunPos: [-35, 28, -45],
      sunGlow: 0.45,
      fog: 0x93a7ac,
      density: 0.011,
      cloudCover: 0.78,
      cloudTint: '#c8d6da',
      cloudDark: '#556772',
    },
  };

  const p = palettes[weather];
  const sunDir = new THREE.Vector3(...p.sunPos).normalize();
  const skyTop = new THREE.Color(p.top);
  const skyHorizon = new THREE.Color(p.horizon);
  const sunColor = new THREE.Color(p.sun);

  const uniforms = {
    uTop: { value: skyTop.clone() },
    uMid: { value: new THREE.Color(p.mid) },
    uHorizon: { value: skyHorizon.clone() },
    uSunColor: { value: sunColor.clone() },
    uSunDir: { value: sunDir },
    uSunGlow: { value: p.sunGlow },
    uTime: { value: 0 },
    uCloudCover: { value: quality === 'high' ? p.cloudCover : 0.0 },
    uCloudTint: { value: new THREE.Color(p.cloudTint) },
    uCloudDark: { value: new THREE.Color(p.cloudDark) },
  };

  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms,
    vertexShader: `
      varying vec3 vWorldPos;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: `
      uniform vec3 uTop;
      uniform vec3 uMid;
      uniform vec3 uHorizon;
      uniform vec3 uSunColor;
      uniform vec3 uSunDir;
      uniform float uSunGlow;
      uniform float uTime;
      uniform float uCloudCover;
      uniform vec3 uCloudTint;
      uniform vec3 uCloudDark;
      varying vec3 vWorldPos;

      float sHash(vec2 p) {
        p = fract(p * vec2(127.1, 311.7));
        p += dot(p, p + 19.19);
        return fract(p.x * p.y);
      }
      float sNoise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(
          mix(sHash(i), sHash(i + vec2(1.0, 0.0)), u.x),
          mix(sHash(i + vec2(0.0, 1.0)), sHash(i + vec2(1.0, 1.0)), u.x),
          u.y
        );
      }
      float fbmCloud(vec2 p) {
        float v = 0.0;
        float a = 0.5;
        mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
        for (int i = 0; i < 4; i++) {
          v += a * sNoise(p);
          p = rot * p * 2.04;
          a *= 0.5;
        }
        return v;
      }

      void main() {
        vec3 dir = normalize(vWorldPos);
        float h = clamp(dir.y, 0.0, 1.0);
        vec3 col = mix(uHorizon, uMid, smoothstep(0.0, 0.28, h));
        col = mix(col, uTop, smoothstep(0.25, 0.85, h));

        vec3 sunD = normalize(uSunDir);
        float sunDot = clamp(dot(dir, sunD), 0.0, 1.0);
        float sd = max(sunDot, 1e-4);
        float sunHalo = (pow(sd, 12.0) * 0.35 + pow(sd, 180.0) * 1.15) * uSunGlow * step(1e-3, sunDot);
        col += uSunColor * sunHalo;

        // Procedural drifting volumetric-look sky clouds on High detail
        if (uCloudCover > 0.02 && dir.y > 0.02) {
          vec2 uv = dir.xz / (dir.y + 0.22);
          float c1 = fbmCloud(uv * 1.15 + vec2(uTime * 0.012, uTime * 0.005));
          float c2 = fbmCloud(uv * 2.4 - vec2(uTime * 0.018, -uTime * 0.009));
          float density = smoothstep(1.0 - uCloudCover * 0.92, 0.92, c1 * 0.72 + c2 * 0.35);
          float horizonFade = smoothstep(0.02, 0.22, dir.y);
          // Silver-lining Henyey-Greenstein style forward scatter near sun
          float silver = (sunDot > 1e-4 ? pow(sunDot, 6.0) : 0.0) * 0.55 * uSunGlow;
          vec3 cloudCol = mix(uCloudDark, uCloudTint, clamp(c2 * 0.85 + 0.25, 0.0, 1.0)) + uSunColor * silver;
          col = mix(col, cloudCol, density * horizonFade * 0.78);
        }

        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });

  const skyMesh = new THREE.Mesh(new THREE.SphereGeometry(220, 32, 20), skyMat);
  return {
    skyMesh,
    sunDir,
    fogColor: p.fog,
    fogDensity: p.density,
    skyTop,
    skyHorizon,
    sunColor,
    updateSky: (elapsed: number, windSpeed: number) => {
      uniforms.uTime.value = elapsed * (0.65 + windSpeed * 1.6);
    },
  };
}

function createWoodPbrMat(
  tint: string,
  quality: GraphicsQuality,
  repeatX = 2,
  repeatY = 2,
  roughness = 0.88
): THREE.MeshStandardMaterial {
  const pbr = pbrAssets.getPbrSet('wood_planks', quality, { repeatX, repeatY });
  return new THREE.MeshStandardMaterial({
    map: pbr.map,
    normalMap: pbr.normalMap,
    normalScale: new THREE.Vector2(quality === 'high' ? 0.95 : 0.65, quality === 'high' ? 0.95 : 0.65),
    roughnessMap: quality === 'high' ? pbr.armMap : null,
    color: new THREE.Color(tint),
    roughness,
    metalness: 0.02,
  });
}

function createStonePbrMat(
  tint: string,
  quality: GraphicsQuality,
  repeatX = 2,
  repeatY = 2
): THREE.MeshStandardMaterial {
  const pbr = pbrAssets.getPbrSet('mossy_rock', quality, { repeatX, repeatY });
  return new THREE.MeshStandardMaterial({
    map: pbr.map,
    normalMap: pbr.normalMap,
    normalScale: new THREE.Vector2(quality === 'high' ? 1.15 : 0.75, quality === 'high' ? 1.15 : 0.75),
    roughnessMap: quality === 'high' ? pbr.armMap : null,
    color: new THREE.Color(tint),
    roughness: 0.94,
    metalness: 0.02,
  });
}

function createGroundedRockMat(
  tint: string,
  quality: GraphicsQuality,
  site: SiteId,
  weather: WeatherId,
  repeatX = 2,
  repeatY = 2
): THREE.MeshStandardMaterial {
  const mat = createStonePbrMat(tint, quality, repeatX, repeatY);
  applyGroundedRockShader(mat, site, weather);
  return mat;
}

/**
 * Builds an organically sculpted geological boulder/cobble geometry (replaces geometric D12 dodecahedrons):
 * - Subdivided icosahedron displaced with multi-frequency rock cleavage planes & strata ridges
 * - Broadened, subtly flattened lower belly so rocks seat deeply into terrain slopes without floating
 */
function buildSculptedBoulderGeometry(
  radius: number,
  detail: number,
  variant = 0
): THREE.BufferGeometry {
  const geo = new THREE.IcosahedronGeometry(radius, detail);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();

  // Deterministic per-variant cleavage plane orientations & phase shifts
  const p1 = variant * 1.93 + 0.7;
  const p2 = variant * 2.71 + 1.4;
  const p3 = variant * 3.47 + 2.1;

  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const len = v.length() || 1;
    const nx = v.x / len;
    const ny = v.y / len;
    const nz = v.z / len;

    // Multi-frequency geological ridges & stratified cleavage facets
    const strata =
      Math.sin(nx * 2.6 + p1) * Math.cos(nz * 2.4 - p2) * 0.14 +
      Math.sin(ny * 4.4 + nx * 2.2 + p3) * 0.075 +
      Math.cos((nx - nz) * 5.2 + ny * 3.1 + p1) * 0.055;

    // Directional angular bevels (gives real stone shoulders instead of a lumpy potato)
    const ledgeA = Math.abs(nx * 0.72 + ny * 0.55 - nz * 0.42);
    const ledgeB = Math.abs(-nx * 0.48 + ny * 0.62 + nz * 0.62);
    const chisel = -Math.max(0, ledgeA - 0.62) * 0.24 - Math.max(0, ledgeB - 0.64) * 0.2;

    // Asymmetric elongation per variant
    const stretchX = variant % 2 === 0 ? 1.08 : 0.96;
    const stretchZ = variant % 2 === 0 ? 0.94 : 1.09;
    let rScale = 1.0 + strata + chisel;
    rScale = THREE.MathUtils.clamp(rScale, 0.72, 1.24);

    let x = nx * radius * rScale * stretchX;
    let y = ny * radius * rScale;
    let z = nz * radius * rScale * stretchZ;

    // Flatten & broaden underside slightly so the boulder anchors solidly in soil
    if (ny < -0.18) {
      const underT = Math.min(1, (-ny - 0.18) / 0.82);
      y *= 1.0 - underT * 0.34;
      x *= 1.0 + underT * 0.08;
      z *= 1.0 + underT * 0.08;
    }

    pos.setXYZ(i, x, y, z);
  }

  geo.computeVertexNormals();
  ensureAoUv(geo);
  return geo;
}

function buildCabin(quality: GraphicsQuality): THREE.Group {
  const g = new THREE.Group();
  const wallMat = createWoodPbrMat('#a8724e', quality, 3, 2, 0.86);
  const roofMat = new THREE.MeshStandardMaterial({ color: '#39463b', roughness: 0.9, flatShading: quality !== 'high' });
  const trimMat = new THREE.MeshStandardMaterial({ color: '#d9cbb8', roughness: 0.75 });
  const windowMat = new THREE.MeshStandardMaterial({
    color: '#ffe194',
    emissive: '#f59e0b',
    emissiveIntensity: quality === 'high' ? 1.32 : 0.65,
    roughness: 0.16,
  });
  const stoneMat = createStonePbrMat('#9aa09a', quality, 2, 3);

  // Main cabin body
  const body = new THREE.Mesh(new THREE.BoxGeometry(8.2, 3.8, 6.2), wallMat);
  body.position.y = 1.9;
  body.castShadow = true;
  body.receiveShadow = true;
  g.add(body);

  // Steep PNW A-gable roof
  const roofShape = new THREE.Shape();
  roofShape.moveTo(-4.7, 0);
  roofShape.lineTo(0, 2.8);
  roofShape.lineTo(4.7, 0);
  roofShape.closePath();
  const roofGeo = new THREE.ExtrudeGeometry(roofShape, { depth: 7.4, bevelEnabled: false });
  roofGeo.translate(0, 0, -3.7);
  const roof = new THREE.Mesh(roofGeo, roofMat);
  roof.position.y = 3.7;
  roof.castShadow = true;
  roof.receiveShadow = true;
  g.add(roof);

  // Front porch deck & posts
  const porch = new THREE.Mesh(new THREE.BoxGeometry(8.2, 0.35, 1.8), wallMat);
  porch.position.set(0, 0.18, 3.9);
  porch.receiveShadow = true;
  g.add(porch);

  for (const px of [-3.6, -1.2, 1.2, 3.6]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.22, 3.2, 0.22), trimMat);
    post.position.set(px, 1.7, 4.6);
    post.castShadow = true;
    g.add(post);
  }
  const porchRoof = new THREE.Mesh(new THREE.BoxGeometry(8.6, 0.22, 2.2), roofMat);
  porchRoof.position.set(0, 3.35, 4.0);
  porchRoof.rotation.x = 0.22;
  porchRoof.castShadow = true;
  g.add(porchRoof);

  // Stone chimney
  const chimney = new THREE.Mesh(new THREE.BoxGeometry(1.1, 6.8, 1.1), stoneMat);
  chimney.position.set(3.2, 3.4, -1.5);
  chimney.castShadow = true;
  g.add(chimney);

  // Warm glowing windows & door
  for (const wx of [-2.3, 2.3]) {
    const win = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.3, 0.14), windowMat);
    win.position.set(wx, 2.1, 3.12);
    g.add(win);
    const sideWin = new THREE.Mesh(new THREE.BoxGeometry(0.14, 1.3, 1.5), windowMat);
    sideWin.position.set(4.12, 2.1, wx * 0.45);
    g.add(sideWin);
  }
  const door = new THREE.Mesh(new THREE.BoxGeometry(1.2, 2.3, 0.16), new THREE.MeshStandardMaterial({ color: '#472c1c', roughness: 0.8 }));
  door.position.set(0, 1.35, 3.12);
  g.add(door);

  return g;
}

function buildAFrame(quality: GraphicsQuality): THREE.Group {
  const g = new THREE.Group();
  const timberMat = createWoodPbrMat('#b88255', quality, 2, 2, 0.84);
  const deckMat = createWoodPbrMat('#c5986d', quality, 3, 3, 0.88);
  const roofMat = new THREE.MeshStandardMaterial({
    color: '#2c3538',
    roughness: 0.56,
    metalness: 0.34,
    flatShading: quality !== 'high',
  });
  const trimMat = new THREE.MeshStandardMaterial({ color: '#3b281c', roughness: 0.82 });
  const glassMat = new THREE.MeshStandardMaterial({
    color: '#ffe8ad',
    emissive: '#f59e0b',
    emissiveIntensity: quality === 'high' ? 1.25 : 0.62,
    roughness: 0.14,
    metalness: 0.18,
  });
  const stoneMat = createStonePbrMat('#beb9ab', quality, 2, 4);

  // Elevated cedar foundation deck (wraps out to a mountain view porch in front)
  const deck = new THREE.Mesh(new THREE.BoxGeometry(8.2, 0.45, 9.6), deckMat);
  deck.position.set(0, 0.225, 0.7);
  deck.castShadow = true;
  deck.receiveShadow = true;
  g.add(deck);

  // Steep iconic triangular A-frame body (interior wood gable walls)
  const bodyShape = new THREE.Shape();
  bodyShape.moveTo(-3.8, 0);
  bodyShape.lineTo(0, 6.9);
  bodyShape.lineTo(3.8, 0);
  bodyShape.closePath();
  const bodyGeo = new THREE.ExtrudeGeometry(bodyShape, { depth: 7.0, bevelEnabled: false });
  bodyGeo.translate(0, 0, -3.5);
  const body = new THREE.Mesh(bodyGeo, timberMat);
  body.position.y = 0.45;
  body.castShadow = true;
  body.receiveShadow = true;
  g.add(body);

  // Steep overhanging dark charcoal metal A-roof slopes reaching all the way to the deck
  const slopeLen = Math.hypot(4.25, 7.35);
  const slopeAngle = Math.atan2(7.35, 4.25);
  for (const side of [-1, 1]) {
    const roofPanel = new THREE.Mesh(new THREE.BoxGeometry(slopeLen, 0.24, 8.2), roofMat);
    roofPanel.position.set(side * 2.12, 0.45 + 3.68, 0);
    roofPanel.rotation.z = -side * slopeAngle;
    roofPanel.castShadow = true;
    roofPanel.receiveShadow = true;
    g.add(roofPanel);
  }

  // Metal ridge cap
  const ridgeCap = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.28, 8.3), roofMat);
  ridgeCap.position.set(0, 0.45 + 7.28, 0);
  g.add(ridgeCap);

  // Signature A-frame floor-to-peak warm glowing glass gable window (front & upper back)
  const triGlassShape = new THREE.Shape();
  triGlassShape.moveTo(-2.55, 0);
  triGlassShape.lineTo(0, 4.75);
  triGlassShape.lineTo(2.55, 0);
  triGlassShape.closePath();
  const triGlassGeo = new THREE.ShapeGeometry(triGlassShape);
  const frontGlass = new THREE.Mesh(triGlassGeo, glassMat);
  frontGlass.position.set(0, 1.55, 3.53);
  g.add(frontGlass);

  const backGlass = new THREE.Mesh(triGlassGeo, glassMat);
  backGlass.position.set(0, 1.55, -3.53);
  backGlass.rotation.y = Math.PI;
  g.add(backGlass);

  // Heavy dark timber mullions across the glass facade
  for (const zSign of [1, -1]) {
    const zPos = zSign * 3.56;
    const centerMullion = new THREE.Mesh(new THREE.BoxGeometry(0.16, 4.85, 0.14), trimMat);
    centerMullion.position.set(0, 3.95, zPos);
    g.add(centerMullion);

    const midBar = new THREE.Mesh(new THREE.BoxGeometry(3.8, 0.16, 0.14), trimMat);
    midBar.position.set(0, 2.9, zPos);
    g.add(midBar);

    const upperBar = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.14, 0.14), trimMat);
    upperBar.position.set(0, 4.5, zPos);
    g.add(upperBar);
  }

  // Timber entry door below the front glass
  const door = new THREE.Mesh(new THREE.BoxGeometry(1.15, 2.05, 0.16), trimMat);
  door.position.set(0, 1.48, 3.54);
  g.add(door);

  // Front deck railings
  for (const px of [-3.7, -1.85, 1.85, 3.7]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.16, 1.0, 0.16), trimMat);
    post.position.set(px, 0.95, 5.25);
    post.castShadow = true;
    g.add(post);
  }
  const leftRail = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.1, 0.12), trimMat);
  leftRail.position.set(-2.75, 1.38, 5.25);
  g.add(leftRail);
  const rightRail = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.1, 0.12), trimMat);
  rightRail.position.set(2.75, 1.38, 5.25);
  g.add(rightRail);

  // Tall Rockies river-stone chimney rising alongside the roof slope
  const chimney = new THREE.Mesh(new THREE.BoxGeometry(1.15, 7.6, 1.25), stoneMat);
  chimney.position.set(2.65, 3.85, -1.6);
  chimney.castShadow = true;
  g.add(chimney);

  return g;
}

function buildBarn(quality: GraphicsQuality): THREE.Group {
  const g = new THREE.Group();
  const barnMat = createWoodPbrMat('#b5463b', quality, 3, 2, 0.88);
  const trimMat = new THREE.MeshStandardMaterial({ color: '#ebe4d8', roughness: 0.75 });
  const roofMat = new THREE.MeshStandardMaterial({ color: '#4b555a', roughness: 0.58, metalness: 0.3 });

  const body = new THREE.Mesh(new THREE.BoxGeometry(9.2, 4.4, 6.6), barnMat);
  body.position.y = 2.2;
  body.castShadow = true;
  body.receiveShadow = true;
  g.add(body);

  // Gambrel barn roof
  const shape = new THREE.Shape();
  shape.moveTo(-5.0, 0);
  shape.lineTo(-3.4, 2.2);
  shape.lineTo(0, 3.4);
  shape.lineTo(3.4, 2.2);
  shape.lineTo(5.0, 0);
  shape.closePath();
  const roofGeo = new THREE.ExtrudeGeometry(shape, { depth: 7.4, bevelEnabled: false });
  roofGeo.translate(0, 0, -3.7);
  const roof = new THREE.Mesh(roofGeo, roofMat);
  roof.position.y = 4.35;
  roof.castShadow = true;
  g.add(roof);

  // Classic X-braced barn doors
  const doorFrame = new THREE.Mesh(new THREE.BoxGeometry(2.8, 3.2, 0.16), trimMat);
  doorFrame.position.set(0, 1.6, 3.32);
  g.add(doorFrame);
  const doorInner = new THREE.Mesh(new THREE.BoxGeometry(2.45, 2.9, 0.2), barnMat);
  doorInner.position.set(0, 1.6, 3.34);
  g.add(doorInner);

  return g;
}

function buildWoodshed(quality: GraphicsQuality): THREE.Group {
  const g = new THREE.Group();
  const woodMat = createWoodPbrMat('#9e724e', quality, 2, 2, 0.9);
  const roofMat = new THREE.MeshStandardMaterial({ color: '#4c5750', roughness: 0.68, metalness: 0.24 });

  // Back & side walls
  const back = new THREE.Mesh(new THREE.BoxGeometry(4.4, 2.6, 0.2), woodMat);
  back.position.set(0, 1.3, -1.6);
  back.castShadow = true;
  g.add(back);

  for (const sx of [-2.1, 2.1]) {
    const side = new THREE.Mesh(new THREE.BoxGeometry(0.2, 2.8, 3.4), woodMat);
    side.position.set(sx, 1.4, 0);
    side.castShadow = true;
    g.add(side);
  }

  // Slanted tin roof
  const roof = new THREE.Mesh(new THREE.BoxGeometry(5.1, 0.18, 4.1), roofMat);
  roof.position.set(0, 2.95, 0.05);
  roof.rotation.x = -0.18;
  roof.castShadow = true;
  g.add(roof);

  // Stacked firewood rounds inside!
  const logMat = new THREE.MeshStandardMaterial({ color: '#b98355', roughness: 0.85 });
  const logGeo = new THREE.CylinderGeometry(0.16, 0.16, 1.0, 7);
  logGeo.rotateX(Math.PI / 2);
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 8; col++) {
      const log = new THREE.Mesh(logGeo, logMat);
      log.position.set(-1.5 + col * 0.42 + (row % 2) * 0.14, 0.2 + row * 0.28, -0.8);
      g.add(log);
    }
  }

  return g;
}

function buildPickupTruck(quality: GraphicsQuality): THREE.Group {
  const g = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color: '#2b4f3e', roughness: 0.42, metalness: 0.35 });
  const glassMat = new THREE.MeshStandardMaterial({ color: '#9ec5d6', roughness: 0.15, metalness: 0.5 });
  const wheelMat = new THREE.MeshStandardMaterial({ color: '#1f2326', roughness: 0.9 });
  const chromeMat = new THREE.MeshStandardMaterial({ color: '#d4d8dc', roughness: 0.25, metalness: 0.8 });

  // Lower chassis / bed / hood
  const lower = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.85, 4.8), bodyMat);
  lower.position.y = 0.82;
  lower.castShadow = true;
  g.add(lower);

  // Cab
  const cab = new THREE.Mesh(new THREE.BoxGeometry(1.96, 0.82, 1.85), bodyMat);
  cab.position.set(0, 1.58, 0.35);
  cab.castShadow = true;
  g.add(cab);

  // Windshield & rear glass
  const glass = new THREE.Mesh(new THREE.BoxGeometry(1.82, 0.58, 1.92), glassMat);
  glass.position.set(0, 1.6, 0.35);
  g.add(glass);

  // Bumpers
  const frontBumper = new THREE.Mesh(new THREE.BoxGeometry(2.15, 0.24, 0.22), chromeMat);
  frontBumper.position.set(0, 0.52, 2.42);
  g.add(frontBumper);

  // Wheels
  const wGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.32, 14);
  wGeo.rotateZ(Math.PI / 2);
  for (const [wx, wz] of [
    [-1.02, 1.45],
    [1.02, 1.45],
    [-1.02, -1.45],
    [1.02, -1.45],
  ]) {
    const w = new THREE.Mesh(wGeo, wheelMat);
    w.position.set(wx, 0.42, wz);
    w.castShadow = true;
    g.add(w);
  }

  // Upgrade seamlessly to photorealistic CC0 crew-cab pickup GLB (procedural mesh acts as instant fallback)
  attachPropModel(g, 'truck', quality);
  return g;
}

function buildGazebo(quality: GraphicsQuality): THREE.Group {
  const g = new THREE.Group();
  const cedarMat = createWoodPbrMat('#ad7b54', quality, 2, 2, 0.85);
  const roofMat = new THREE.MeshStandardMaterial({ color: '#3b4a42', roughness: 0.88, flatShading: quality !== 'high' });

  const deck = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 3.4, 0.45, 8), cedarMat);
  deck.position.y = 0.22;
  deck.receiveShadow = true;
  deck.castShadow = true;
  g.add(deck);

  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.12, 2.8, 6), cedarMat);
    post.position.set(Math.cos(a) * 2.8, 1.8, Math.sin(a) * 2.8);
    post.castShadow = true;
    g.add(post);
  }

  const roof = new THREE.Mesh(new THREE.ConeGeometry(3.85, 2.1, 8), roofMat);
  roof.position.y = 4.2;
  roof.castShadow = true;
  g.add(roof);

  return g;
}

function buildPowerPole(): THREE.Group {
  const g = new THREE.Group();
  const poleMat = new THREE.MeshStandardMaterial({ color: '#4d3c2e', roughness: 0.92 });
  const insMat = new THREE.MeshStandardMaterial({ color: '#cbd5e1', roughness: 0.3, metalness: 0.2 });

  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.22, 10.5, 10), poleMat);
  pole.position.y = 5.25;
  pole.castShadow = true;
  g.add(pole);

  const crossArm = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.18, 0.2), poleMat);
  crossArm.position.y = 9.6;
  crossArm.castShadow = true;
  g.add(crossArm);

  for (const ix of [-1.2, 0, 1.2]) {
    const ins = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 0.25, 8), insMat);
    ins.position.set(ix, 9.8, 0);
    g.add(ins);
  }
  return g;
}

function buildFence(length = 8.5): THREE.Group {
  const g = new THREE.Group();
  const railMat = new THREE.MeshStandardMaterial({ color: '#7e6651', roughness: 0.94 });
  const posts = 4;
  for (let i = 0; i < posts; i++) {
    const px = -length / 2 + (i / (posts - 1)) * length;
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 1.45, 6), railMat);
    post.position.set(px, 0.72, 0);
    post.castShadow = true;
    g.add(post);
  }
  for (const ry of [0.55, 1.08]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(length + 0.3, 0.12, 0.1), railMat);
    rail.position.set(0, ry, 0);
    rail.castShadow = true;
    g.add(rail);
  }
  return g;
}

function hashSaplingSeed(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 2147483646 || 1;
}

/**
 * Young protected conifer: a slim leader with layered botanical needle whorls
 * (cedar, fir, redwood, or larch) instead of stacked green cones.
 */
function buildProtectedSapling(
  species: SpeciesId,
  quality: GraphicsQuality,
  seed: number,
  windUniforms?: FoliageWindUniforms
): THREE.Group {
  const g = new THREE.Group();
  const rand = makeRng(seed);
  const spec = PNW_SPECIES[species] ?? PNW_SPECIES.western_red_cedar;
  const resolved = spec.category === 'conifer' ? spec.id : 'western_red_cedar';

  const barkMat = new THREE.MeshStandardMaterial({
    color: spec.barkPrimary,
    roughness: 0.88,
    metalness: 0.02,
  });
  const leaderH = 2.15 + rand() * 0.55;
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.028, 0.075, leaderH, 8),
    barkMat
  );
  trunk.position.y = leaderH * 0.5;
  trunk.castShadow = true;
  trunk.receiveShadow = true;
  g.add(trunk);

  const ctx = createTreeBotanicalContext(resolved, 'conifer', quality, barkMat, windUniforms);
  if (ctx) {
    const whorls = 5;
    for (let w = 0; w < whorls; w++) {
      const t = w / (whorls - 1);
      const y = leaderH * (0.22 + t * 0.7);
      // Wide feathered skirt at the base, tightening into a narrow leader spire
      const scale = THREE.MathUtils.lerp(0.5, 0.13, Math.pow(t, 1.15));
      const hFrac = THREE.MathUtils.lerp(0.06, 0.98, t);
      const spokes = t > 0.72 ? 1 : 2;
      const spin = rand() * Math.PI * 2;
      for (let s = 0; s < spokes; s++) {
        const a = spin + (s / spokes) * Math.PI * 2 + t * 0.7;
        const cluster = buildBotanicalFoliageCluster(
          ctx,
          scale,
          rand,
          false,
          new THREE.Vector3(Math.cos(a), 0, Math.sin(a)),
          hFrac
        );
        cluster.position.y = y;
        g.add(cluster);
      }
    }
  }

  const stakeWood = new THREE.MeshStandardMaterial({ color: '#6d5340', roughness: 0.92 });
  const flagMat = new THREE.MeshStandardMaterial({ color: '#e11d48', roughness: 0.55 });
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.4;
    const stake = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.028, 0.95, 6), stakeWood);
    stake.position.set(Math.cos(a) * 0.72, 0.42, Math.sin(a) * 0.72);
    stake.rotation.z = Math.cos(a) * 0.08;
    stake.rotation.x = -Math.sin(a) * 0.08;
    stake.castShadow = true;
    g.add(stake);
    const flag = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.07, 0.012), flagMat);
    flag.position.set(Math.cos(a) * 0.78, 0.86, Math.sin(a) * 0.78);
    flag.rotation.y = -a;
    g.add(flag);
  }

  return g;
}

function buildCoastalHouse(sidingColor = '#6b827b'): THREE.Group {
  const g = new THREE.Group();
  const sidingTex = textureCache.getWoodPlankTexture(sidingColor, 14);
  const wallMat = new THREE.MeshStandardMaterial({ map: sidingTex, roughness: 0.8 });
  const roofMat = new THREE.MeshStandardMaterial({ color: '#394048', roughness: 0.88, flatShading: true });
  const trimMat = new THREE.MeshStandardMaterial({ color: '#f3f1eb', roughness: 0.65 });
  const brickMat = new THREE.MeshStandardMaterial({ color: '#8a4c3d', roughness: 0.92 });
  const windowMat = new THREE.MeshStandardMaterial({
    color: '#ffe8a8',
    emissive: '#f59e0b',
    emissiveIntensity: 0.5,
    roughness: 0.18,
  });

  // Main Craftsman bungalow body
  const body = new THREE.Mesh(new THREE.BoxGeometry(8.4, 3.9, 6.4), wallMat);
  body.position.y = 1.95;
  body.castShadow = true;
  body.receiveShadow = true;
  g.add(body);

  // Crisp white corner trim & foundation plinth
  const base = new THREE.Mesh(new THREE.BoxGeometry(8.6, 0.45, 6.6), new THREE.MeshStandardMaterial({ color: '#7b8082', roughness: 0.95 }));
  base.position.y = 0.22;
  g.add(base);

  // Wide Craftsman gable roof
  const roofShape = new THREE.Shape();
  roofShape.moveTo(-4.9, 0);
  roofShape.lineTo(0, 2.5);
  roofShape.lineTo(4.9, 0);
  roofShape.closePath();
  const roofGeo = new THREE.ExtrudeGeometry(roofShape, { depth: 7.4, bevelEnabled: false });
  roofGeo.translate(0, 0, -3.7);
  const roof = new THREE.Mesh(roofGeo, roofMat);
  roof.position.y = 3.85;
  roof.castShadow = true;
  roof.receiveShadow = true;
  g.add(roof);

  // Front porch & white Craftsman columns
  const porch = new THREE.Mesh(new THREE.BoxGeometry(6.8, 0.35, 1.9), new THREE.MeshStandardMaterial({ color: '#777e80', roughness: 0.9 }));
  porch.position.set(0, 0.18, 4.05);
  porch.receiveShadow = true;
  g.add(porch);
  for (const px of [-2.9, -1.0, 1.0, 2.9]) {
    const col = new THREE.Mesh(new THREE.BoxGeometry(0.24, 3.0, 0.24), trimMat);
    col.position.set(px, 1.7, 4.75);
    col.castShadow = true;
    g.add(col);
  }
  const porchRoof = new THREE.Mesh(new THREE.BoxGeometry(7.2, 0.22, 2.3), roofMat);
  porchRoof.position.set(0, 3.32, 4.15);
  porchRoof.rotation.x = 0.18;
  porchRoof.castShadow = true;
  g.add(porchRoof);

  // Brick chimney
  const chimney = new THREE.Mesh(new THREE.BoxGeometry(0.95, 6.4, 0.95), brickMat);
  chimney.position.set(-3.1, 3.2, -1.4);
  chimney.castShadow = true;
  g.add(chimney);

  // Framed windows + front door
  for (const wx of [-2.4, 2.4]) {
    const frame = new THREE.Mesh(new THREE.BoxGeometry(1.65, 1.48, 0.12), trimMat);
    frame.position.set(wx, 2.15, 3.22);
    g.add(frame);
    const pane = new THREE.Mesh(new THREE.BoxGeometry(1.42, 1.25, 0.15), windowMat);
    pane.position.set(wx, 2.15, 3.24);
    g.add(pane);
    const sidePane = new THREE.Mesh(new THREE.BoxGeometry(0.15, 1.25, 1.45), windowMat);
    sidePane.position.set(4.22, 2.15, wx * 0.4);
    g.add(sidePane);
  }
  const door = new THREE.Mesh(new THREE.BoxGeometry(1.15, 2.35, 0.16), new THREE.MeshStandardMaterial({ color: '#7c342b', roughness: 0.72 }));
  door.position.set(0, 1.4, 3.22);
  g.add(door);

  return g;
}

function buildGreenhouse(): THREE.Group {
  const g = new THREE.Group();
  const frameMat = new THREE.MeshStandardMaterial({ color: '#8a5c3c', roughness: 0.85 });
  const glassMat = new THREE.MeshStandardMaterial({
    color: '#c9edf2',
    roughness: 0.15,
    metalness: 0.12,
    transparent: true,
    opacity: 0.48,
  });
  const plantMat = new THREE.MeshStandardMaterial({ color: '#3b8c3e', roughness: 0.8, flatShading: true });

  // Low cedar knee-wall base
  const base = new THREE.Mesh(new THREE.BoxGeometry(4.4, 0.75, 3.4), frameMat);
  base.position.y = 0.38;
  base.castShadow = true;
  base.receiveShadow = true;
  g.add(base);

  // Glass walls
  const walls = new THREE.Mesh(new THREE.BoxGeometry(4.25, 1.85, 3.25), glassMat);
  walls.position.y = 1.65;
  g.add(walls);

  // Glass gable roof
  const roofShape = new THREE.Shape();
  roofShape.moveTo(-2.2, 0);
  roofShape.lineTo(0, 1.25);
  roofShape.lineTo(2.2, 0);
  roofShape.closePath();
  const roofGeo = new THREE.ExtrudeGeometry(roofShape, { depth: 3.35, bevelEnabled: false });
  roofGeo.translate(0, 0, -1.675);
  const roof = new THREE.Mesh(roofGeo, glassMat);
  roof.position.y = 2.55;
  g.add(roof);

  // Timber frame corner posts & ridge beam
  for (const [cx, cz] of [
    [-2.15, -1.65],
    [2.15, -1.65],
    [-2.15, 1.65],
    [2.15, 1.65],
  ]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.14, 2.6, 0.14), frameMat);
    post.position.set(cx, 1.3, cz);
    post.castShadow = true;
    g.add(post);
  }
  const ridge = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.14, 3.45), frameMat);
  ridge.position.y = 3.8;
  g.add(ridge);

  // Tiny lush potted plants visible inside!
  for (let i = -1; i <= 1; i++) {
    const pot = new THREE.Mesh(new THREE.DodecahedronGeometry(0.36, 0), plantMat);
    pot.position.set(i * 1.15, 1.15, -0.7);
    g.add(pot);
    const pot2 = new THREE.Mesh(new THREE.DodecahedronGeometry(0.32, 0), plantMat);
    pot2.position.set(i * 1.1, 1.1, 0.75);
    g.add(pot2);
  }

  return g;
}

function buildPicketFence(length = 8.5): THREE.Group {
  const g = new THREE.Group();
  const whiteMat = new THREE.MeshStandardMaterial({ color: '#f1f2ee', roughness: 0.68 });
  const posts = Math.max(3, Math.round(length / 2.6) + 1);
  for (let i = 0; i < posts; i++) {
    const px = -length / 2 + (i / (posts - 1)) * length;
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.14, 1.28, 0.14), whiteMat);
    post.position.set(px, 0.64, 0);
    post.castShadow = true;
    g.add(post);
  }
  for (const ry of [0.36, 0.92]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(length, 0.08, 0.08), whiteMat);
    rail.position.set(0, ry, 0);
    g.add(rail);
  }
  const picketCount = Math.max(12, Math.round(length * 3.8));
  for (let i = 0; i < picketCount; i++) {
    const px = -length / 2 + 0.14 + (i / Math.max(1, picketCount - 1)) * (length - 0.28);
    const picket = new THREE.Mesh(new THREE.BoxGeometry(0.11, 1.16, 0.04), whiteMat);
    picket.position.set(px, 0.58, 0.04);
    picket.castShadow = true;
    g.add(picket);
  }
  return g;
}

function buildStationWagon(): THREE.Group {
  const g = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color: '#3b6d7c', roughness: 0.35, metalness: 0.28 });
  const glassMat = new THREE.MeshStandardMaterial({ color: '#9ec0cc', roughness: 0.18, metalness: 0.45 });
  const wheelMat = new THREE.MeshStandardMaterial({ color: '#222529', roughness: 0.88 });
  const rackMat = new THREE.MeshStandardMaterial({ color: '#2c3036', roughness: 0.6, metalness: 0.4 });

  // Lower body
  const chassis = new THREE.Mesh(new THREE.BoxGeometry(1.92, 0.72, 4.35), bodyMat);
  chassis.position.y = 0.68;
  chassis.castShadow = true;
  chassis.receiveShadow = true;
  g.add(chassis);

  // Wagon greenhouse cab
  const cab = new THREE.Mesh(new THREE.BoxGeometry(1.72, 0.68, 2.65), bodyMat);
  cab.position.set(0, 1.32, -0.35);
  cab.castShadow = true;
  g.add(cab);

  const glass = new THREE.Mesh(new THREE.BoxGeometry(1.76, 0.52, 2.38), glassMat);
  glass.position.set(0, 1.32, -0.32);
  g.add(glass);

  // PNW roof rack bars
  for (const rz of [-1.25, 0.45]) {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(1.56, 0.06, 0.08), rackMat);
    bar.position.set(0, 1.72, rz);
    g.add(bar);
  }

  // Wheels
  const wGeo = new THREE.CylinderGeometry(0.36, 0.36, 0.26, 14);
  wGeo.rotateZ(Math.PI / 2);
  for (const [wx, wz] of [
    [-0.92, 1.32],
    [0.92, 1.32],
    [-0.92, -1.32],
    [0.92, -1.32],
  ]) {
    const w = new THREE.Mesh(wGeo, wheelMat);
    w.position.set(wx, 0.36, wz);
    w.castShadow = true;
    g.add(w);
  }

  return g;
}

function buildHazardMesh(
  h: HazardSpec,
  quality: GraphicsQuality,
  windUniforms?: FoliageWindUniforms
): THREE.Group {
  let g: THREE.Group;
  switch (h.type) {
    case 'cabin':
      g = buildCabin(quality);
      break;
    case 'aframe':
      g = buildAFrame(quality);
      break;
    case 'house':
      g = buildCoastalHouse();
      break;
    case 'greenhouse':
      g = buildGreenhouse();
      break;
    case 'picket_fence':
      g = buildPicketFence(h.width ?? 8.5);
      break;
    case 'car':
      g = buildStationWagon();
      break;
    case 'barn':
      g = buildBarn(quality);
      break;
    case 'shed':
      g = buildWoodshed(quality);
      break;
    case 'truck':
      g = buildPickupTruck(quality);
      break;
    case 'gazebo':
      g = buildGazebo(quality);
      break;
    case 'powerline':
      g = buildPowerPole();
      break;
    case 'fence':
      g = buildFence(h.width ?? 8.5);
      break;
    case 'sapling':
    default:
      g = buildProtectedSapling(
        h.species ?? 'western_red_cedar',
        quality,
        hashSaplingSeed(h.id),
        windUniforms
      );
      break;
  }
  g.position.set(h.x, 0, h.z);
  if (h.rotation) g.rotation.y = h.rotation;
  return g;
}

type GroundCoverSprigId =
  | 'ground_sword_fern'
  | 'ground_salal'
  | 'ground_bunchgrass'
  | 'ground_wildflowers_coastal'
  | 'ground_wildflowers_rockies';

const groundCoverTexCache = new Map<
  GroundCoverSprigId,
  { map: THREE.Texture; normalMap: THREE.Texture }
>();
const groundCoverLoader = new THREE.TextureLoader();

function getGroundCoverTextures(id: GroundCoverSprigId): {
  map: THREE.Texture;
  normalMap: THREE.Texture;
} {
  const existing = groundCoverTexCache.get(id);
  if (existing) return existing;

  const base = `./assets/foliage/${id}`;
  const map = groundCoverLoader.load(`${base}/sprig.webp`);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = THREE.ClampToEdgeWrapping;
  map.wrapT = THREE.ClampToEdgeWrapping;
  map.anisotropy = 4;

  const normalMap = groundCoverLoader.load(`${base}/nor.webp`);
  normalMap.colorSpace = THREE.NoColorSpace;
  normalMap.wrapS = THREE.ClampToEdgeWrapping;
  normalMap.wrapT = THREE.ClampToEdgeWrapping;
  normalMap.anisotropy = 4;

  const pair = { map, normalMap };
  groundCoverTexCache.set(id, pair);
  return pair;
}

function createGroundCoverMaterial(
  id: GroundCoverSprigId,
  quality: GraphicsQuality,
  windUniforms: FoliageWindUniforms,
  opts: {
    roughness?: number;
    normalScale?: number;
    alphaTest?: number;
    swayScale?: number;
    sssStrength?: number;
    baseAo?: number;
    tint?: string;
  } = {}
): THREE.MeshStandardMaterial {
  const { map, normalMap } = getGroundCoverTextures(id);
  const ns = (opts.normalScale ?? 0.58) * (quality === 'high' ? 1.0 : 0.72);
  const mat = new THREE.MeshStandardMaterial({
    map,
    normalMap,
    normalScale: new THREE.Vector2(ns, ns),
    color: new THREE.Color(opts.tint ?? '#ffffff'),
    roughness: opts.roughness ?? 0.76,
    metalness: 0.0,
    alphaTest: opts.alphaTest ?? 0.34,
    side: THREE.DoubleSide,
    envMapIntensity: quality === 'high' ? 0.42 : 0.65,
  });
  applyGroundCoverShader(mat, windUniforms, {
    swayScale: opts.swayScale ?? 1.0,
    sssStrength: opts.sssStrength ?? 0.36,
    baseAo: opts.baseAo ?? 0.54,
  });
  return mat;
}

/**
 * Helper: appends a softly cupped, arched botanical sprig card anchored at (baseX, baseY, baseZ)
 * with outward tilt, dome-biased normals, and clean UV mapping [uMin..uMax] x [0..1].
 */
function appendCurvedPlantCard(
  positions: number[],
  normals: number[],
  uvs: number[],
  indices: number[],
  opts: {
    yaw: number;
    width: number;
    height: number;
    leanOut: number;
    archDroop: number;
    cupDepth: number;
    baseRadius?: number;
    baseY?: number;
    uMin?: number;
    uMax?: number;
    segsV?: number;
    segsU?: number;
  }
): void {
  const segsV = opts.segsV ?? 4;
  const segsU = opts.segsU ?? 2;
  const uMin = opts.uMin ?? 0.0;
  const uMax = opts.uMax ?? 1.0;
  const baseRadius = opts.baseRadius ?? 0.0;
  const baseY = opts.baseY ?? -0.04;
  const cosY = Math.cos(opts.yaw);
  const sinY = Math.sin(opts.yaw);
  const baseIdx = positions.length / 3;

  for (let iv = 0; iv <= segsV; iv++) {
    const tv = iv / segsV;
    // Outward arch along frond/stem height + graceful tip droop
    const rOut = baseRadius + Math.pow(tv, 1.15) * opts.leanOut;
    const yCenter = baseY + tv * opts.height - tv * tv * opts.archDroop;

    for (let iu = 0; iu <= segsU; iu++) {
      const tu = iu / segsU;
      const sx = (tu - 0.5) * 2.0; // -1..+1 across card width
      const lx = sx * (opts.width * 0.5);
      // Gentle lateral cupping so leaves & clumps have genuine 3D volume
      const cup = (1.0 - sx * sx) * opts.cupDepth * Math.sin(tv * Math.PI);
      const lz = rOut + cup;

      const wx = lx * cosY + lz * sinY;
      const wz = -lx * sinY + lz * cosY;
      const wy = yCenter - sx * sx * opts.cupDepth * 0.35;

      positions.push(wx, wy, wz);

      // Upward-and-outward dome normal so crossed cards shade smoothly like real volume
      const nOut = 0.42 * tv + 0.16;
      const nx = (sx * 0.25 * cosY + nOut * sinY);
      const nz = (-sx * 0.25 * sinY + nOut * cosY);
      const ny = 0.88;
      const nLen = Math.hypot(nx, ny, nz) || 1;
      normals.push(nx / nLen, ny / nLen, nz / nLen);

      uvs.push(uMin + (uMax - uMin) * tu, tv);
    }
  }

  const rowStride = segsU + 1;
  for (let iv = 0; iv < segsV; iv++) {
    for (let iu = 0; iu < segsU; iu++) {
      const a = baseIdx + iv * rowStride + iu;
      const b = a + 1;
      const c = a + rowStride;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
}

function buildSwordFernGeometry(): THREE.BufferGeometry {
  // 8 gracefully arched, pinnate PNW sword-fern fronds radiating 360° (inner + outer whorl)
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  const frondCount = 8;
  for (let f = 0; f < frondCount; f++) {
    const isInner = f % 2 === 1;
    const yaw = (f / frondCount) * Math.PI * 2 + (isInner ? 0.14 : -0.06);
    const len = isInner ? 0.92 + (f % 3) * 0.08 : 1.12 + (f % 3) * 0.11;
    const archH = isInner ? 0.64 : 0.48;
    const frondHalfW = isInner ? 0.28 : 0.32;
    const segsV = 5;
    const segsU = 2;
    const cosY = Math.cos(yaw);
    const sinY = Math.sin(yaw);
    const baseIdx = positions.length / 3;

    for (let iv = 0; iv <= segsV; iv++) {
      const t = iv / segsV;
      const r = 0.05 + t * len;
      const y = -0.03 + Math.sin(t * Math.PI * 0.82) * archH;

      for (let iu = 0; iu <= segsU; iu++) {
        const tu = iu / segsU;
        const sx = (tu - 0.5) * 2.0; // -1..+1
        const sideW = sx * frondHalfW;
        // Subtle V-trough along the central fern rachis
        const vCup = Math.abs(sx) * 0.055 * Math.sin(t * Math.PI);

        const wx = r * cosY - sideW * sinY;
        const wz = r * sinY + sideW * cosY;
        const wy = y + vCup;

        positions.push(wx, wy, wz);
        // Upward-biased volumetric frond normal
        const nx = cosY * (0.28 * t) - sinY * (sx * 0.22);
        const nz = sinY * (0.28 * t) + cosY * (sx * 0.22);
        const ny = 0.92;
        const nLen = Math.hypot(nx, ny, nz) || 1;
        normals.push(nx / nLen, ny / nLen, nz / nLen);

        // Crop U tightly to the centered fern frond in ground-sword-fern.jpg (u in 0.26..0.74)
        uvs.push(0.26 + 0.48 * tu, 0.01 + 0.98 * t);
      }
    }

    const rowStride = segsU + 1;
    for (let iv = 0; iv < segsV; iv++) {
      for (let iu = 0; iu < segsU; iu++) {
        const a = baseIdx + iv * rowStride + iu;
        const b = a + 1;
        const c = a + rowStride;
        const d = c + 1;
        indices.push(a, c, b, b, c, d);
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  return geo;
}

function buildSalalShrubGeometry(): THREE.BufferGeometry {
  // 4 cupped, splayed evergreen Salal shrub sprigs forming a full 3D woodland bush
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  const cards = [
    { yaw: 0.12, width: 0.98, height: 0.78, leanOut: 0.26, archDroop: 0.12, cupDepth: 0.14, baseRadius: 0.06 },
    { yaw: 1.72, width: 0.94, height: 0.74, leanOut: 0.24, archDroop: 0.11, cupDepth: 0.13, baseRadius: 0.05 },
    { yaw: 3.31, width: 0.96, height: 0.80, leanOut: 0.25, archDroop: 0.13, cupDepth: 0.14, baseRadius: 0.06 },
    { yaw: 4.86, width: 0.86, height: 0.84, leanOut: 0.14, archDroop: 0.07, cupDepth: 0.11, baseRadius: 0.03 },
  ];
  for (const c of cards) {
    appendCurvedPlantCard(positions, normals, uvs, indices, { ...c, baseY: -0.05, segsV: 3, segsU: 2 });
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  return geo;
}

function buildBunchgrassGeometry(): THREE.BufferGeometry {
  // 3 gently cupped crossed-star cards of fine East Kootenay Bluebunch Wheatgrass & fescue
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (let i = 0; i < 3; i++) {
    const yaw = (i / 3) * Math.PI + (i === 1 ? 0.12 : -0.08);
    appendCurvedPlantCard(positions, normals, uvs, indices, {
      yaw,
      width: 0.95 + (i % 2) * 0.12,
      height: 0.74 + (i % 3) * 0.08,
      leanOut: 0.11,
      archDroop: 0.08,
      cupDepth: 0.11,
      baseRadius: 0.0,
      baseY: -0.06,
      segsV: 3,
      segsU: 2,
    });
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  return geo;
}

function buildWildflowerClumpGeometry(): THREE.BufferGeometry {
  // 3 softly cupped, staggered wildflower clump cards (replaces floating dodecahedron balls!)
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  const cards = [
    { yaw: 0.05, width: 0.82, height: 0.74, leanOut: 0.08, archDroop: 0.05, cupDepth: 0.09, baseRadius: 0.0 },
    { yaw: 1.12, width: 0.76, height: 0.68, leanOut: 0.10, archDroop: 0.06, cupDepth: 0.08, baseRadius: 0.02 },
    { yaw: 2.18, width: 0.80, height: 0.71, leanOut: 0.09, archDroop: 0.05, cupDepth: 0.09, baseRadius: 0.01 },
  ];
  for (const c of cards) {
    appendCurvedPlantCard(positions, normals, uvs, indices, { ...c, baseY: -0.06, segsV: 3, segsU: 2 });
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  return geo;
}

export function buildEnvironment(
  scene: THREE.Scene,
  contract: ContractSpec,
  quality: GraphicsQuality = 'high'
): BuiltEnvironment {
  const group = new THREE.Group();
  const rand = makeRng(contract.index * 7919 + 1337);
  const windAnimatedMeshes: THREE.Object3D[] = [];
  const effectUpdaters: Array<(elapsed: number, windSpeed: number, windAngle: number) => void> = [];

  // 1. Sky Dome + Regional Fog (crisp dry air in the Rockies so distant peaks read clearly)
  const { skyMesh, sunDir, fogColor, fogDensity, skyTop, skyHorizon, sunColor, updateSky } =
    createSkyDome(contract.weather, contract.site, quality);
  group.add(skyMesh);
  effectUpdaters.push((elapsed, windSpeed) => updateSky(elapsed, windSpeed));
  const fogScale = contract.site === 'kootenay_rockies' ? 0.56 : 0.88;
  const effectiveFogDensity = fogDensity * fogScale;
  scene.fog = new THREE.FogExp2(fogColor, effectiveFogDensity);
  scene.background = new THREE.Color(fogColor);

  // 2. Lighting Setup (Crisp Pacific Northwest sun + lush mossy bounce + sky fill)
  // On High detail, HDRI PMREM environment lighting supplies nuanced sky/ground bounce, so we
  // gently taper hemi fill so direct sun shadows keep dramatic AAA contrast!
  const hemiScale = quality === 'high' ? 0.72 : 1.0;
  const hemiColors: Record<WeatherId, [number, number, number]> = {
    sunny_morning: [0xd4ecff, 0x4f6e3f, 1.25],
    misty_fog: [0xdbe7ea, 0x4b6346, 1.3],
    light_rain: [0xb8ccd2, 0x3b523e, 1.18],
    golden_hour: [0xffe3bd, 0x5c633b, 1.18],
    coastal_gale: [0xb4cad6, 0x3e543f, 1.2],
  };
  const [skyCol, groundCol, hemiInt] = hemiColors[contract.weather];
  const hemiLight = new THREE.HemisphereLight(skyCol, groundCol, hemiInt * hemiScale);
  // Layer 1 lights the saw and cut guide when they are redrawn after the trunk-cut blur.
  hemiLight.layers.enable(1);
  group.add(hemiLight);

  const sunColors: Record<WeatherId, [number, number]> = {
    sunny_morning: [0xfff6dc, 2.45],
    misty_fog: [0xf4f7f0, 1.7],
    light_rain: [0xd3e2e8, 1.32],
    golden_hour: [0xffc67d, 2.75],
    coastal_gale: [0xe3eef2, 1.7],
  };
  const [sunCol, sunInt] = sunColors[contract.weather];
  const sunLight = new THREE.DirectionalLight(sunCol, sunInt);
  sunLight.layers.enable(1);
  sunLight.position.copy(sunDir).multiplyScalar(68);
  sunLight.castShadow = true;
  const shadowRes = quality === 'high' ? 4096 : 2048;
  sunLight.shadow.mapSize.width = shadowRes;
  sunLight.shadow.mapSize.height = shadowRes;
  sunLight.shadow.camera.near = 10;
  sunLight.shadow.camera.far = 160;
  const shadowExtent = 38;
  sunLight.shadow.camera.left = -shadowExtent;
  sunLight.shadow.camera.right = shadowExtent;
  sunLight.shadow.camera.top = shadowExtent;
  sunLight.shadow.camera.bottom = -shadowExtent;
  sunLight.shadow.bias = quality === 'high' ? -0.00035 : -0.0005;
  sunLight.shadow.normalBias = quality === 'high' ? 0.032 : 0.015;
  group.add(sunLight);

  // Soft opposite rim/fill light so shaded bark & evergreen needles stay rich and readable
  const fillLight = new THREE.DirectionalLight(
    contract.weather === 'light_rain' ? 0x99b8c6 : 0xaad0e6,
    (contract.weather === 'light_rain' ? 0.64 : 0.52) * (quality === 'high' ? 0.8 : 1.0)
  );
  fillLight.layers.enable(1);
  fillLight.position.copy(sunDir).multiplyScalar(-45);
  fillLight.position.y = 26;
  group.add(fillLight);

  // 3. Undulating Coastal PNW / Rockies Terrain with real CC0 PBR scans + anti-tiling shader
  const terrainProfile = SITE_TERRAIN_PROFILES[contract.site];
  const terrainSegs = quality === 'high' ? 128 : 96;
  const terrainGeo = new THREE.PlaneGeometry(240, 240, terrainSegs, terrainSegs);
  terrainGeo.rotateX(-Math.PI / 2);
  const tPos = terrainGeo.attributes.position;
  for (let i = 0; i < tPos.count; i++) {
    const x = tPos.getX(i);
    const z = tPos.getZ(i);
    tPos.setY(i, getTerrainHeight(x, z, contract.site));
  }
  terrainGeo.computeVertexNormals();
  ensureAoUv(terrainGeo);

  const terrainPbr = pbrAssets.getPbrSet(terrainProfile.textureId, quality, {
    repeatX: terrainProfile.repeat,
    repeatY: terrainProfile.repeat,
  });
  const isWetWeather = contract.weather === 'light_rain' || contract.weather === 'coastal_gale';
  const terrainMat = new THREE.MeshStandardMaterial({
    map: terrainPbr.map,
    normalMap: terrainPbr.normalMap,
    normalScale: new THREE.Vector2(
      terrainProfile.normalScale * (quality === 'high' ? 1.0 : 0.72),
      terrainProfile.normalScale * (quality === 'high' ? 1.0 : 0.72)
    ),
    roughnessMap: quality === 'high' ? terrainPbr.armMap : null,
    aoMap: quality === 'high' ? terrainPbr.armMap : null,
    aoMapIntensity: terrainProfile.aoIntensity,
    color: new THREE.Color(terrainProfile.tint),
    roughness: isWetWeather ? Math.max(0.68, terrainProfile.roughness - 0.18) : terrainProfile.roughness,
    metalness: isWetWeather ? 0.05 : 0.02,
  });
  if (quality === 'high') {
    applyTerrainDetailShader(terrainMat, contract.site, contract.weather);
  }
  const terrainMesh = new THREE.Mesh(terrainGeo, terrainMat);
  terrainMesh.receiveShadow = true;
  terrainMesh.userData = { part: 'ground' };
  group.add(terrainMesh);

  // 4. Site-Specific Landmarks (Driveway, Creek, Nurse Logs, Distant Inlet)
  const homesteadDriveway =
    contract.site === 'coastal_homestead' ? createHomesteadDrivewayCurve(contract) : null;
  let waterMesh: THREE.Mesh | undefined;
  const makeWaterMat = (fallbackHex: string, opacity: number, roughness: number) => {
    if (quality === 'high') {
      const animWater = createWaterShaderMaterial({
        site: contract.site,
        weather: contract.weather,
        sunDir,
        sunColor,
        skyHorizon,
        skyZenith: skyTop,
        fogColor: new THREE.Color(fogColor),
        fogDensity: effectiveFogDensity,
        windSpeed: contract.windSpeed,
      });
      effectUpdaters.push((elapsed) => animWater.update(elapsed));
      return animWater.material;
    }
    return new THREE.MeshStandardMaterial({
      color: fallbackHex,
      roughness,
      metalness: 0.48,
      transparent: opacity < 0.99,
      opacity,
    });
  };

  if (contract.site === 'coastal_homestead' && homesteadDriveway) {
    // Winding rural PNW gravel lane with rounded homestead turnaround, compacted wheel ruts,
    // alpha-feathered mossy gravel verges, river-cobble curb edges, and rustic cedar bollards
    const dSlices = quality === 'high' ? 148 : 104;
    // Cross-section from west mossy verge -> compacted gravel wheel tracks -> crowned center -> east verge
    const dProfile: Array<{
      wMult: number;
      yLift: number;
      alpha: number;
      col: [number, number, number];
    }> = [
      { wMult: -1.36, yLift: 0.014, alpha: 0.0, col: [0.58, 0.59, 0.48] }, // feathered outer mossy verge
      { wMult: -1.04, yLift: 0.028, alpha: 0.82, col: [0.74, 0.72, 0.62] }, // loose gravel shoulder
      { wMult: -0.78, yLift: 0.036, alpha: 1.0, col: [0.85, 0.83, 0.76] }, // outer lane gravel
      { wMult: -0.44, yLift: 0.032, alpha: 1.0, col: [0.76, 0.74, 0.68] }, // compacted west wheel track
      { wMult: 0.0, yLift: 0.044, alpha: 1.0, col: [0.82, 0.82, 0.72] }, // slightly mossy crowned center ridge
      { wMult: 0.44, yLift: 0.032, alpha: 1.0, col: [0.76, 0.74, 0.68] }, // compacted east wheel track
      { wMult: 0.78, yLift: 0.036, alpha: 1.0, col: [0.85, 0.83, 0.76] }, // outer lane gravel
      { wMult: 1.04, yLift: 0.028, alpha: 0.82, col: [0.74, 0.72, 0.62] }, // loose gravel shoulder
      { wMult: 1.36, yLift: 0.014, alpha: 0.0, col: [0.58, 0.59, 0.48] }, // feathered outer mossy verge
    ];
    const dCols = dProfile.length;
    const dPos: number[] = [];
    const dUvs: number[] = [];
    const dColors: number[] = [];
    const dAlphas: number[] = [];
    const dIndices: number[] = [];

    // Sample more densely around the curved north turnaround cap so the rounded cul-de-sac is buttery smooth
    const zSamples: number[] = [];
    const capSlices = 18;
    for (let i = 0; i < capSlices; i++) {
      const t = i / capSlices;
      // Cosine spacing concentrates slices right around the semicircular tip at zMin
      const z = homesteadDriveway.zMin + (1 - Math.cos(t * Math.PI * 0.5)) * (-4.5 - homesteadDriveway.zMin);
      zSamples.push(z);
    }
    const mainSlices = dSlices - capSlices;
    for (let i = 0; i <= mainSlices; i++) {
      const t = i / mainSlices;
      zSamples.push(-4.5 + (homesteadDriveway.zMax - -4.5) * t);
    }

    let dArc = 0;
    let prevDx = homesteadDriveway.centerX(zSamples[0]);
    let prevDz = zSamples[0];

    for (let i = 0; i < zSamples.length; i++) {
      const cz = zSamples[i];
      const cx = homesteadDriveway.centerX(cz);
      const hw = homesteadDriveway.halfWidth(cz);
      const sl = homesteadDriveway.slope(cz);
      if (i > 0) {
        dArc += Math.hypot(cx - prevDx, cz - prevDz);
      }
      prevDx = cx;
      prevDz = cz;

      // Tangent along +Z is (sl, 1); perpendicular pointing east (+X) is (1, -sl) / hypot(1, sl)
      const invL = 1 / Math.hypot(1, sl);
      const nx = 1 * invL;
      const nz = -sl * invL;
      // Softly feather the semicircular north turnaround tip as well
      const tipFade = THREE.MathUtils.smoothstep(cz, homesteadDriveway.zMin, homesteadDriveway.zMin + 0.55);

      for (let j = 0; j < dCols; j++) {
        const dp = dProfile[j];
        const off = dp.wMult * hw;
        const px = cx + nx * off;
        const pz = cz + nz * off;
        const groundY = getTerrainHeight(px, pz, contract.site);
        dPos.push(px, groundY + dp.yLift, pz);
        dUvs.push((dp.wMult * 0.5 + 0.5) * 1.4, dArc * 0.28);
        dColors.push(dp.col[0], dp.col[1], dp.col[2]);
        dAlphas.push(dp.alpha * tipFade);
      }

      if (i < zSamples.length - 1) {
        const r0 = i * dCols;
        const r1 = (i + 1) * dCols;
        for (let j = 0; j < dCols - 1; j++) {
          // +X (j) x +Z (i) gives -Y, so wind (r0+j, r1+j, r0+j+1) for +Y upward normal
          dIndices.push(r0 + j, r1 + j, r0 + j + 1);
          dIndices.push(r0 + j + 1, r1 + j, r1 + j + 1);
        }
      }
    }

    const driveGeo = new THREE.BufferGeometry();
    driveGeo.setAttribute('position', new THREE.Float32BufferAttribute(dPos, 3));
    driveGeo.setAttribute('uv', new THREE.Float32BufferAttribute(dUvs, 2));
    driveGeo.setAttribute('color', new THREE.Float32BufferAttribute(dColors, 3));
    driveGeo.setAttribute('aVergeAlpha', new THREE.Float32BufferAttribute(dAlphas, 1));
    driveGeo.setIndex(dIndices);
    driveGeo.computeVertexNormals();
    ensureAoUv(driveGeo);

    const gravelPbr = pbrAssets.getPbrSet('gravel_road', quality, { repeatX: 1, repeatY: 1 });
    const gravelMat = new THREE.MeshStandardMaterial({
      map: gravelPbr.map,
      normalMap: gravelPbr.normalMap,
      normalScale: new THREE.Vector2(quality === 'high' ? 0.78 : 0.62, quality === 'high' ? 0.78 : 0.62),
      roughnessMap: quality === 'high' ? gravelPbr.armMap : null,
      color: new THREE.Color(isWetWeather ? '#a2a098' : '#cec7b8'),
      vertexColors: true,
      roughness: isWetWeather ? 0.78 : 0.94,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    gravelMat.customProgramCacheKey = () => 'homestead-driveway-verge-v1';
    gravelMat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
          attribute float aVergeAlpha;
          varying float vVergeAlpha;
          varying vec3 vDriveWorldPos;`
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          vVergeAlpha = aVergeAlpha;`
        )
        .replace(
          '#include <worldpos_vertex>',
          `#include <worldpos_vertex>
          vDriveWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
          varying float vVergeAlpha;
          varying vec3 vDriveWorldPos;
          float dHash(vec2 p) {
            p = fract(p * vec2(127.1, 311.7));
            p += dot(p, p + 19.19);
            return fract(p.x * p.y);
          }
          float dNoise(vec2 p) {
            vec2 i = floor(p);
            vec2 f = fract(p);
            vec2 u = f * f * (3.0 - 2.0 * f);
            return mix(
              mix(dHash(i), dHash(i + vec2(1.0, 0.0)), u.x),
              mix(dHash(i + vec2(0.0, 1.0)), dHash(i + vec2(1.0, 1.0)), u.x),
              u.y
            );
          }`
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
          // Organic gravel-edge breakup so the rural verge dissolves naturally into moss & grass
          float edgeN = dNoise(vDriveWorldPos.xz * 2.4) * 0.55 + dNoise(vDriveWorldPos.xz * 6.8) * 0.45;
          float feathered = smoothstep(0.08, 0.72, vVergeAlpha + (edgeN - 0.5) * 0.34);
          diffuseColor.a *= feathered;
          if (diffuseColor.a < 0.02) discard;`
        );
    };

    const drive = new THREE.Mesh(driveGeo, gravelMat);
    drive.receiveShadow = true;
    group.add(drive);

    // Sensible rural driveway boundaries: low river-cobble border stones & weathered cedar edge bollards
    const curbStoneGeo = buildSculptedBoulderGeometry(0.34, quality === 'high' ? 2 : 1, 2);
    const curbStoneMat = createGroundedRockMat('#989e95', quality, contract.site, contract.weather, 1, 1);
    const maxCurbStones = quality === 'high' ? 88 : 56;
    const curbInst = new THREE.InstancedMesh(curbStoneGeo, curbStoneMat, maxCurbStones);
    curbInst.receiveShadow = true;
    const curbDummy = new THREE.Object3D();
    let curbIdx = 0;

    // Border stones curving around the north turnaround arc and lining the driveway shoulders
    for (let cz = -10.4; cz <= 36 && curbIdx < maxCurbStones; cz += 1.25 + rand() * 0.9) {
      const cx = homesteadDriveway.centerX(cz);
      const hw = homesteadDriveway.halfWidth(cz);
      if (hw < 0.8) continue;
      const sl = homesteadDriveway.slope(cz);
      const invL = 1 / Math.hypot(1, sl);
      const nx = 1 * invL;
      const nz = -sl * invL;
      for (const side of [-1, 1]) {
        if (curbIdx >= maxCurbStones || rand() < 0.32) continue;
        const off = side * (hw * (1.06 + rand() * 0.16));
        const sx = cx + nx * off + (rand() - 0.5) * 0.18;
        const sz = cz + nz * off + (rand() - 0.5) * 0.18;
        if (contract.hazards.some((h) => Math.hypot(h.x - sx, h.z - sz) < h.radius + 0.65)) continue;
        if (contract.trees.some((t) => Math.hypot(t.x - sx, t.z - sz) < 1.85)) continue;
        const sy = getTerrainHeight(sx, sz, contract.site);
        const rx = 0.55 + rand() * 0.58;
        const ry = 0.28 + rand() * 0.24;
        const rz = 0.5 + rand() * 0.52;
        curbDummy.position.set(sx, sy + ry * 0.22, sz);
        curbDummy.rotation.set((rand() - 0.5) * 0.28, rand() * Math.PI * 2, (rand() - 0.5) * 0.28);
        curbDummy.scale.set(rx, ry, rz);
        curbDummy.updateMatrix();
        curbInst.setMatrixAt(curbIdx++, curbDummy.matrix);
      }
    }
    curbInst.count = curbIdx;
    curbInst.instanceMatrix.needsUpdate = true;
    group.add(curbInst);

    // Low weathered rustic cedar driveway marker posts along key curves & turnaround
    const postMat = createWoodPbrMat('#755b43', quality, 1, 2, 0.92);
    const capMat = new THREE.MeshStandardMaterial({ color: '#c9a66b', roughness: 0.65 });
    const postGeo = new THREE.CylinderGeometry(0.08, 0.095, 0.72, 7);
    const capGeo = new THREE.CylinderGeometry(0.088, 0.088, 0.07, 7);
    for (const pzTarget of [-8.8, -4.5, 4.5, 13.5, 22.5, 31.5]) {
      const cx = homesteadDriveway.centerX(pzTarget);
      const hw = homesteadDriveway.halfWidth(pzTarget);
      if (hw < 1.2) continue;
      const sl = homesteadDriveway.slope(pzTarget);
      const invL = 1 / Math.hypot(1, sl);
      const nx = 1 * invL;
      const nz = -sl * invL;
      for (const side of [-1, 1]) {
        const off = side * (hw + 0.48);
        const px = cx + nx * off;
        const pz = pzTarget + nz * off;
        if (contract.hazards.some((h) => Math.hypot(h.x - px, h.z - pz) < h.radius + 0.9)) continue;
        if (contract.trees.some((t) => Math.hypot(t.x - px, t.z - pz) < 2.2)) continue;
        const py = getTerrainHeight(px, pz, contract.site);
        const postGroup = new THREE.Group();
        const post = new THREE.Mesh(postGeo, postMat);
        post.position.y = 0.34;
        post.castShadow = true;
        post.receiveShadow = true;
        postGroup.add(post);
        const band = new THREE.Mesh(capGeo, capMat);
        band.position.y = 0.62;
        postGroup.add(band);
        postGroup.position.set(px, py, pz);
        postGroup.rotation.set((rand() - 0.5) * 0.05, rand() * Math.PI * 2, (rand() - 0.5) * 0.05);
        group.add(postGroup);
      }
    }
  } else if (contract.site === 'misty_creek') {
    // 1) Meandering carved creek bed & wet riparian gravel/mud bank skirt extending past valley fog
    const xStart = -118;
    const xEnd = 118;
    const slices = quality === 'high' ? 168 : 112;

    // Cross-section profile from outer north bank -> deep thalweg -> outer south bank
    // offsets are multiples of local half-width; yOffset defines smooth bank slope into streambed
    const bankProfile: Array<{ wMult: number; y: number; col: [number, number, number] }> = [
      { wMult: -1.55, y: 0.02, col: [0.36, 0.42, 0.29] }, // damp mossy outer bank lip
      { wMult: -1.22, y: 0.012, col: [0.30, 0.28, 0.22] }, // wet mud & pebble shoulder
      { wMult: -0.96, y: -0.09, col: [0.24, 0.23, 0.19] }, // darkened wet waterline pebbles
      { wMult: -0.58, y: -0.28, col: [0.22, 0.25, 0.21] }, // shallow submerged river cobble
      { wMult: 0.0, y: -0.46, col: [0.15, 0.20, 0.18] }, // deep thalweg channel bed
      { wMult: 0.58, y: -0.28, col: [0.22, 0.25, 0.21] },
      { wMult: 0.96, y: -0.09, col: [0.24, 0.23, 0.19] },
      { wMult: 1.22, y: 0.012, col: [0.30, 0.28, 0.22] },
      { wMult: 1.55, y: 0.02, col: [0.36, 0.42, 0.29] },
    ];
    const bCols = bankProfile.length;
    const bPositions: number[] = [];
    const bUvs: number[] = [];
    const bColors: number[] = [];
    const bIndices: number[] = [];

    // Water ribbon cross-section (spans slightly inside the wet pebble bank lip so alpha feather blends seamlessly)
    const wCross = [-1.06, -0.78, -0.42, 0.0, 0.42, 0.78, 1.06];
    const wCols = wCross.length;
    const wPositions: number[] = [];
    const wUvs: number[] = [];
    const wIndices: number[] = [];

    let arcLen = 0;
    let prevCx = xStart;
    let prevCz = getMistyCreekCenterZ(xStart);

    for (let i = 0; i <= slices; i++) {
      const s = i / slices;
      const cx = xStart + (xEnd - xStart) * s;
      const cz = getMistyCreekCenterZ(cx);
      const hw = getMistyCreekHalfWidth(cx);
      const slope = getMistyCreekSlope(cx);
      if (i > 0) {
        arcLen += Math.hypot(cx - prevCx, cz - prevCz);
      }
      prevCx = cx;
      prevCz = cz;

      // Unit normal pointing toward south (+Z) bank perpendicular to meandering centerline
      const invLen = 1 / Math.hypot(1, slope);
      const nx = -slope * invLen;
      const nz = 1 * invLen;

      for (let j = 0; j < bCols; j++) {
        const bp = bankProfile[j];
        const off = bp.wMult * hw;
        const px = cx + nx * off;
        const pz = cz + nz * off;
        // Blend outer lip smoothly onto terrain height so banks never float or clip
        const isOuterLip = j === 0 || j === bCols - 1;
        const py = isOuterLip ? Math.max(bp.y, getTerrainHeight(px, pz, contract.site) - 0.03) : bp.y;
        bPositions.push(px, py, pz);
        bUvs.push(arcLen * 0.24, j / (bCols - 1));
        bColors.push(bp.col[0], bp.col[1], bp.col[2]);
      }

      for (let j = 0; j < wCols; j++) {
        const off = wCross[j] * hw;
        const px = cx + nx * off;
        const pz = cz + nz * off;
        wPositions.push(px, -0.055, pz);
        wUvs.push(arcLen, j / (wCols - 1));
      }

      if (i < slices) {
        const bRow0 = i * bCols;
        const bRow1 = (i + 1) * bCols;
        for (let j = 0; j < bCols - 1; j++) {
          bIndices.push(bRow0 + j, bRow0 + j + 1, bRow1 + j);
          bIndices.push(bRow0 + j + 1, bRow1 + j + 1, bRow1 + j);
        }
        const wRow0 = i * wCols;
        const wRow1 = (i + 1) * wCols;
        for (let j = 0; j < wCols - 1; j++) {
          wIndices.push(wRow0 + j, wRow0 + j + 1, wRow1 + j);
          wIndices.push(wRow0 + j + 1, wRow1 + j + 1, wRow1 + j);
        }
      }
    }

    const bankGeo = new THREE.BufferGeometry();
    bankGeo.setAttribute('position', new THREE.Float32BufferAttribute(bPositions, 3));
    bankGeo.setAttribute('uv', new THREE.Float32BufferAttribute(bUvs, 2));
    bankGeo.setAttribute('color', new THREE.Float32BufferAttribute(bColors, 3));
    bankGeo.setIndex(bIndices);
    bankGeo.computeVertexNormals();
    ensureAoUv(bankGeo);

    const bankPbr = pbrAssets.getPbrSet('gravel_road', quality, { repeatX: 1, repeatY: 1 });
    const bankMat = new THREE.MeshStandardMaterial({
      map: bankPbr.map,
      normalMap: bankPbr.normalMap,
      normalScale: new THREE.Vector2(quality === 'high' ? 1.05 : 0.75, quality === 'high' ? 1.05 : 0.75),
      roughnessMap: quality === 'high' ? bankPbr.armMap : null,
      vertexColors: true,
      roughness: quality === 'high' ? 0.56 : 0.72,
      metalness: 0.03,
    });
    const bankMesh = new THREE.Mesh(bankGeo, bankMat);
    bankMesh.receiveShadow = true;
    group.add(bankMesh);

    // 2) Flowing meandering water surface following the exact carved stream channel
    const waterGeo = new THREE.BufferGeometry();
    waterGeo.setAttribute('position', new THREE.Float32BufferAttribute(wPositions, 3));
    waterGeo.setAttribute('uv', new THREE.Float32BufferAttribute(wUvs, 2));
    waterGeo.setIndex(wIndices);
    waterGeo.computeVertexNormals();
    const waterMat = makeWaterMat('#2c6e78', 0.88, 0.16);
    waterMesh = new THREE.Mesh(waterGeo, waterMat);
    waterMesh.receiveShadow = true;
    group.add(waterMesh);

    // 3) Natural riverbank cobbles, mossy edge boulders & mid-stream riffle stones framing the stream
    const bridgeX = 4.2;
    const bridgeZ = getMistyCreekCenterZ(bridgeX);
    const bridgeSlope = getMistyCreekSlope(bridgeX);
    const bridgeHalfW = getMistyCreekHalfWidth(bridgeX);

    const bankStoneGeo = buildSculptedBoulderGeometry(0.56, quality === 'high' ? 2 : 1, 1);
    const bankStoneMat = createGroundedRockMat('#919c8f', quality, contract.site, contract.weather, 1, 1);
    const maxBankStones = quality === 'high' ? 165 : 105;
    const bankStoneInst = new THREE.InstancedMesh(bankStoneGeo, bankStoneMat, maxBankStones);
    bankStoneInst.castShadow = true;
    bankStoneInst.receiveShadow = true;
    const stoneDummy = new THREE.Object3D();
    let stoneIdx = 0;

    // Clustered river cobbles & boulders hugging BOTH north (-1) and south (+1) shorelines
    for (let sx = -44; sx <= 46 && stoneIdx < maxBankStones - 12; sx += 0.95 + rand() * 0.85) {
      const cz = getMistyCreekCenterZ(sx);
      const hw = getMistyCreekHalfWidth(sx);
      const sl = getMistyCreekSlope(sx);
      const invL = 1 / Math.hypot(1, sl);
      const nx = -sl * invL;
      const nz = 1 * invL;

      for (const side of [-1, 1]) {
        if (stoneIdx >= maxBankStones - 12) break;
        // Organic gaps and clusters along the shoreline (denser near outer bends)
        if (rand() < 0.28) continue;
        // Leave clear footing right under the footbridge deck
        if (Math.abs(sx - bridgeX) < 1.9) continue;

        const bankJitter = 0.88 + rand() * 0.36;
        const bx = sx + nx * (side * hw * bankJitter) + (rand() - 0.5) * 0.35;
        const bz = cz + nz * (side * hw * bankJitter) + (rand() - 0.5) * 0.35;

        // Never place a bank rock on top of a hazard ring or tree trunk
        if (contract.hazards.some((h) => Math.hypot(h.x - bx, h.z - bz) < h.radius + 0.7)) continue;
        if (contract.trees.some((t) => Math.hypot(t.x - bx, t.z - bz) < 2.0)) continue;

        const isLargerBoulder = rand() < 0.26;
        const radX = isLargerBoulder ? 0.85 + rand() * 0.95 : 0.34 + rand() * 0.52;
        const radY = isLargerBoulder ? 0.42 + rand() * 0.42 : 0.18 + rand() * 0.26;
        const radZ = isLargerBoulder ? 0.75 + rand() * 0.85 : 0.32 + rand() * 0.48;
        const by = bankJitter < 1.0 ? -0.10 : -0.02;

        stoneDummy.position.set(bx, by + radY * 0.28, bz);
        stoneDummy.rotation.set((rand() - 0.5) * 0.35, rand() * Math.PI * 2, (rand() - 0.5) * 0.35);
        stoneDummy.scale.set(radX, radY, radZ);
        stoneDummy.updateMatrix();
        bankStoneInst.setMatrixAt(stoneIdx++, stoneDummy.matrix);
      }
    }

    // Occasional partially submerged mid-stream mossy riffle stones
    for (let sx = -32; sx <= 36 && stoneIdx < maxBankStones; sx += 5.5 + rand() * 5.0) {
      if (Math.abs(sx - bridgeX) < 3.4) continue;
      const cz = getMistyCreekCenterZ(sx);
      const hw = getMistyCreekHalfWidth(sx);
      const sl = getMistyCreekSlope(sx);
      const invL = 1 / Math.hypot(1, sl);
      const off = (rand() - 0.5) * hw * 0.95;
      const rx = sx - sl * invL * off;
      const rz = cz + invL * off;
      const radX = 0.75 + rand() * 0.85;
      const radY = 0.42 + rand() * 0.38;
      const radZ = 0.65 + rand() * 0.75;
      stoneDummy.position.set(rx, -0.22 + radY * 0.38, rz);
      stoneDummy.rotation.set((rand() - 0.5) * 0.3, rand() * Math.PI * 2, (rand() - 0.5) * 0.3);
      stoneDummy.scale.set(radX, radY, radZ);
      stoneDummy.updateMatrix();
      bankStoneInst.setMatrixAt(stoneIdx++, stoneDummy.matrix);
    }
    bankStoneInst.count = stoneIdx;
    bankStoneInst.instanceMatrix.needsUpdate = true;
    group.add(bankStoneInst);

    // 4) Rustic timber footbridge actually spanning the meandering creek perpendicular to its flow
    const bridgeGroup = new THREE.Group();
    const plankMat = createWoodPbrMat('#967152', quality, 2, 4, 0.9);
    const bridgeSpan = Math.max(6.4, bridgeHalfW * 2 + 2.4);
    const deck = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.24, bridgeSpan), plankMat);
    deck.position.y = 0.42;
    deck.castShadow = true;
    deck.receiveShadow = true;
    bridgeGroup.add(deck);
    // Timber posts & handrails on both sides
    for (const bx of [-1.15, 1.15]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, bridgeSpan), plankMat);
      rail.position.set(bx, 1.28, 0);
      rail.castShadow = true;
      bridgeGroup.add(rail);
      for (const pz of [-bridgeSpan * 0.44, 0, bridgeSpan * 0.44]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.14, 1.15, 0.14), plankMat);
        post.position.set(bx, 0.75, pz);
        post.castShadow = true;
        bridgeGroup.add(post);
      }
    }
    // Stone/timber bank abutments anchoring both ends of the bridge into the creek banks
    const abutMat = createStonePbrMat('#7c827b', quality, 1, 1);
    for (const endSign of [-1, 1]) {
      const abut = new THREE.Mesh(new THREE.BoxGeometry(3.0, 0.65, 0.95), abutMat);
      abut.position.set(0, 0.08, endSign * (bridgeSpan * 0.5 - 0.35));
      abut.receiveShadow = true;
      bridgeGroup.add(abut);
    }
    bridgeGroup.position.set(bridgeX, 0, bridgeZ);
    // Align bridge Z-axis perpendicular to local creek tangent (dx=1, dz=bridgeSlope)
    bridgeGroup.rotation.y = -Math.atan2(bridgeSlope, 1);
    group.add(bridgeGroup);
  } else if (contract.site === 'timber_ridge') {
    // Harvested stacked timber log deck at edge of landing with CC0 pine bark PBR
    const deckPbr = pbrAssets.getPbrSet('pine_bark', quality, { repeatX: 2, repeatY: 3 });
    const deckMat = new THREE.MeshStandardMaterial({
      map: deckPbr.map,
      normalMap: deckPbr.normalMap,
      normalScale: new THREE.Vector2(1.2, 1.2),
      roughnessMap: quality === 'high' ? deckPbr.armMap : null,
      color: new THREE.Color('#e2c8b4'),
      roughness: 0.92,
    });
    const logGeo = new THREE.CylinderGeometry(0.42, 0.46, 6.2, quality === 'high' ? 14 : 10);
    logGeo.rotateZ(Math.PI / 2);
    const deckGroup = new THREE.Group();
    for (let row = 0; row < 3; row++) {
      for (let i = 0; i < 4 - row; i++) {
        const log = new THREE.Mesh(logGeo, deckMat);
        log.position.set(0, 0.42 + row * 0.72, (i - (3 - row) / 2) * 0.88);
        log.castShadow = true;
        log.receiveShadow = true;
        deckGroup.add(log);
      }
    }
    deckGroup.position.set(-16.5, 0, -13.5);
    deckGroup.rotation.y = 0.55;
    group.add(deckGroup);
  } else if (contract.site === 'storm_bluff') {
    // Pacific coastal water swells beyond the storm bluff
    const oceanMat = makeWaterMat('#2c5368', 1.0, 0.24);
    const oceanGeo = new THREE.PlaneGeometry(240, 120, quality === 'high' ? 72 : 1, quality === 'high' ? 40 : 1);
    waterMesh = new THREE.Mesh(oceanGeo, oceanMat);
    waterMesh.rotation.x = -Math.PI / 2;
    waterMesh.position.set(60, -4.5, 65);
    group.add(waterMesh);
  } else if (contract.site === 'pacific_headland') {
    // 1) Shimmering Pacific Cove stretching out below the headland bluffs
    const oceanMat = makeWaterMat('#225e74', 1.0, 0.2);
    const oceanGeo = new THREE.PlaneGeometry(260, 150, quality === 'high' ? 80 : 1, quality === 'high' ? 48 : 1);
    waterMesh = new THREE.Mesh(oceanGeo, oceanMat);
    waterMesh.rotation.x = -Math.PI / 2;
    waterMesh.position.set(55, -4.2, 68);
    group.add(waterMesh);

    // 2) Sun-bleached coastal granite outcrops lining the headland bluff rim
    const outcropGeos = [
      buildSculptedBoulderGeometry(1.85, quality === 'high' ? 2 : 1, 0),
      buildSculptedBoulderGeometry(1.85, quality === 'high' ? 2 : 1, 1),
    ];
    const outcropMat = createGroundedRockMat('#b4b0a2', quality, contract.site, contract.weather, 2, 2);
    const outcropSpots: Array<[number, number, number, number]> = [
      [22.5, 13.5, 1.5, 0.9],
      [18.5, 22.0, 2.0, 1.1],
      [9.0, 24.5, 1.7, 0.85],
      [25.5, 3.5, 1.8, 1.0],
      [-2.5, 25.0, 1.5, 0.8],
      [28.0, 19.5, 2.4, 1.3],
      [14.0, 29.0, 2.3, 1.2],
    ];
    for (let oi = 0; oi < outcropSpots.length; oi++) {
      const [ox, oz, sx, sy] = outcropSpots[oi];
      const rock = new THREE.Mesh(outcropGeos[oi % outcropGeos.length], outcropMat);
      const oy = getTerrainHeight(ox, oz, contract.site);
      rock.position.set(ox, oy + sy * 0.22, oz);
      rock.scale.set(sx, sy, sx * (0.75 + rand() * 0.4));
      rock.rotation.set((rand() - 0.5) * 0.16, rand() * Math.PI * 2, (rand() - 0.5) * 0.16);
      rock.castShadow = true;
      rock.receiveShadow = true;
      group.add(rock);
    }

    // 3) Sandy coastal overlook trail ribbon curving around the seaward meadow edge
    const trailPbr = pbrAssets.getPbrSet('gravel_road', quality, { repeatX: 5, repeatY: 1 });
    const trailMat = new THREE.MeshStandardMaterial({
      map: trailPbr.map,
      normalMap: quality === 'high' ? trailPbr.normalMap : null,
      normalScale: new THREE.Vector2(0.85, 0.85),
      color: new THREE.Color('#c8ba98'),
      roughness: 0.96,
    });
    const trailPts = [
      new THREE.Vector2(-24, 18),
      new THREE.Vector2(-8, 19.5),
      new THREE.Vector2(8, 18.2),
      new THREE.Vector2(19.5, 11.5),
      new THREE.Vector2(22.5, -6),
    ];
    for (let i = 0; i < trailPts.length - 1; i++) {
      const a = trailPts[i];
      const b = trailPts[i + 1];
      const len = a.distanceTo(b);
      const seg = new THREE.Mesh(new THREE.PlaneGeometry(len + 0.8, 2.4), trailMat);
      seg.rotation.x = -Math.PI / 2;
      seg.rotation.z = -Math.atan2(b.y - a.y, b.x - a.x);
      seg.position.set((a.x + b.x) * 0.5, 0.03, (a.y + b.y) * 0.5);
      seg.receiveShadow = true;
      group.add(seg);
    }

    // Weathered driftwood-cedar overlook bench facing the Pacific cove
    const bench = new THREE.Group();
    const benchWood = createWoodPbrMat('#9d8a74', quality, 2, 1, 0.9);
    const seat = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.14, 0.65), benchWood);
    seat.position.y = 0.56;
    seat.castShadow = true;
    bench.add(seat);
    for (const lx of [-0.9, 0.9]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.54, 0.55), benchWood);
      leg.position.set(lx, 0.27, 0);
      leg.castShadow = true;
      bench.add(leg);
    }
    bench.position.set(17.5, 0, 15.5);
    bench.rotation.y = -0.68;
    group.add(bench);
  } else if (contract.site === 'kootenay_rockies') {
    // 1) Distant Rocky Mountain Panorama: serrated limestone/granite peaks with snow-dusted ridges!
    const rockPeakMat = new THREE.MeshStandardMaterial({
      color: '#6b7785',
      roughness: 0.94,
      metalness: 0.02,
      flatShading: true,
    });
    const farPeakMat = new THREE.MeshStandardMaterial({
      color: '#7d8fa2',
      roughness: 0.95,
      metalness: 0.02,
      flatShading: true,
    });
    const snowCapMat = new THREE.MeshStandardMaterial({
      color: '#edf4f9',
      roughness: 0.82,
      metalness: 0.04,
      flatShading: true,
    });

    const mountainArc: Array<{
      angle: number;
      dist: number;
      radius: number;
      height: number;
      snow: boolean;
      far?: boolean;
    }> = [
      // Dramatic main East Kootenay Rockies wall along the northern & eastern skyline
      { angle: -2.85, dist: 162, radius: 42, height: 82, snow: true },
      { angle: -2.42, dist: 168, radius: 48, height: 96, snow: true, far: true },
      { angle: -2.02, dist: 158, radius: 44, height: 88, snow: true },
      { angle: -1.62, dist: 172, radius: 52, height: 112, snow: true, far: true },
      { angle: -1.22, dist: 160, radius: 46, height: 98, snow: true },
      { angle: -0.82, dist: 170, radius: 50, height: 106, snow: true, far: true },
      { angle: -0.42, dist: 158, radius: 42, height: 84, snow: true },
      { angle: 0.0, dist: 166, radius: 44, height: 78, snow: true, far: true },
      // Purcell range across the southern & western horizon so distant peaks crown every vista
      { angle: 0.48, dist: 164, radius: 46, height: 74, snow: true },
      { angle: 1.0, dist: 170, radius: 48, height: 82, snow: true, far: true },
      { angle: 1.55, dist: 162, radius: 44, height: 70, snow: true },
      { angle: 2.12, dist: 168, radius: 46, height: 78, snow: true, far: true },
      { angle: 2.65, dist: 160, radius: 42, height: 72, snow: true },
    ];

    for (const pk of mountainArc) {
      const mtnGroup = new THREE.Group();
      const baseGeo = new THREE.ConeGeometry(pk.radius, pk.height, 7);
      // Perturb cone vertices subtly for craggy Rockies limestone strata & ridges
      const pos = baseGeo.attributes.position;
      for (let v = 0; v < pos.count; v++) {
        const vx = pos.getX(v);
        const vy = pos.getY(v);
        const vz = pos.getZ(v);
        const hNorm = (vy + pk.height * 0.5) / pk.height;
        if (hNorm < 0.96) {
          const crag = 0.82 + Math.sin(vx * 0.17 + pk.angle * 5) * 0.16 + Math.cos(vz * 0.14) * 0.12;
          pos.setXYZ(v, vx * crag, vy, vz * crag);
        }
      }
      baseGeo.computeVertexNormals();
      const peakMesh = new THREE.Mesh(baseGeo, pk.far ? farPeakMat : rockPeakMat);
      peakMesh.position.y = pk.height * 0.5 - 8;
      mtnGroup.add(peakMesh);

      if (pk.snow) {
        const capH = pk.height * 0.36;
        const capR = pk.radius * 0.37;
        const capGeo = new THREE.ConeGeometry(capR, capH, 7);
        const capMesh = new THREE.Mesh(capGeo, snowCapMat);
        capMesh.position.y = pk.height - capH * 0.5 - 7.4;
        mtnGroup.add(capMesh);
      }

      // Secondary shoulder spur for natural alpine ridgeline silhouette
      const spurGeo = new THREE.ConeGeometry(pk.radius * 0.65, pk.height * 0.62, 6);
      const spur = new THREE.Mesh(spurGeo, pk.far ? farPeakMat : rockPeakMat);
      spur.position.set(pk.radius * 0.42, pk.height * 0.31 - 9, pk.radius * 0.18);
      mtnGroup.add(spur);

      mtnGroup.position.set(Math.cos(pk.angle) * pk.dist, 0, Math.sin(pk.angle) * pk.dist);
      mtnGroup.rotation.y = pk.angle + 0.4;
      group.add(mtnGroup);
    }

    // 2) Dusty ochre gravel mountain cabin track winding across the bunchgrass bench
    const trackPbr = pbrAssets.getPbrSet('gravel_road', quality, { repeatX: 5, repeatY: 1 });
    const trackMat = new THREE.MeshStandardMaterial({
      map: trackPbr.map,
      normalMap: quality === 'high' ? trackPbr.normalMap : null,
      normalScale: new THREE.Vector2(0.95, 0.95),
      color: new THREE.Color('#d2bb94'),
      roughness: 0.96,
    });
    const trackPts = [
      new THREE.Vector2(-24, 15.5),
      new THREE.Vector2(-10, 14.5),
      new THREE.Vector2(4, 16.0),
      new THREE.Vector2(18, 12.5),
      new THREE.Vector2(28, 4.5),
    ];
    for (let i = 0; i < trackPts.length - 1; i++) {
      const a = trackPts[i];
      const b = trackPts[i + 1];
      const len = a.distanceTo(b);
      const seg = new THREE.Mesh(new THREE.PlaneGeometry(len + 1.0, 2.8), trackMat);
      seg.rotation.x = -Math.PI / 2;
      seg.rotation.z = -Math.atan2(b.y - a.y, b.x - a.x);
      seg.position.set((a.x + b.x) * 0.5, 0.03, (a.y + b.y) * 0.5);
      seg.receiveShadow = true;
      group.add(seg);
    }

    // 3) Pale sun-warmed Rockies limestone outcrops along the rolling foothill benches
    const outcropGeos = [
      buildSculptedBoulderGeometry(1.9, quality === 'high' ? 2 : 1, 0),
      buildSculptedBoulderGeometry(1.9, quality === 'high' ? 2 : 1, 2),
    ];
    const outcropMat = createGroundedRockMat('#d2ccc0', quality, contract.site, contract.weather, 2, 2);
    const outcropSpots: Array<[number, number, number, number]> = [
      [-23.5, -16.5, 1.9, 1.0],
      [22.5, -14.5, 2.1, 1.15],
      [25.0, 9.5, 1.7, 0.85],
      [-21.5, 21.0, 2.0, 1.0],
      [8.5, -24.0, 2.3, 1.2],
      [-6.5, 26.5, 1.8, 0.9],
    ];
    for (let oi = 0; oi < outcropSpots.length; oi++) {
      const [ox, oz, sx, sy] = outcropSpots[oi];
      const rock = new THREE.Mesh(outcropGeos[oi % outcropGeos.length], outcropMat);
      const oy = getTerrainHeight(ox, oz, contract.site);
      rock.position.set(ox, oy + sy * 0.22, oz);
      rock.scale.set(sx, sy, sx * (0.75 + rand() * 0.4));
      rock.rotation.set((rand() - 0.5) * 0.16, rand() * Math.PI * 2, (rand() - 0.5) * 0.16);
      rock.castShadow = true;
      rock.receiveShadow = true;
      group.add(rock);
    }
  } else if (contract.site === 'coastal_town') {
    // 1) Coastal Town Asphalt Street running East-West along the front of the yards
    const roadMat = new THREE.MeshStandardMaterial({
      map: textureCache.getAsphaltTexture(),
      roughness: 0.9,
      metalness: 0.04,
    });
    const road = new THREE.Mesh(new THREE.PlaneGeometry(160, 6.8), roadMat);
    road.rotation.x = -Math.PI / 2;
    road.position.set(0, 0.03, 16.5);
    road.receiveShadow = true;
    group.add(road);

    // Pale coastal concrete sidewalks on both sides of the street
    const walkMat = new THREE.MeshStandardMaterial({ color: '#c4c7c2', roughness: 0.92 });
    for (const sz of [12.45, 20.55]) {
      const walk = new THREE.Mesh(new THREE.BoxGeometry(160, 0.08, 1.3), walkMat);
      walk.position.set(0, 0.04, sz);
      walk.receiveShadow = true;
      group.add(walk);
    }

    // 2) Backyard Garden Pond (ideal setting for pondside Weeping Willows!)
    const pondShape = new THREE.Shape();
    pondShape.absellipse(0, 0, 4.6, 3.5, 0, Math.PI * 2, false, 0.18);
    const pondGeo = new THREE.ShapeGeometry(pondShape, quality === 'high' ? 36 : 24);
    pondGeo.rotateX(-Math.PI / 2);
    const pondMat = makeWaterMat('#2c767c', 0.86, 0.14);
    waterMesh = new THREE.Mesh(pondGeo, pondMat);
    waterMesh.position.set(-11.5, 0.05, -9.5);
    waterMesh.receiveShadow = true;
    group.add(waterMesh);

    // River-cobble border around the backyard pond
    const cobbleGeo = new THREE.DodecahedronGeometry(0.42, quality === 'high' ? 1 : 0);
    const cobbleMat = createStonePbrMat('#a6aaa4', quality, 1, 1);
    if (quality !== 'high') cobbleMat.flatShading = true;
    for (let i = 0; i < 26; i++) {
      const a = (i / 26) * Math.PI * 2;
      const cob = new THREE.Mesh(cobbleGeo, cobbleMat);
      cob.position.set(
        -11.5 + Math.cos(a) * 4.75,
        0.1,
        -9.5 + Math.sin(a) * 3.65
      );
      cob.scale.set(1.15 + rand() * 0.5, 0.48 + rand() * 0.2, 1.0 + rand() * 0.45);
      cob.rotation.y = rand() * Math.PI * 2;
      cob.receiveShadow = true;
      group.add(cob);
    }

    // 3) Mid-background neighboring coastal Craftsman houses along the block
    const neighborSpecs: Array<{ x: number; z: number; rot: number; color: string }> = [
      { x: -29, z: 4.5, rot: 0.05, color: '#788894' },
      { x: 29, z: 3.5, rot: -0.08, color: '#8c7d68' },
      { x: -22, z: 28.5, rot: Math.PI - 0.06, color: '#6b827b' },
      { x: 2, z: 29.0, rot: Math.PI + 0.04, color: '#84706c' },
      { x: 26, z: 28.5, rot: Math.PI - 0.05, color: '#6d7f8c' },
    ];
    for (const ns of neighborSpecs) {
      const nh = buildCoastalHouse(ns.color);
      nh.position.set(ns.x, getTerrainHeight(ns.x, ns.z, contract.site), ns.z);
      nh.rotation.y = ns.rot;
      group.add(nh);
    }
  }

  // Shared GPU wind for ground cover and protected sapling foliage
  const groundWindUniforms: FoliageWindUniforms = {
    uTime: { value: 0 },
    uWindStrength: { value: contract.windSpeed },
    uWindDir: {
      value: new THREE.Vector2(Math.cos(contract.windAngle), Math.sin(contract.windAngle)),
    },
    uSunDir: { value: sunDir.clone().normalize() },
    uSunColor: { value: new THREE.Color(sunColor) },
  };
  effectUpdaters.push((elapsed, windSpeed, windAngle) => {
    groundWindUniforms.uTime.value = elapsed;
    groundWindUniforms.uWindStrength.value = windSpeed;
    groundWindUniforms.uWindDir.value.set(Math.cos(windAngle), Math.sin(windAngle));
  });

  // 5. Place Hazards & Subtle Warning Rings
  const hazardGroups = new Map<string, THREE.Group>();
  const hazardWarningRings: THREE.Mesh[] = [];

  const sceneOccluders: SceneOccluder[] = [];

  for (const h of contract.hazards) {
    const hGroup = buildHazardMesh(h, quality, groundWindUniforms);
    group.add(hGroup);
    hazardGroups.set(h.id, hGroup);
    sceneOccluders.push({
      rootGroup: hGroup,
      occlusionFade: 1,
      occlusionMaterials: collectOcclusionMaterials(hGroup),
    });

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(Math.max(1.2, h.radius - 0.22), h.radius + 0.08, 32),
      new THREE.MeshBasicMaterial({
        color: '#ef4444',
        transparent: true,
        opacity: 0.22,
        side: THREE.DoubleSide,
      })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(h.x, 0.06, h.z);
    group.add(ring);
    hazardWarningRings.push(ring);
  }

  // 6. Instanced Botanical Ground Cover (Alpha-tested curved foliage sprigs with GPU wind sway & SSS)
  const densityMult = quality === 'high' ? 1.45 : 1.0;
  const isRockies = contract.site === 'kootenay_rockies';
  const riparianReserve = contract.site === 'misty_creek' ? Math.round(58 * densityMult) : 0;
  const baseFernCount = Math.round((isRockies ? 340 : 280) * densityMult);
  const fernCount = baseFernCount + riparianReserve;
  const fernFrondGeo = isRockies ? buildBunchgrassGeometry() : buildSwordFernGeometry();
  const fernMat = createGroundCoverMaterial(
    isRockies ? 'ground_bunchgrass' : 'ground_sword_fern',
    quality,
    groundWindUniforms,
    {
      roughness: isRockies ? 0.86 : 0.70,
      normalScale: isRockies ? 0.52 : 0.64,
      alphaTest: isRockies ? 0.32 : 0.34,
      swayScale: isRockies ? 1.15 : 0.88,
      sssStrength: isRockies ? 0.16 : 0.44,
      baseAo: isRockies ? 0.60 : 0.68,
      tint: isRockies ? '#c2b688' : '#e6f2dc',
    }
  );
  const fernInst = new THREE.InstancedMesh(fernFrondGeo, fernMat, fernCount);
  fernInst.receiveShadow = true;

  const isGroundCoverBlocked = (fx: number, fz: number, allowTownLawn = false): boolean => {
    const onDriveway = Boolean(homesteadDriveway && homesteadDriveway.isOnDriveway(fx, fz, 0.75));
    const inCreek = contract.site === 'misty_creek' && isInMistyCreek(fx, fz, 0.95);
    const onTownRoad = contract.site === 'coastal_town' && fz > 11.2 && fz < 22.0;
    const inTownPond = contract.site === 'coastal_town' && Math.hypot((fx + 11.5) / 5.2, (fz + 9.5) / 4.2) < 1.05;
    const inTownCentralLawn = !allowTownLawn && contract.site === 'coastal_town' && Math.hypot(fx, fz) < 11.5;
    return (
      onDriveway ||
      inCreek ||
      onTownRoad ||
      inTownPond ||
      inTownCentralLawn ||
      contract.trees.some((t) => Math.hypot(t.x - fx, t.z - fz) < 2.15) ||
      contract.hazards.some((h) => Math.hypot(h.x - fx, h.z - fz) < h.radius + 1.05)
    );
  };

  const dummy = new THREE.Object3D();
  const fernColor = new THREE.Color();
  let fIdx = 0;
  for (let tries = 0; tries < Math.round(740 * densityMult) && fIdx < baseFernCount; tries++) {
    const angle = rand() * Math.PI * 2;
    const dist = 5.2 + rand() * 34;
    const fx = Math.cos(angle) * dist;
    const fz = Math.sin(angle) * dist;
    if (isGroundCoverBlocked(fx, fz)) continue;

    const fy = getTerrainHeight(fx, fz, contract.site);
    const s = isRockies ? 0.78 + rand() * 0.82 : 0.76 + rand() * 0.78;
    dummy.position.set(fx, fy, fz);
    dummy.rotation.set((rand() - 0.5) * 0.14, rand() * Math.PI * 2, (rand() - 0.5) * 0.14);
    dummy.scale.set(s, s * (0.86 + rand() * 0.34), s);
    dummy.updateMatrix();
    fernInst.setMatrixAt(fIdx, dummy.matrix);

    if (isRockies) {
      // Sun-cured golden ochre & dusty sage bunchgrass variation (keeps straw richly colored without HDR blowout)
      if (rand() > 0.34) {
        fernColor.setHSL(0.11 + (rand() - 0.5) * 0.03, 0.32 + rand() * 0.16, 0.62 + rand() * 0.16);
      } else {
        fernColor.setHSL(0.24 + (rand() - 0.5) * 0.04, 0.22 + rand() * 0.12, 0.56 + rand() * 0.15);
      }
    } else {
      // Rich sunlit emerald to lush woodland olive sword-fern variation
      fernColor.setHSL(0.29 + (rand() - 0.5) * 0.04, 0.20 + rand() * 0.14, 0.88 + rand() * 0.12);
    }
    fernInst.setColorAt(fIdx, fernColor);
    fIdx++;
  }
  if (contract.site === 'misty_creek') {
    // Lush riparian sword-fern tufts framing both outer mossy banks of the meandering creek
    for (let sx = -38; sx <= 38 && fIdx < fernCount; sx += 1.45 + rand() * 1.1) {
      if (Math.abs(sx - 4.2) < 2.2) continue;
      const cz = getMistyCreekCenterZ(sx);
      const hw = getMistyCreekHalfWidth(sx);
      const sl = getMistyCreekSlope(sx);
      const invL = 1 / Math.hypot(1, sl);
      const nx = -sl * invL;
      const nz = 1 * invL;
      for (const side of [-1, 1]) {
        if (fIdx >= fernCount || rand() < 0.35) continue;
        const bankOff = side * (hw + 1.15 + rand() * 1.45);
        const fx = sx + nx * bankOff;
        const fz = cz + nz * bankOff;
        if (contract.trees.some((t) => Math.hypot(t.x - fx, t.z - fz) < 2.0)) continue;
        if (contract.hazards.some((h) => Math.hypot(h.x - fx, h.z - fz) < h.radius + 0.9)) continue;
        const fy = getTerrainHeight(fx, fz, contract.site);
        const s = 0.84 + rand() * 0.74;
        dummy.position.set(fx, fy, fz);
        dummy.rotation.set((rand() - 0.5) * 0.14, rand() * Math.PI * 2, (rand() - 0.5) * 0.14);
        dummy.scale.set(s, s * (0.9 + rand() * 0.32), s);
        dummy.updateMatrix();
        fernInst.setMatrixAt(fIdx, dummy.matrix);
        fernColor.setHSL(0.30 + (rand() - 0.5) * 0.035, 0.22 + rand() * 0.14, 0.88 + rand() * 0.12);
        fernInst.setColorAt(fIdx, fernColor);
        fIdx++;
      }
    }
  }
  fernInst.count = fIdx;
  fernInst.instanceMatrix.needsUpdate = true;
  if (fernInst.instanceColor) fernInst.instanceColor.needsUpdate = true;
  group.add(fernInst);

  // 6a. Broadleaf Woodland Shrubs (Pacific Salal on coastal sites, dry sage/kinnikinnick shrubs in Kootenay Rockies)
  const shrubCount = Math.round((isRockies ? 78 : contract.site === 'coastal_town' ? 68 : 135) * densityMult);
  const shrubGeo = buildSalalShrubGeometry();
  const shrubMat = createGroundCoverMaterial('ground_salal', quality, groundWindUniforms, {
    roughness: isRockies ? 0.80 : 0.66,
    normalScale: 0.62,
    alphaTest: 0.35,
    swayScale: 0.62,
    sssStrength: 0.28,
    baseAo: 0.52,
    tint: isRockies ? '#b8bfa0' : '#f2f6ec',
  });
  const shrubInst = new THREE.InstancedMesh(shrubGeo, shrubMat, shrubCount);
  shrubInst.receiveShadow = true;
  let shIdx = 0;
  for (let tries = 0; tries < Math.round(420 * densityMult) && shIdx < shrubCount; tries++) {
    const a = rand() * Math.PI * 2;
    const d = (contract.site === 'coastal_town' ? 12.5 : 6.2) + rand() * 33;
    const sx = Math.cos(a) * d;
    const sz = Math.sin(a) * d;
    if (isGroundCoverBlocked(sx, sz)) continue;

    const sy = getTerrainHeight(sx, sz, contract.site);
    const sc = isRockies ? 0.58 + rand() * 0.55 : 0.72 + rand() * 0.72;
    dummy.position.set(sx, sy, sz);
    dummy.rotation.set((rand() - 0.5) * 0.12, rand() * Math.PI * 2, (rand() - 0.5) * 0.12);
    dummy.scale.set(sc, sc * (0.85 + rand() * 0.35), sc);
    dummy.updateMatrix();
    shrubInst.setMatrixAt(shIdx, dummy.matrix);
    if (isRockies) {
      fernColor.setHSL(0.24 + (rand() - 0.5) * 0.04, 0.16 + rand() * 0.1, 0.76 + rand() * 0.16);
    } else {
      fernColor.setHSL(0.30 + (rand() - 0.5) * 0.045, 0.22 + rand() * 0.14, 0.78 + rand() * 0.18);
    }
    shrubInst.setColorAt(shIdx, fernColor);
    shIdx++;
  }
  shrubInst.count = shIdx;
  shrubInst.instanceMatrix.needsUpdate = true;
  if (shrubInst.instanceColor) shrubInst.instanceColor.needsUpdate = true;
  group.add(shrubInst);

  // 6b. Rooted Botanical Wildflower Clumps (Oxeye daisies, lupines & buttercups on coast; Arrowleaf Balsamroot & mountain lupine in Rockies)
  const flowerCount = Math.round((isRockies ? 115 : 95) * densityMult);
  const flowerGeo = buildWildflowerClumpGeometry();
  const flowerMat = createGroundCoverMaterial(
    isRockies ? 'ground_wildflowers_rockies' : 'ground_wildflowers_coastal',
    quality,
    groundWindUniforms,
    {
      roughness: 0.80,
      normalScale: 0.5,
      alphaTest: 0.34,
      swayScale: 1.05,
      sssStrength: isRockies ? 0.14 : 0.18,
      baseAo: 0.62,
      tint: isRockies ? '#d2ccba' : '#dbd8d0',
    }
  );
  const flowerInst = new THREE.InstancedMesh(flowerGeo, flowerMat, flowerCount);
  flowerInst.receiveShadow = true;
  let flIdx = 0;
  for (let tries = 0; tries < Math.round(320 * densityMult) && flIdx < flowerCount; tries++) {
    const a = rand() * Math.PI * 2;
    const d = 5.8 + rand() * 28;
    const x = Math.cos(a) * d;
    const z = Math.sin(a) * d;
    if (isGroundCoverBlocked(x, z, true)) continue;
    // Keep tidy inner lawn borders on Coastal Town sparse so flowers cluster along edges & garden beds
    if (contract.site === 'coastal_town' && Math.hypot(x, z) < 7.5 && rand() < 0.72) continue;

    const y = getTerrainHeight(x, z, contract.site);
    const sc = isRockies ? 0.72 + rand() * 0.58 : 0.68 + rand() * 0.56;
    dummy.position.set(x, y, z);
    dummy.rotation.set((rand() - 0.5) * 0.1, rand() * Math.PI * 2, (rand() - 0.5) * 0.1);
    dummy.scale.set(sc, sc * (0.88 + rand() * 0.3), sc);
    dummy.updateMatrix();
    flowerInst.setMatrixAt(flIdx, dummy.matrix);
    // Gentle warm/cool organic tint variation while preserving vivid petal saturation (no HDR blowout)
    fernColor.setHSL(
      0.13 + (rand() - 0.5) * 0.08,
      isRockies ? 0.12 + rand() * 0.10 : 0.08 + rand() * 0.08,
      isRockies ? 0.70 + rand() * 0.14 : 0.76 + rand() * 0.14
    );
    flowerInst.setColorAt(flIdx, fernColor);
    flIdx++;
  }
  flowerInst.count = flIdx;
  flowerInst.instanceMatrix.needsUpdate = true;
  if (flowerInst.instanceColor) flowerInst.instanceColor.needsUpdate = true;
  group.add(flowerInst);

  // 7. Sculpted Grounded Regional Boulders (2 geological variants + world-space strata, moss cap & soil-line grounding)
  const rockDetail = quality === 'high' ? 2 : 1;
  const rockGeoA = buildSculptedBoulderGeometry(1.0, rockDetail, 0);
  const rockGeoB = buildSculptedBoulderGeometry(1.0, rockDetail, 1);
  const rockMat = createGroundedRockMat(
    isRockies ? '#d2ccbe' : '#9ba499',
    quality,
    contract.site,
    contract.weather,
    1,
    1
  );
  const totalRockCount = Math.round((contract.site === 'coastal_town' ? 14 : 44) * (quality === 'high' ? 1.25 : 1.0));
  const rockCountA = Math.ceil(totalRockCount * 0.5);
  const rockCountB = totalRockCount - rockCountA;
  const rockInstA = new THREE.InstancedMesh(rockGeoA, rockMat, rockCountA);
  const rockInstB = new THREE.InstancedMesh(rockGeoB, rockMat, Math.max(1, rockCountB));
  rockInstA.castShadow = true;
  rockInstA.receiveShadow = true;
  rockInstB.castShadow = true;
  rockInstB.receiveShadow = true;

  const boulderAnchorSpots: Array<{ x: number; z: number; r: number }> = [];
  let rIdxA = 0;
  let rIdxB = 0;
  for (let tries = 0; tries < 220 && rIdxA + rIdxB < totalRockCount; tries++) {
    const a = rand() * Math.PI * 2;
    const d = (contract.site === 'coastal_town' ? 19 : 10.5) + rand() * 34;
    const rx = Math.cos(a) * d;
    const rz = Math.sin(a) * d;
    if (contract.site === 'coastal_town' && rz > 10.5 && rz < 23.0) continue;
    if (homesteadDriveway && homesteadDriveway.isOnDriveway(rx, rz, 1.75)) continue;
    if (contract.site === 'misty_creek' && isInMistyCreek(rx, rz, 1.8)) continue;
    if (contract.trees.some((t) => Math.hypot(t.x - rx, t.z - rz) < 3.0)) continue;
    if (contract.hazards.some((h) => Math.hypot(h.x - rx, h.z - rz) < h.radius + 2.2)) continue;
    const ry = getTerrainHeight(rx, rz, contract.site);
    const sx = 0.65 + rand() * 1.35;
    const sy = 0.38 + rand() * 0.68;
    const sz = 0.65 + rand() * 1.28;
    // Embed boulder firmly into the earth (y = ry + sy * 0.14) so its broad base anchors seamlessly on slopes
    dummy.position.set(rx, ry + sy * 0.14, rz);
    dummy.rotation.set((rand() - 0.5) * 0.24, rand() * Math.PI * 2, (rand() - 0.5) * 0.24);
    dummy.scale.set(sx, sy, sz);
    dummy.updateMatrix();
    if (rIdxA < rockCountA && (rIdxB >= rockCountB || (rIdxA + rIdxB) % 2 === 0)) {
      rockInstA.setMatrixAt(rIdxA++, dummy.matrix);
    } else if (rIdxB < rockCountB) {
      rockInstB.setMatrixAt(rIdxB++, dummy.matrix);
    }
    boulderAnchorSpots.push({ x: rx, z: rz, r: Math.max(sx, sz) });
  }
  rockInstA.count = rIdxA;
  rockInstA.instanceMatrix.needsUpdate = true;
  group.add(rockInstA);
  rockInstB.count = rIdxB;
  rockInstB.instanceMatrix.needsUpdate = true;
  if (rIdxB > 0) group.add(rockInstB);

  // 7b. Grounded Fieldstones & Embedded Forest Cobble Clusters (seated half-buried around boulders & woodland soil)
  const scatterStoneGeo = buildSculptedBoulderGeometry(0.32, quality === 'high' ? 2 : 1, 2);
  const scatterStoneCount = Math.round((contract.site === 'coastal_town' ? 28 : 96) * densityMult);
  const scatterStoneInst = new THREE.InstancedMesh(scatterStoneGeo, rockMat, scatterStoneCount);
  scatterStoneInst.receiveShadow = true;
  let ssIdx = 0;

  // Cluster small weathered companion stones around major boulders so outcrops feel naturally fractured & settled
  for (const b of boulderAnchorSpots) {
    const companions = 1 + Math.floor(rand() * 3);
    for (let c = 0; c < companions && ssIdx < scatterStoneCount; c++) {
      const ca = rand() * Math.PI * 2;
      const cd = b.r * (0.88 + rand() * 0.95);
      const sx = b.x + Math.cos(ca) * cd;
      const sz = b.z + Math.sin(ca) * cd;
      if (homesteadDriveway && homesteadDriveway.isOnDriveway(sx, sz, 0.8)) continue;
      if (contract.site === 'misty_creek' && isInMistyCreek(sx, sz, 0.6)) continue;
      if (contract.site === 'coastal_town' && sz > 11.2 && sz < 22.0) continue;
      const sy = getTerrainHeight(sx, sz, contract.site);
      const scX = 0.62 + rand() * 0.85;
      const scY = 0.34 + rand() * 0.44;
      const scZ = 0.58 + rand() * 0.85;
      dummy.position.set(sx, sy + scY * 0.04, sz);
      dummy.rotation.set((rand() - 0.5) * 0.2, rand() * Math.PI * 2, (rand() - 0.5) * 0.2);
      dummy.scale.set(scX, scY, scZ);
      dummy.updateMatrix();
      scatterStoneInst.setMatrixAt(ssIdx++, dummy.matrix);
    }
  }
  // Additional half-buried fieldstones scattered naturally across the forest floor & mountain scree
  for (let tries = 0; tries < Math.round(180 * densityMult) && ssIdx < scatterStoneCount; tries++) {
    const a = rand() * Math.PI * 2;
    const d = (contract.site === 'coastal_town' ? 14 : 6.5) + rand() * 30;
    const sx = Math.cos(a) * d;
    const sz = Math.sin(a) * d;
    if (isGroundCoverBlocked(sx, sz)) continue;
    const sy = getTerrainHeight(sx, sz, contract.site);
    const scX = 0.55 + rand() * 0.95;
    const scY = 0.28 + rand() * 0.42;
    const scZ = 0.52 + rand() * 0.92;
    dummy.position.set(sx, sy + scY * 0.03, sz);
    dummy.rotation.set((rand() - 0.5) * 0.18, rand() * Math.PI * 2, (rand() - 0.5) * 0.18);
    dummy.scale.set(scX, scY, scZ);
    dummy.updateMatrix();
    scatterStoneInst.setMatrixAt(ssIdx++, dummy.matrix);
  }
  scatterStoneInst.count = ssIdx;
  scatterStoneInst.instanceMatrix.needsUpdate = true;
  group.add(scatterStoneInst);

  // 8. Towering Backdrop Cascadia Forest (Instanced Conifer Ring on surrounding ridges!)
  // Includes per-instance misty dissolve fade so background trees obstructing the camera smoothly fade out!
  const applyBgTreeFadeShader = (mat: THREE.MeshStandardMaterial, isFoliage = false) => {
    const useDetail = isFoliage && quality === 'high';
    mat.customProgramCacheKey = () => (useDetail ? 'bg-tree-dither-fade-fol-high' : 'bg-tree-dither-fade');
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
          attribute float aFade;
          varying float vBgFade;
          ${useDetail ? 'varying vec3 vBgWorldPos;' : ''}`
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          vBgFade = aFade;`
        )
        .replace(
          '#include <worldpos_vertex>',
          `#include <worldpos_vertex>
          ${useDetail ? 'vBgWorldPos = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;' : ''}`
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
          varying float vBgFade;
          ${
            useDetail
              ? `varying vec3 vBgWorldPos;
          float bgHash(vec2 p) {
            p = fract(p * vec2(127.1, 311.7));
            p += dot(p, p + 19.19);
            return fract(p.x * p.y);
          }
          float bgNoise(vec2 p) {
            vec2 i = floor(p);
            vec2 f = fract(p);
            vec2 u = f * f * (3.0 - 2.0 * f);
            return mix(
              mix(bgHash(i), bgHash(i + vec2(1.0, 0.0)), u.x),
              mix(bgHash(i + vec2(0.0, 1.0)), bgHash(i + vec2(1.0, 1.0)), u.x),
              u.y
            );
          }`
              : ''
          }
          float bgBayer4x4(vec2 p) {
            int x = int(mod(p.x, 4.0));
            int y = int(mod(p.y, 4.0));
            int idx = y * 4 + x;
            if (idx == 0) return 0.0 / 16.0;
            if (idx == 1) return 8.0 / 16.0;
            if (idx == 2) return 2.0 / 16.0;
            if (idx == 3) return 10.0 / 16.0;
            if (idx == 4) return 12.0 / 16.0;
            if (idx == 5) return 4.0 / 16.0;
            if (idx == 6) return 14.0 / 16.0;
            if (idx == 7) return 6.0 / 16.0;
            if (idx == 8) return 3.0 / 16.0;
            if (idx == 9) return 11.0 / 16.0;
            if (idx == 10) return 1.0 / 16.0;
            if (idx == 11) return 9.0 / 16.0;
            if (idx == 12) return 15.0 / 16.0;
            if (idx == 13) return 7.0 / 16.0;
            if (idx == 14) return 13.0 / 16.0;
            return 5.0 / 16.0;
          }`
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
          ${
            useDetail
              ? `// Evergreen bough-tier shadows & needle dapple so backdrop trees read like real Cascadia conifers
          float tierBand = sin(vBgWorldPos.y * 2.15 + bgNoise(vBgWorldPos.xz * 0.45) * 3.0) * 0.5 + 0.5;
          float needles = bgNoise(vBgWorldPos.xz * 1.8 + vec2(0.0, vBgWorldPos.y * 2.4));
          diffuseColor.rgb *= mix(0.58, 1.12, tierBand * 0.6 + needles * 0.4);`
              : ''
          }`
        )
        .replace(
          '#include <dithering_fragment>',
          `if (vBgFade < 0.995) {
            if (vBgFade < 0.03) discard;
            #ifdef USE_FOG
              gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, (1.0 - vBgFade) * 0.55);
            #endif
            float bayer = bgBayer4x4(floor(gl_FragCoord.xy));
            if (vBgFade <= bayer) discard;
          }
          #include <dithering_fragment>`
        );
    };
  };

  const bgTreeCount = Math.round((contract.site === 'kootenay_rockies' ? 115 : 195) * (quality === 'high' ? 1.25 : 1.0));
  // Full-height tapered conifer trunk spine visible inside the translucent evergreen bough whorls!
  const bgTrunkGeo = new THREE.CylinderGeometry(0.08, 0.46, 18.5, 6);
  bgTrunkGeo.translate(0, 9.25, 0);
  const bgBarkPbr = pbrAssets.getPbrSet('pine_bark', 'standard', { repeatX: 1, repeatY: 6 });
  const bgTrunkMat = new THREE.MeshStandardMaterial({
    map: bgBarkPbr.map,
    color: '#8f725d',
    roughness: 0.95,
  });
  applyBgTreeFadeShader(bgTrunkMat);

  // Alpha-tested botanical evergreen bough-whorl crown geometry (replaces smooth paper cones in 1 instanced draw call!)
  const bgCrownAssets = buildBackdropConiferCrownAssets(quality);
  const bgFolGeo = bgCrownAssets.geometry;
  const bgFolMat = new THREE.MeshStandardMaterial({
    map: bgCrownAssets.map,
    color: '#ffffff',
    vertexColors: true,
    side: THREE.DoubleSide,
    alphaTest: 0.38,
    roughness: 0.88,
    metalness: 0.02,
    envMapIntensity: quality === 'high' ? 0.34 : 0.65,
  });
  applyBgTreeFadeShader(bgFolMat, false);

  const bgFadeArray = new Float32Array(bgTreeCount).fill(1);
  const bgFadeAttr = new THREE.InstancedBufferAttribute(bgFadeArray, 1);
  bgFadeAttr.setUsage(THREE.DynamicDrawUsage);
  bgTrunkGeo.setAttribute('aFade', bgFadeAttr);
  bgFolGeo.setAttribute('aFade', bgFadeAttr);

  const bgTrunks = new THREE.InstancedMesh(bgTrunkGeo, bgTrunkMat, bgTreeCount);
  const bgFolCards = new THREE.InstancedMesh(bgFolGeo, bgFolMat, bgTreeCount);
  // Backdrop crowns sit at the edge of (or outside) the sun frustum. Sampling the
  // shadow map across every alpha-tested bough is mostly fogged-out work.

  const bgTreeMeta: Array<{ x: number; y: number; z: number; rMax: number; yMax: number; fade: number }> = [];

  const col = new THREE.Color();
  let tPlaced = 0;
  for (let i = 0; i < bgTreeCount * 2 && tPlaced < bgTreeCount; i++) {
    const angle = rand() * Math.PI * 2;
    // Leave scenic ocean overlook gap on storm_bluff/pacific_headland and open mountain vistas in the Kootenays
    if (contract.site === 'storm_bluff' && angle > 0.25 && angle < 1.35) continue;
    if (contract.site === 'pacific_headland' && angle > 0.15 && angle < 1.55) continue;
    if (contract.site === 'kootenay_rockies' && angle > -1.75 && angle < -0.35 && rand() < 0.72) continue;

    const dist =
      (contract.site === 'coastal_town'
        ? 36
        : contract.site === 'kootenay_rockies'
          ? 30
          : 25) +
      rand() * 68;
    const tx = Math.cos(angle) * dist;
    const tz = Math.sin(angle) * dist;
    // Keep the town street, homestead driveway, and meandering creek bed clear of backdrop forest trunks
    if (contract.site === 'coastal_town' && tz > 10.0 && tz < 24.0) continue;
    if (homesteadDriveway && homesteadDriveway.isOnDriveway(tx, tz, 2.8)) continue;
    if (contract.site === 'misty_creek' && isInMistyCreek(tx, tz, 3.0)) continue;
    const ty = getTerrainHeight(tx, tz, contract.site);
    const scale = 0.72 + rand() * 0.95;
    const sx = scale * (0.85 + rand() * 0.3);
    const sy = scale * (0.85 + rand() * 0.45);
    const sz = scale * (0.85 + rand() * 0.3);

    dummy.position.set(tx, ty - 0.5, tz);
    dummy.rotation.set(0, rand() * Math.PI * 2, (rand() - 0.5) * 0.04);
    dummy.scale.set(sx, sy, sz);
    dummy.updateMatrix();

    bgTrunks.setMatrixAt(tPlaced, dummy.matrix);
    bgFolCards.setMatrixAt(tPlaced, dummy.matrix);

    bgTreeMeta.push({
      x: tx,
      y: ty - 0.5,
      z: tz,
      rMax: 3.75 * Math.max(sx, sz),
      yMax: ty - 0.5 + 23.2 * sy,
      fade: 1,
    });

    // Regional forest color modulation (multiplied over rich evergreen needle texture!)
    if (contract.site === 'kootenay_rockies') {
      const rCol = rand();
      if (rCol < 0.24) {
        // Golden autumn Western Larch accents scattered across the foothills!
        col.setRGB(1.45 + rand() * 0.15, 1.08 + rand() * 0.12, 0.38 + rand() * 0.08);
      } else if (rCol < 0.42) {
        // Silvery Blue Spruce / interior pine hue
        col.setRGB(0.68 + rand() * 0.12, 0.88 + rand() * 0.12, 0.98 + rand() * 0.1);
      } else {
        // Sun-warmed Ponderosa Pine & interior Douglas Fir greens
        col.setRGB(0.84 + rand() * 0.18, 0.92 + rand() * 0.16, 0.72 + rand() * 0.14);
      }
    } else {
      // Rich PNW forest color variation (Douglas fir emerald, Sitka spruce teal, cedar olive)
      const tintShade = 0.76 + rand() * 0.32;
      col.setRGB(
        tintShade * (0.88 + rand() * 0.18),
        tintShade * (0.96 + rand() * 0.14),
        tintShade * (0.86 + rand() * 0.22)
      );
    }
    bgFolCards.setColorAt(tPlaced, col);
    tPlaced++;
  }
  bgTrunks.count = tPlaced;
  bgFolCards.count = tPlaced;
  bgTrunks.instanceMatrix.needsUpdate = true;
  bgFolCards.instanceMatrix.needsUpdate = true;
  if (bgFolCards.instanceColor) bgFolCards.instanceColor.needsUpdate = true;

  group.add(bgTrunks, bgFolCards);

  const updateBackgroundOcclusion = (cameraPos: THREE.Vector3, targetPos: THREE.Vector3, dt: number): void => {
    const dx = targetPos.x - cameraPos.x;
    const dy = targetPos.y - cameraPos.y;
    const dz = targetPos.z - cameraPos.z;
    const horizLenSq = dx * dx + dz * dz;
    const invHorizLenSq = horizLenSq > 0.001 ? 1 / horizLenSq : 0;
    const lerpRate = Math.min(1, 9.5 * dt);
    let dirty = false;

    for (let i = 0; i < bgTreeMeta.length; i++) {
      const m = bgTreeMeta[i];
      let targetFade = 1;

      // 1. Direct camera proximity fade (prevents camera clipping inside a nearby conifer)
      const camHorizDist = Math.hypot(m.x - cameraPos.x, m.z - cameraPos.z);
      const nearPad = m.rMax + 5.2;
      if (camHorizDist < nearPad + 3.0 && cameraPos.y >= m.y - 3.0 && cameraPos.y <= m.yMax + 4.0) {
        const nearFactor = THREE.MathUtils.clamp((camHorizDist - (m.rMax + 2.6)) / 4.2, 0, 1);
        targetFade = Math.min(targetFade, nearFactor);
      }

      // 2. Camera -> target sight corridor fade (dissolves trees sitting between camera and active tree)
      if (invHorizLenSq > 0) {
        const uRaw = ((m.x - cameraPos.x) * dx + (m.z - cameraPos.z) * dz) * invHorizLenSq;
        if (uRaw > -0.15 && uRaw < 0.96) {
          const u = THREE.MathUtils.clamp(uRaw, 0, 1);
          const px = cameraPos.x + dx * u;
          const py = cameraPos.y + dy * u;
          const pz = cameraPos.z + dz * u;

          if (py >= m.y - 3.5 && py <= m.yMax + 4.0) {
            const perpDist = Math.hypot(m.x - px, m.z - pz);
            // Wider clearance closer to camera where a tree fills more of the screen
            const clearRadius = m.rMax + 2.2 + (1 - u) * 3.0;
            const softBand = 3.2;
            if (perpDist < clearRadius + softBand) {
              const sightFactor = THREE.MathUtils.clamp((perpDist - clearRadius) / softBand, 0, 1);
              targetFade = Math.min(targetFade, sightFactor);
            }
          }
        }
      }

      const nextFade = m.fade + (targetFade - m.fade) * lerpRate;
      if (Math.abs(nextFade - m.fade) > 0.002) {
        m.fade = nextFade;
        bgFadeArray[i] = nextFade;
        dirty = true;
      } else if (m.fade !== targetFade) {
        m.fade = targetFade;
        bgFadeArray[i] = targetFade;
        dirty = true;
      }
    }

    if (dirty) {
      bgFadeAttr.needsUpdate = true;
    }
  };

  const updateEffects = (elapsed: number, windSpeed: number, windAngle: number): void => {
    for (const fn of effectUpdaters) {
      fn(elapsed, windSpeed, windAngle);
    }
  };

  scene.add(group);

  return {
    group,
    hazardGroups,
    hazardWarningRings,
    sceneOccluders,
    waterMesh,
    sunLight,
    hemiLight,
    sunDir,
    skyMesh,
    windAnimatedMeshes,
    updateEffects,
    updateBackgroundOcclusion,
  };
}
