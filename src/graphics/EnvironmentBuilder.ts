import * as THREE from 'three';
import { ContractSpec, HazardSpec, SiteId, WeatherId } from '../types';
import { textureCache } from './ProceduralTextures';

export interface BuiltEnvironment {
  group: THREE.Group;
  hazardGroups: Map<string, THREE.Group>;
  hazardWarningRings: THREE.Mesh[];
  waterMesh?: THREE.Mesh;
  sunLight: THREE.DirectionalLight;
  hemiLight: THREE.HemisphereLight;
  skyMesh: THREE.Mesh;
  windAnimatedMeshes: THREE.Object3D[];
  updateBackgroundOcclusion: (cameraPos: THREE.Vector3, targetPos: THREE.Vector3, dt: number) => void;
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
  const flatRadius = 23;
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
  if (site === 'misty_creek') {
    return smooth * (6.2 + ridgeNoise * 0.85);
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

function buildHazardMesh(h: HazardSpec): THREE.Group {
  let g: THREE.Group;
  switch (h.type) {
    case 'cabin':
      g = buildCabin();
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

export function buildEnvironment(
  scene: THREE.Scene,
  contract: ContractSpec
): BuiltEnvironment {
  const group = new THREE.Group();
  const rand = makeRng(contract.index * 7919 + 1337);
  const windAnimatedMeshes: THREE.Object3D[] = [];

  // 1. Sky Dome + Coastal Fog
  const { skyMesh, sunDir, fogColor, fogDensity } = createSkyDome(contract.weather);
  group.add(skyMesh);
  scene.fog = new THREE.FogExp2(fogColor, fogDensity * 0.88);
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
  }

  // 5. Place Hazards & Subtle Warning Rings
  const hazardGroups = new Map<string, THREE.Group>();
  const hazardWarningRings: THREE.Mesh[] = [];

  for (const h of contract.hazards) {
    const hGroup = buildHazardMesh(h);
    group.add(hGroup);
    hazardGroups.set(h.id, hGroup);

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

  // 6. Instanced Lush Multi-Frond PNW Sword Ferns across clearing edges & forest floor
  const fernCount = 260;
  const fernFrondGeo = buildSwordFernGeometry();
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

    // Avoid spawning inside trees, driveway center, misty creek water, or hazards
    const onDriveway = contract.site === 'coastal_homestead' && Math.abs(fx - 1.2) < 3.0 && fz > -2;
    const inCreek = contract.site === 'misty_creek' && fz > 4.5 && fz < 21.5;
    const tooClose =
      onDriveway ||
      inCreek ||
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

    fernColor.setHSL(0.30 + (rand() - 0.5) * 0.05, 0.48 + rand() * 0.14, 0.20 + rand() * 0.10);
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
  const flowerPalette = ['#e9d5ff', '#fef08a', '#f5f5f4', '#c4b5fd', '#fde68a'];
  let flIdx = 0;
  for (let tries = 0; tries < 240 && flIdx < flowerCount; tries++) {
    const a = rand() * Math.PI * 2;
    const d = 6 + rand() * 26;
    const x = Math.cos(a) * d;
    const z = Math.sin(a) * d;
    if (contract.site === 'coastal_homestead' && Math.abs(x - 1.2) < 3.0 && z > -2) continue;
    if (contract.site === 'misty_creek' && z > 4.5 && z < 21.5) continue;
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

  // 7. Mossy Coastal Boulders
  const rockGeo = new THREE.DodecahedronGeometry(1.0, 0);
  const rockMat = new THREE.MeshStandardMaterial({
    color: '#677067',
    roughness: 0.95,
    flatShading: true,
  });
  const rockCount = 42;
  const rockInst = new THREE.InstancedMesh(rockGeo, rockMat, rockCount);
  rockInst.castShadow = true;
  rockInst.receiveShadow = true;
  let rIdx = 0;
  for (let tries = 0; tries < 180 && rIdx < rockCount; tries++) {
    const a = rand() * Math.PI * 2;
    const d = 11 + rand() * 34;
    const rx = Math.cos(a) * d;
    const rz = Math.sin(a) * d;
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

  const bgTreeCount = 195;
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
    // Leave scenic ocean overlook gap on storm_bluff
    if (contract.site === 'storm_bluff' && angle > 0.25 && angle < 1.35) continue;

    const dist = 25 + rand() * 68;
    const tx = Math.cos(angle) * dist;
    const tz = Math.sin(angle) * dist;
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

    // Rich PNW forest color variation (Douglas fir emerald, Sitka spruce teal, cedar olive)
    col.setHSL(0.35 + (rand() - 0.5) * 0.08, 0.36 + rand() * 0.14, 0.22 + rand() * 0.11);
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
    waterMesh,
    sunLight,
    hemiLight,
    skyMesh,
    windAnimatedMeshes,
    updateBackgroundOcclusion,
  };
}
