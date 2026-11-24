import * as THREE from 'three';
import { ContractSpec, HazardSpec, SiteId, WeatherId } from '../types';
import { textureCache } from './ProceduralTextures';

export interface SceneOccluder {
  rootGroup: THREE.Object3D;
  occlusionFade: number;
  occlusionMaterials: Array<{ mat: THREE.Material; baseOpacity: number }>;
}

export interface BuiltEnvironment {
  group: THREE.Group;
  hazardGroups: Map<string, THREE.Group>;
  hazardWarningRings: THREE.Mesh[];
  sceneOccluders: SceneOccluder[];
  waterMesh?: THREE.Mesh;
  sunLight: THREE.DirectionalLight;
  hemiLight: THREE.HemisphereLight;
  skyMesh: THREE.Mesh;
  windAnimatedMeshes: THREE.Object3D[];
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
 * Computes terrain elevation at world (x, z).
 * Central 24m radius is level (0m) for crisp tree felling & structures,
 * transitioning smoothly into undulating coastal PNW forested hills!
 */
export function getTerrainHeight(x: number, z: number, site: SiteId): number {
  const dist = Math.hypot(x, z);
  const flatRadius = site === 'coastal_town' ? 27 : 23;
  if (dist <= flatRadius) return 0;

  const t = Math.min(1, (dist - flatRadius) / 42);
  const smooth = t * t * (3 - 2 * t);

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
  if (site === 'misty_creek') {
    return smooth * (6.2 + ridgeNoise * 0.85);
  }
  if (site === 'coastal_town') {
    // Keep the east-west town street level while wooded hills rise gently behind the neighborhood
    const roadKeepFlat = Math.abs(z - 16.5) < 9 ? 0.15 : 1.0;
    return smooth * roadKeepFlat * (4.2 + ridgeNoise * 0.58);
  }
  return smooth * (5.2 + ridgeNoise * 0.72);
}

function createSkyDome(weather: WeatherId): { skyMesh: THREE.Mesh; sunDir: THREE.Vector3; fogColor: number; fogDensity: number } {
  const palettes: Record<
    WeatherId,
    { top: string; mid: string; horizon: string; sun: string; sunPos: [number, number, number]; fog: number; density: number }
  > = {
    sunny_morning: {
      top: '#3b7bb8',
      mid: '#7fb3d5',
      horizon: '#d8e9df',
      sun: '#fff4cf',
      sunPos: [45, 38, -32],
      fog: 0xcde0d8,
      density: 0.0072,
    },
    misty_fog: {
      top: '#5e7884',
      mid: '#8ea5ab',
      horizon: '#c7d5d2',
      sun: '#f0f4e8',
      sunPos: [30, 34, -40],
      fog: 0xbfcfcc,
      density: 0.0125,
    },
    golden_hour: {
      top: '#2e4e72',
      mid: '#9e8476',
      horizon: '#ebc192',
      sun: '#ffd584',
      sunPos: [-52, 22, -38],
      fog: 0xd9bfa0,
      density: 0.0085,
    },
    coastal_gale: {
      top: '#384c59',
      mid: '#647984',
      horizon: '#9eb1b5',
      sun: '#d8e3e6',
      sunPos: [-35, 28, -45],
      fog: 0x93a7ac,
      density: 0.011,
    },
  };

  const p = palettes[weather];
  const sunDir = new THREE.Vector3(...p.sunPos).normalize();

  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uTop: { value: new THREE.Color(p.top) },
      uMid: { value: new THREE.Color(p.mid) },
      uHorizon: { value: new THREE.Color(p.horizon) },
      uSunColor: { value: new THREE.Color(p.sun) },
      uSunDir: { value: sunDir },
    },
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
      varying vec3 vWorldPos;
      void main() {
        vec3 dir = normalize(vWorldPos);
        float h = clamp(dir.y, 0.0, 1.0);
        vec3 col = mix(uHorizon, uMid, smoothstep(0.0, 0.28, h));
        col = mix(col, uTop, smoothstep(0.25, 0.85, h));
        float sunDot = max(dot(dir, normalize(uSunDir)), 0.0);
        float sunHalo = pow(sunDot, 12.0) * 0.35 + pow(sunDot, 180.0) * 0.9;
        col += uSunColor * sunHalo;
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });

  const skyMesh = new THREE.Mesh(new THREE.SphereGeometry(220, 32, 20), skyMat);
  return { skyMesh, sunDir, fogColor: p.fog, fogDensity: p.density };
}

function buildCabin(): THREE.Group {
  const g = new THREE.Group();
  const cedarTex = textureCache.getWoodPlankTexture('#7b4d31', 12);
  const wallMat = new THREE.MeshStandardMaterial({ map: cedarTex, roughness: 0.86 });
  const roofMat = new THREE.MeshStandardMaterial({ color: '#39463b', roughness: 0.9, flatShading: true });
  const trimMat = new THREE.MeshStandardMaterial({ color: '#d9cbb8', roughness: 0.75 });
  const windowMat = new THREE.MeshStandardMaterial({
    color: '#ffe194',
    emissive: '#f59e0b',
    emissiveIntensity: 0.65,
    roughness: 0.2,
  });
  const stoneMat = new THREE.MeshStandardMaterial({ color: '#6b6f6c', roughness: 0.95, flatShading: true });

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

function buildAFrame(): THREE.Group {
  const g = new THREE.Group();
  const timberTex = textureCache.getWoodPlankTexture('#8c5a36', 10);
  const deckTex = textureCache.getWoodPlankTexture('#9c6f46', 8);
  const timberMat = new THREE.MeshStandardMaterial({ map: timberTex, roughness: 0.84 });
  const deckMat = new THREE.MeshStandardMaterial({ map: deckTex, roughness: 0.88 });
  const roofMat = new THREE.MeshStandardMaterial({
    color: '#2c3538',
    roughness: 0.62,
    metalness: 0.3,
    flatShading: true,
  });
  const trimMat = new THREE.MeshStandardMaterial({ color: '#3b281c', roughness: 0.82 });
  const glassMat = new THREE.MeshStandardMaterial({
    color: '#ffe8ad',
    emissive: '#f59e0b',
    emissiveIntensity: 0.62,
    roughness: 0.16,
    metalness: 0.18,
  });
  const stoneMat = new THREE.MeshStandardMaterial({
    color: '#8b887e',
    roughness: 0.94,
    flatShading: true,
  });

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

function buildBarn(): THREE.Group {
  const g = new THREE.Group();
  const redTex = textureCache.getWoodPlankTexture('#8c3027', 12);
  const barnMat = new THREE.MeshStandardMaterial({ map: redTex, roughness: 0.88 });
  const trimMat = new THREE.MeshStandardMaterial({ color: '#ebe4d8', roughness: 0.75 });
  const roofMat = new THREE.MeshStandardMaterial({ color: '#4b555a', roughness: 0.65, metalness: 0.25 });

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

function buildWoodshed(): THREE.Group {
  const g = new THREE.Group();
  const plankTex = textureCache.getWoodPlankTexture('#6f4a2e', 8);
  const woodMat = new THREE.MeshStandardMaterial({ map: plankTex, roughness: 0.9 });
  const roofMat = new THREE.MeshStandardMaterial({ color: '#4c5750', roughness: 0.72, metalness: 0.2 });

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

function buildPickupTruck(): THREE.Group {
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

  return g;
}

function buildGazebo(): THREE.Group {
  const g = new THREE.Group();
  const cedarMat = new THREE.MeshStandardMaterial({ color: '#7d5235', roughness: 0.85 });
  const roofMat = new THREE.MeshStandardMaterial({ color: '#3b4a42', roughness: 0.88, flatShading: true });

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

function buildProtectedSapling(): THREE.Group {
  const g = new THREE.Group();
  const trunkMat = new THREE.MeshStandardMaterial({ color: '#613c29', roughness: 0.9 });
  const folMat = new THREE.MeshStandardMaterial({ color: '#2f6c39', roughness: 0.82, flatShading: true });
  const stakeMat = new THREE.MeshStandardMaterial({ color: '#e11d48', roughness: 0.5 });

  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.12, 2.2, 7), trunkMat);
  trunk.position.y = 1.1;
  trunk.castShadow = true;
  g.add(trunk);

  for (let i = 0; i < 4; i++) {
    const cone = new THREE.Mesh(new THREE.ConeGeometry(1.15 - i * 0.22, 1.45, 7), folMat);
    cone.position.y = 1.65 + i * 0.85;
    cone.castShadow = true;
    g.add(cone);
  }

  // 3 small forestry protection stakes around the sapling
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const stake = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 1.1, 6), stakeMat);
    stake.position.set(Math.cos(a) * 1.35, 0.55, Math.sin(a) * 1.35);
    g.add(stake);
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

function buildHazardMesh(h: HazardSpec): THREE.Group {
  let g: THREE.Group;
  switch (h.type) {
    case 'cabin':
      g = buildCabin();
      break;
    case 'aframe':
      g = buildAFrame();
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
      g = buildBarn();
      break;
    case 'shed':
      g = buildWoodshed();
      break;
    case 'truck':
      g = buildPickupTruck();
      break;
    case 'gazebo':
      g = buildGazebo();
      break;
    case 'powerline':
      g = buildPowerPole();
      break;
    case 'fence':
      g = buildFence(h.width ?? 8.5);
      break;
    case 'sapling':
    default:
      g = buildProtectedSapling();
      break;
  }
  g.position.set(h.x, 0, h.z);
  if (h.rotation) g.rotation.y = h.rotation;
  return g;
}

function buildSwordFernGeometry(): THREE.BufferGeometry {
  // 7 arched tapering PNW sword-fern fronds radiating 360 degrees
  const frondCount = 7;
  const segs = 4;
  const positions: number[] = [];
  const normals: number[] = [];

  for (let f = 0; f < frondCount; f++) {
    const yaw = (f / frondCount) * Math.PI * 2 + (f % 2) * 0.22;
    const cosY = Math.cos(yaw);
    const sinY = Math.sin(yaw);
    const len = 1.05 + (f % 3) * 0.14;
    const archH = 0.42 + (f % 2) * 0.12;

    const pt = (t: number, side: number) => {
      const r = t * len;
      const y = Math.sin(t * Math.PI * 0.82) * archH + 0.06;
      const halfW = Math.sin(t * Math.PI) * 0.22;
      const lx = r;
      const lz = side * halfW;
      return [lx * cosY - lz * sinY, y, lx * sinY + lz * cosY];
    };

    for (let s = 0; s < segs; s++) {
      const t0 = s / segs;
      const t1 = (s + 1) / segs;
      const p0L = pt(t0, -1);
      const p0R = pt(t0, 1);
      const p1L = pt(t1, -1);
      const p1R = pt(t1, 1);

      // Triangle 1
      positions.push(...p0L, ...p1L, ...p1R);
      // Triangle 2
      positions.push(...p0L, ...p1R, ...p0R);
      for (let k = 0; k < 6; k++) normals.push(0, 1, 0);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.computeVertexNormals();
  return geo;
}

function buildBunchgrassGeometry(): THREE.BufferGeometry {
  // 11 slender upright-arching dry bunchgrass blades (East Kootenay bluebunch wheatgrass & fescue)
  const bladeCount = 11;
  const segs = 3;
  const positions: number[] = [];
  const normals: number[] = [];

  for (let f = 0; f < bladeCount; f++) {
    const yaw = (f / bladeCount) * Math.PI * 2 + (f % 3) * 0.19;
    const cosY = Math.cos(yaw);
    const sinY = Math.sin(yaw);
    const leanR = 0.28 + (f % 4) * 0.12;
    const bladeH = 0.48 + (f % 3) * 0.16;
    const baseOff = 0.08 + (f % 2) * 0.07;

    const pt = (t: number, side: number) => {
      const r = baseOff + t * t * leanR;
      const y = t * bladeH - t * t * 0.08;
      const halfW = (1 - t * 0.88) * 0.048;
      const lx = r;
      const lz = side * halfW;
      return [lx * cosY - lz * sinY, y, lx * sinY + lz * cosY];
    };

    for (let s = 0; s < segs; s++) {
      const t0 = s / segs;
      const t1 = (s + 1) / segs;
      const p0L = pt(t0, -1);
      const p0R = pt(t0, 1);
      const p1L = pt(t1, -1);
      const p1R = pt(t1, 1);

      positions.push(...p0L, ...p1L, ...p1R);
      positions.push(...p0L, ...p1R, ...p0R);
      for (let k = 0; k < 6; k++) normals.push(0, 1, 0);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.computeVertexNormals();
  return geo;
}

export function buildEnvironment(
  scene: THREE.Scene,
  contract: ContractSpec
): BuiltEnvironment {
  const group = new THREE.Group();
  const rand = makeRng(contract.index * 7919 + 1337);
  const windAnimatedMeshes: THREE.Object3D[] = [];

  // 1. Sky Dome + Regional Fog (crisp dry air in the Rockies so distant peaks read clearly)
  const { skyMesh, sunDir, fogColor, fogDensity } = createSkyDome(contract.weather);
  group.add(skyMesh);
  const fogScale = contract.site === 'kootenay_rockies' ? 0.56 : 0.88;
  scene.fog = new THREE.FogExp2(fogColor, fogDensity * fogScale);
  scene.background = new THREE.Color(fogColor);

  // 2. Lighting Setup (Crisp Pacific Northwest sun + lush mossy bounce + sky fill)
  const hemiColors: Record<WeatherId, [number, number, number]> = {
    sunny_morning: [0xd4ecff, 0x4f6e3f, 1.25],
    misty_fog: [0xdbe7ea, 0x4b6346, 1.3],
    golden_hour: [0xffe3bd, 0x5c633b, 1.18],
    coastal_gale: [0xb4cad6, 0x3e543f, 1.2],
  };
  const [skyCol, groundCol, hemiInt] = hemiColors[contract.weather];
  const hemiLight = new THREE.HemisphereLight(skyCol, groundCol, hemiInt);
  group.add(hemiLight);

  const sunColors: Record<WeatherId, [number, number]> = {
    sunny_morning: [0xfff6dc, 2.35],
    misty_fog: [0xf4f7f0, 1.65],
    golden_hour: [0xffc67d, 2.55],
    coastal_gale: [0xe3eef2, 1.65],
  };
  const [sunCol, sunInt] = sunColors[contract.weather];
  const sunLight = new THREE.DirectionalLight(sunCol, sunInt);
  sunLight.position.copy(sunDir).multiplyScalar(68);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.width = 2048;
  sunLight.shadow.mapSize.height = 2048;
  sunLight.shadow.camera.near = 10;
  sunLight.shadow.camera.far = 160;
  const shadowExtent = 38;
  sunLight.shadow.camera.left = -shadowExtent;
  sunLight.shadow.camera.right = shadowExtent;
  sunLight.shadow.camera.top = shadowExtent;
  sunLight.shadow.camera.bottom = -shadowExtent;
  sunLight.shadow.bias = -0.0005;
  group.add(sunLight);

  // Soft opposite rim/fill light so shaded bark & evergreen needles stay rich and readable
  const fillLight = new THREE.DirectionalLight(0xaad0e6, 0.52);
  fillLight.position.copy(sunDir).multiplyScalar(-45);
  fillLight.position.y = 26;
  group.add(fillLight);

  // 3. Undulating Coastal PNW Terrain
  const terrainStyle =
    contract.site === 'coastal_homestead'
      ? 'homestead'
      : contract.site === 'misty_creek'
        ? 'creek'
        : contract.site === 'timber_ridge'
          ? 'ridge'
          : contract.site === 'coastal_town'
            ? 'suburban'
            : contract.site === 'pacific_headland'
              ? 'headland'
              : contract.site === 'kootenay_rockies'
                ? 'kootenay'
                : 'bluff';

  const terrainGeo = new THREE.PlaneGeometry(240, 240, 96, 96);
  terrainGeo.rotateX(-Math.PI / 2);
  const tPos = terrainGeo.attributes.position;
  for (let i = 0; i < tPos.count; i++) {
    const x = tPos.getX(i);
    const z = tPos.getZ(i);
    tPos.setY(i, getTerrainHeight(x, z, contract.site));
  }
  terrainGeo.computeVertexNormals();

  const terrainMat = new THREE.MeshStandardMaterial({
    map: textureCache.getTerrainTexture(terrainStyle),
    roughness: 0.94,
    metalness: 0.02,
  });
  const terrainMesh = new THREE.Mesh(terrainGeo, terrainMat);
  terrainMesh.receiveShadow = true;
  terrainMesh.userData = { part: 'ground' };
  group.add(terrainMesh);

  // 4. Site-Specific Landmarks (Driveway, Creek, Nurse Logs, Distant Inlet)
  let waterMesh: THREE.Mesh | undefined;

  if (contract.site === 'coastal_homestead') {
    // Textured coastal river-gravel driveway with grassy edges
    const gravelMat = new THREE.MeshStandardMaterial({
      map: textureCache.getGravelTexture(),
      roughness: 0.95,
    });
    const drive = new THREE.Mesh(new THREE.PlaneGeometry(5.2, 34), gravelMat);
    drive.rotation.x = -Math.PI / 2;
    drive.rotation.z = -0.18;
    drive.position.set(1.2, 0.03, 12.5);
    drive.receiveShadow = true;
    group.add(drive);
  } else if (contract.site === 'misty_creek') {
    // Glistening coastal creek curving across the back of the valley
    const creekShape = new THREE.Shape();
    creekShape.moveTo(-45, -18);
    creekShape.bezierCurveTo(-15, -11, 10, -21, 45, -12);
    creekShape.lineTo(45, -5.5);
    creekShape.bezierCurveTo(10, -14.5, -15, -4.5, -45, -11.5);
    creekShape.closePath();

    const waterGeo = new THREE.ShapeGeometry(creekShape, 24);
    waterGeo.rotateX(-Math.PI / 2);
    const waterMat = new THREE.MeshStandardMaterial({
      color: '#2c6e78',
      roughness: 0.16,
      metalness: 0.48,
      transparent: true,
      opacity: 0.84,
    });
    waterMesh = new THREE.Mesh(waterGeo, waterMat);
    waterMesh.position.y = 0.04;
    waterMesh.receiveShadow = true;
    group.add(waterMesh);

    // Rustic timber footbridge across the creek
    const bridgeGroup = new THREE.Group();
    const plankMat = new THREE.MeshStandardMaterial({ color: '#6b4c35', roughness: 0.9 });
    const deck = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.25, 7.2), plankMat);
    deck.position.y = 0.45;
    deck.castShadow = true;
    bridgeGroup.add(deck);
    for (const bx of [-1.15, 1.15]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 7.2), plankMat);
      rail.position.set(bx, 1.35, 0);
      bridgeGroup.add(rail);
    }
    bridgeGroup.position.set(-4.5, 0, -13.2);
    bridgeGroup.rotation.y = 0.22;
    group.add(bridgeGroup);
  } else if (contract.site === 'timber_ridge') {
    // Harvested stacked timber log deck at edge of landing
    const barkSet = textureCache.getBarkTextures('douglas_fir');
    const deckMat = new THREE.MeshStandardMaterial({ map: barkSet.map, roughness: 0.9 });
    const logGeo = new THREE.CylinderGeometry(0.42, 0.46, 6.2, 10);
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
    // Distant Pacific coastal water sheen far beyond the bluff
    const oceanMat = new THREE.MeshStandardMaterial({
      color: '#2c5368',
      roughness: 0.24,
      metalness: 0.52,
    });
    waterMesh = new THREE.Mesh(new THREE.PlaneGeometry(240, 120), oceanMat);
    waterMesh.rotation.x = -Math.PI / 2;
    waterMesh.position.set(60, -4.5, 65);
    group.add(waterMesh);
  } else if (contract.site === 'pacific_headland') {
    // 1) Shimmering Pacific Cove stretching out below the headland bluffs
    const oceanMat = new THREE.MeshStandardMaterial({
      color: '#225e74',
      roughness: 0.2,
      metalness: 0.54,
    });
    waterMesh = new THREE.Mesh(new THREE.PlaneGeometry(260, 150), oceanMat);
    waterMesh.rotation.x = -Math.PI / 2;
    waterMesh.position.set(55, -4.2, 68);
    group.add(waterMesh);

    // 2) Sun-bleached coastal granite outcrops lining the headland bluff rim
    const outcropGeo = new THREE.DodecahedronGeometry(1.8, 1);
    const outcropMat = new THREE.MeshStandardMaterial({
      color: '#8e8a7e',
      roughness: 0.92,
      flatShading: true,
    });
    const outcropSpots: Array<[number, number, number, number]> = [
      [22.5, 13.5, 1.5, 0.9],
      [18.5, 22.0, 2.0, 1.1],
      [9.0, 24.5, 1.7, 0.85],
      [25.5, 3.5, 1.8, 1.0],
      [-2.5, 25.0, 1.5, 0.8],
      [28.0, 19.5, 2.4, 1.3],
      [14.0, 29.0, 2.3, 1.2],
    ];
    for (const [ox, oz, sx, sy] of outcropSpots) {
      const rock = new THREE.Mesh(outcropGeo, outcropMat);
      const oy = getTerrainHeight(ox, oz, contract.site);
      rock.position.set(ox, oy + sy * 0.45, oz);
      rock.scale.set(sx, sy, sx * (0.75 + rand() * 0.4));
      rock.rotation.set((rand() - 0.5) * 0.25, rand() * Math.PI * 2, (rand() - 0.5) * 0.25);
      rock.castShadow = true;
      rock.receiveShadow = true;
      group.add(rock);
    }

    // 3) Sandy coastal overlook trail ribbon curving around the seaward meadow edge
    const trailMat = new THREE.MeshStandardMaterial({
      color: '#a89a78',
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
    const benchWood = new THREE.MeshStandardMaterial({ color: '#7a6855', roughness: 0.9 });
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
    const trackMat = new THREE.MeshStandardMaterial({
      color: '#b09a74',
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
    const outcropGeo = new THREE.DodecahedronGeometry(1.9, 1);
    const outcropMat = new THREE.MeshStandardMaterial({
      color: '#a39e90',
      roughness: 0.93,
      flatShading: true,
    });
    const outcropSpots: Array<[number, number, number, number]> = [
      [-23.5, -16.5, 1.9, 1.0],
      [22.5, -14.5, 2.1, 1.15],
      [25.0, 9.5, 1.7, 0.85],
      [-21.5, 21.0, 2.0, 1.0],
      [8.5, -24.0, 2.3, 1.2],
      [-6.5, 26.5, 1.8, 0.9],
    ];
    for (const [ox, oz, sx, sy] of outcropSpots) {
      const rock = new THREE.Mesh(outcropGeo, outcropMat);
      const oy = getTerrainHeight(ox, oz, contract.site);
      rock.position.set(ox, oy + sy * 0.42, oz);
      rock.scale.set(sx, sy, sx * (0.75 + rand() * 0.4));
      rock.rotation.set((rand() - 0.5) * 0.22, rand() * Math.PI * 2, (rand() - 0.5) * 0.22);
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
    const pondGeo = new THREE.ShapeGeometry(pondShape, 24);
    pondGeo.rotateX(-Math.PI / 2);
    const pondMat = new THREE.MeshStandardMaterial({
      color: '#2c767c',
      roughness: 0.14,
      metalness: 0.45,
      transparent: true,
      opacity: 0.86,
    });
    waterMesh = new THREE.Mesh(pondGeo, pondMat);
    waterMesh.position.set(-11.5, 0.05, -9.5);
    waterMesh.receiveShadow = true;
    group.add(waterMesh);

    // River-cobble border around the backyard pond
    const cobbleGeo = new THREE.DodecahedronGeometry(0.42, 0);
    const cobbleMat = new THREE.MeshStandardMaterial({ color: '#838782', roughness: 0.92, flatShading: true });
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

  // 5. Place Hazards & Subtle Warning Rings
  const hazardGroups = new Map<string, THREE.Group>();
  const hazardWarningRings: THREE.Mesh[] = [];

  const sceneOccluders: SceneOccluder[] = [];

  for (const h of contract.hazards) {
    const hGroup = buildHazardMesh(h);
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

  // 6. Instanced Ground Undergrowth (Dry Bunchgrass in Kootenay Rockies, Sword Ferns on the coast)
  const fernCount = contract.site === 'kootenay_rockies' ? 320 : 260;
  const fernFrondGeo =
    contract.site === 'kootenay_rockies' ? buildBunchgrassGeometry() : buildSwordFernGeometry();
  const fernMat = new THREE.MeshStandardMaterial({
    color: '#ffffff', // white base so instanceColor isn't double-darkened!
    roughness: 0.82,
    side: THREE.DoubleSide,
    flatShading: true,
  });
  const fernInst = new THREE.InstancedMesh(fernFrondGeo, fernMat, fernCount);
  fernInst.receiveShadow = true;

  const dummy = new THREE.Object3D();
  const fernColor = new THREE.Color();
  let fIdx = 0;
  for (let tries = 0; tries < 700 && fIdx < fernCount; tries++) {
    const angle = rand() * Math.PI * 2;
    const dist = 5.5 + rand() * 34;
    const fx = Math.cos(angle) * dist;
    const fz = Math.sin(angle) * dist;

    // Avoid spawning inside trees, driveway center, misty creek water, town street/pond, or hazards
    const onDriveway = contract.site === 'coastal_homestead' && Math.abs(fx - 1.2) < 3.0 && fz > -2;
    const inCreek = contract.site === 'misty_creek' && fz > 4.5 && fz < 21.5;
    const onTownRoad = contract.site === 'coastal_town' && fz > 11.2 && fz < 22.0;
    const inTownPond = contract.site === 'coastal_town' && Math.hypot((fx + 11.5) / 5.2, (fz + 9.5) / 4.2) < 1.05;
    const inTownCentralLawn = contract.site === 'coastal_town' && Math.hypot(fx, fz) < 11.5;
    const tooClose =
      onDriveway ||
      inCreek ||
      onTownRoad ||
      inTownPond ||
      inTownCentralLawn ||
      contract.trees.some((t) => Math.hypot(t.x - fx, t.z - fz) < 2.2) ||
      contract.hazards.some((h) => Math.hypot(h.x - fx, h.z - fz) < h.radius + 1.1);
    if (tooClose) continue;

    const fy = getTerrainHeight(fx, fz, contract.site);
    const s = 0.72 + rand() * 0.85;
    dummy.position.set(fx, fy + 0.02, fz);
    dummy.rotation.set((rand() - 0.5) * 0.14, rand() * Math.PI * 2, (rand() - 0.5) * 0.14);
    dummy.scale.set(s, s * (0.85 + rand() * 0.4), s);
    dummy.updateMatrix();
    fernInst.setMatrixAt(fIdx, dummy.matrix);

    if (contract.site === 'kootenay_rockies') {
      // Sun-cured golden bunchgrass & dry interior sage tufts
      if (rand() > 0.32) {
        fernColor.setHSL(0.12 + (rand() - 0.5) * 0.035, 0.36 + rand() * 0.14, 0.34 + rand() * 0.11);
      } else {
        fernColor.setHSL(0.24 + (rand() - 0.5) * 0.04, 0.18 + rand() * 0.1, 0.3 + rand() * 0.08);
      }
    } else {
      fernColor.setHSL(0.30 + (rand() - 0.5) * 0.05, 0.48 + rand() * 0.14, 0.20 + rand() * 0.10);
    }
    fernInst.setColorAt(fIdx, fernColor);
    fIdx++;
  }
  fernInst.count = fIdx;
  fernInst.instanceMatrix.needsUpdate = true;
  if (fernInst.instanceColor) fernInst.instanceColor.needsUpdate = true;
  group.add(fernInst);

  // 6b. Coastal Wildflowers / Lupine & Clover accents
  const flowerCount = 85;
  const flowerGeo = new THREE.DodecahedronGeometry(0.14, 0);
  flowerGeo.translate(0, 0.22, 0);
  const flowerMat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.75, flatShading: true });
  const flowerInst = new THREE.InstancedMesh(flowerGeo, flowerMat, flowerCount);
  const flowerPalette =
    contract.site === 'kootenay_rockies'
      ? ['#facc15', '#fde047', '#eab308', '#c4b5fd', '#fef08a'] // arrowleaf balsamroot & mountain lupine
      : ['#e9d5ff', '#fef08a', '#f5f5f4', '#c4b5fd', '#fde68a'];
  let flIdx = 0;
  for (let tries = 0; tries < 240 && flIdx < flowerCount; tries++) {
    const a = rand() * Math.PI * 2;
    const d = 6 + rand() * 26;
    const x = Math.cos(a) * d;
    const z = Math.sin(a) * d;
    if (contract.site === 'coastal_homestead' && Math.abs(x - 1.2) < 3.0 && z > -2) continue;
    if (contract.site === 'misty_creek' && z > 4.5 && z < 21.5) continue;
    if (contract.site === 'coastal_town' && z > 11.2 && z < 22.0) continue;
    if (contract.site === 'coastal_town' && Math.hypot((x + 11.5) / 5.2, (z + 9.5) / 4.2) < 1.0) continue;
    if (contract.hazards.some((h) => Math.hypot(h.x - x, h.z - z) < h.radius + 1.0)) continue;
    const y = getTerrainHeight(x, z, contract.site);
    dummy.position.set(x, y, z);
    dummy.rotation.set(0, rand() * Math.PI * 2, 0);
    dummy.scale.setScalar(0.75 + rand() * 0.7);
    dummy.updateMatrix();
    flowerInst.setMatrixAt(flIdx, dummy.matrix);
    fernColor.set(flowerPalette[Math.floor(rand() * flowerPalette.length)]);
    flowerInst.setColorAt(flIdx, fernColor);
    flIdx++;
  }
  flowerInst.count = flIdx;
  flowerInst.instanceMatrix.needsUpdate = true;
  if (flowerInst.instanceColor) flowerInst.instanceColor.needsUpdate = true;
  group.add(flowerInst);

  // 7. Regional Boulders (pale Rockies limestone in Kootenays, mossy granite on the coast)
  const rockGeo = new THREE.DodecahedronGeometry(1.0, 0);
  const rockMat = new THREE.MeshStandardMaterial({
    color: contract.site === 'kootenay_rockies' ? '#9c9789' : '#677067',
    roughness: 0.95,
    flatShading: true,
  });
  const rockCount = contract.site === 'coastal_town' ? 14 : 42;
  const rockInst = new THREE.InstancedMesh(rockGeo, rockMat, rockCount);
  rockInst.castShadow = true;
  rockInst.receiveShadow = true;
  let rIdx = 0;
  for (let tries = 0; tries < 180 && rIdx < rockCount; tries++) {
    const a = rand() * Math.PI * 2;
    const d = (contract.site === 'coastal_town' ? 19 : 11) + rand() * 34;
    const rx = Math.cos(a) * d;
    const rz = Math.sin(a) * d;
    if (contract.site === 'coastal_town' && rz > 10.5 && rz < 23.0) continue;
    if (contract.hazards.some((h) => Math.hypot(h.x - rx, h.z - rz) < h.radius + 2.2)) continue;
    const ry = getTerrainHeight(rx, rz, contract.site);
    const sx = 0.6 + rand() * 1.4;
    const sy = 0.35 + rand() * 0.7;
    const sz = 0.6 + rand() * 1.3;
    dummy.position.set(rx, ry + sy * 0.3, rz);
    dummy.rotation.set(rand() * 0.5, rand() * Math.PI * 2, rand() * 0.5);
    dummy.scale.set(sx, sy, sz);
    dummy.updateMatrix();
    rockInst.setMatrixAt(rIdx, dummy.matrix);
    rIdx++;
  }
  rockInst.count = rIdx;
  rockInst.instanceMatrix.needsUpdate = true;
  group.add(rockInst);

  // 8. Towering Backdrop Cascadia Forest (Instanced Conifer Ring on surrounding ridges!)
  // Includes per-instance misty dissolve fade so background trees obstructing the camera smoothly fade out!
  const applyBgTreeFadeShader = (mat: THREE.MeshStandardMaterial) => {
    mat.customProgramCacheKey = () => 'bg-tree-dither-fade';
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
          attribute float aFade;
          varying float vBgFade;`
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          vBgFade = aFade;`
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
          varying float vBgFade;
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

  const bgTreeCount = contract.site === 'kootenay_rockies' ? 115 : 195;
  const bgTrunkGeo = new THREE.CylinderGeometry(0.18, 0.45, 11, 6);
  bgTrunkGeo.translate(0, 5.5, 0);
  const bgTrunkMat = new THREE.MeshStandardMaterial({ color: '#453022', roughness: 0.95 });
  applyBgTreeFadeShader(bgTrunkMat);

  const bgCone1Geo = new THREE.ConeGeometry(3.4, 10.5, 7);
  bgCone1Geo.translate(0, 9.2, 0);
  const bgCone2Geo = new THREE.ConeGeometry(2.6, 9.0, 7);
  bgCone2Geo.translate(0, 14.2, 0);
  const bgCone3Geo = new THREE.ConeGeometry(1.7, 7.2, 7);
  bgCone3Geo.translate(0, 18.8, 0);

  const bgFolMat = new THREE.MeshStandardMaterial({
    color: '#ffffff', // white base so instanceColor renders rich sunlit Cascadia greens!
    roughness: 0.88,
    flatShading: true,
  });
  applyBgTreeFadeShader(bgFolMat);

  const bgFadeArray = new Float32Array(bgTreeCount).fill(1);
  const bgFadeAttr = new THREE.InstancedBufferAttribute(bgFadeArray, 1);
  bgFadeAttr.setUsage(THREE.DynamicDrawUsage);
  bgTrunkGeo.setAttribute('aFade', bgFadeAttr);
  bgCone1Geo.setAttribute('aFade', bgFadeAttr);
  bgCone2Geo.setAttribute('aFade', bgFadeAttr);
  bgCone3Geo.setAttribute('aFade', bgFadeAttr);

  const bgTrunks = new THREE.InstancedMesh(bgTrunkGeo, bgTrunkMat, bgTreeCount);
  const bgFol1 = new THREE.InstancedMesh(bgCone1Geo, bgFolMat, bgTreeCount);
  const bgFol2 = new THREE.InstancedMesh(bgCone2Geo, bgFolMat, bgTreeCount);
  const bgFol3 = new THREE.InstancedMesh(bgCone3Geo, bgFolMat, bgTreeCount);
  bgFol1.receiveShadow = true;

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
    // Keep the town street corridor clear of backdrop forest trunks
    if (contract.site === 'coastal_town' && tz > 10.0 && tz < 24.0) continue;
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
    bgFol1.setMatrixAt(tPlaced, dummy.matrix);
    bgFol2.setMatrixAt(tPlaced, dummy.matrix);
    bgFol3.setMatrixAt(tPlaced, dummy.matrix);

    bgTreeMeta.push({
      x: tx,
      y: ty - 0.5,
      z: tz,
      rMax: 3.55 * Math.max(sx, sz),
      yMax: ty - 0.5 + 22.8 * sy,
      fade: 1,
    });

    // Regional forest color variation
    if (contract.site === 'kootenay_rockies') {
      const rCol = rand();
      if (rCol < 0.24) {
        // Golden autumn Western Larch accents scattered across the foothills!
        col.setHSL(0.12 + (rand() - 0.5) * 0.03, 0.65 + rand() * 0.15, 0.42 + rand() * 0.1);
      } else if (rCol < 0.42) {
        // Silvery Blue Spruce / interior pine hue
        col.setHSL(0.49 + (rand() - 0.5) * 0.06, 0.28 + rand() * 0.12, 0.30 + rand() * 0.1);
      } else {
        // Sun-warmed Ponderosa Pine & interior Douglas Fir greens
        col.setHSL(0.29 + (rand() - 0.5) * 0.07, 0.34 + rand() * 0.14, 0.24 + rand() * 0.11);
      }
    } else {
      // Rich PNW forest color variation (Douglas fir emerald, Sitka spruce teal, cedar olive)
      col.setHSL(0.35 + (rand() - 0.5) * 0.08, 0.36 + rand() * 0.14, 0.22 + rand() * 0.11);
    }
    bgFol1.setColorAt(tPlaced, col);
    bgFol2.setColorAt(tPlaced, col);
    bgFol3.setColorAt(tPlaced, col);
    tPlaced++;
  }
  bgTrunks.count = tPlaced;
  bgFol1.count = tPlaced;
  bgFol2.count = tPlaced;
  bgFol3.count = tPlaced;
  bgTrunks.instanceMatrix.needsUpdate = true;
  bgFol1.instanceMatrix.needsUpdate = true;
  bgFol2.instanceMatrix.needsUpdate = true;
  bgFol3.instanceMatrix.needsUpdate = true;
  if (bgFol1.instanceColor) bgFol1.instanceColor.needsUpdate = true;
  if (bgFol2.instanceColor) bgFol2.instanceColor.needsUpdate = true;
  if (bgFol3.instanceColor) bgFol3.instanceColor.needsUpdate = true;

  group.add(bgTrunks, bgFol1, bgFol2, bgFol3);

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

  scene.add(group);

  return {
    group,
    hazardGroups,
    hazardWarningRings,
    sceneOccluders,
    waterMesh,
    sunLight,
    hemiLight,
    skyMesh,
    windAnimatedMeshes,
    updateBackgroundOcclusion,
  };
}
