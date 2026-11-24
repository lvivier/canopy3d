import * as THREE from 'three';
import {
  BranchData,
  BuckRingData,
  GraphicsQuality,
  LogSegmentData,
  SiteId,
  SpeciesSpec,
  StandingTopCutData,
  TreePlacementSpec,
  TreeRuntime,
  WeatherId,
} from '../types';
import { PNW_SPECIES } from '../data/species';
import { ensureAoUv, pbrAssets, SPECIES_BARK_PROFILES } from './PbrAssetManager';
import { applyBarkSurfaceShader, applyFoliageWindShader, FoliageWindUniforms } from './MaterialShaders';
import {
  buildBotanicalFoliageCluster,
  buildCrownScaffoldLimb,
  createTreeBotanicalContext,
  TreeBotanicalContext,
} from './FoliageCardBuilder';

export interface TreeBuildOptions {
  quality?: GraphicsQuality;
  site?: SiteId;
  weather?: WeatherId;
  windUniforms?: FoliageWindUniforms;
}

function makeRng(seed: number): () => number {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function buildFlutedTrunkGeometry(
  bottomRadius: number,
  topRadius: number,
  height: number,
  radialSegs: number,
  heightSegs: number,
  buttressFlare: number,
  leanX: number,
  leanZ: number,
  droopingLeader: boolean
): THREE.BufferGeometry {
  const geo = new THREE.CylinderGeometry(
    topRadius,
    bottomRadius,
    height,
    radialSegs,
    heightSegs,
    true
  );
  // Shift cylinder so y = 0 is at the base
  geo.translate(0, height / 2, 0);

  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    let x = pos.getX(i);
    const y = pos.getY(i);
    let z = pos.getZ(i);
    const t = Math.max(0, Math.min(1, y / height));

    // Organic root buttress flare near ground
    if (t < 0.22) {
      const flareT = Math.pow(1 - t / 0.22, 2.2);
      const angle = Math.atan2(z, x);
      const lobes = 1 + 0.16 * Math.sin(angle * 5) + 0.08 * Math.cos(angle * 3 + 1.1);
      const scale = 1 + flareT * (buttressFlare - 1) * lobes;
      x *= scale;
      z *= scale;
    }

    // Subtle trunk organic wobble + natural lean curve (zero offset at base/top when lean=0 for flush stump seam)
    if (leanX !== 0 || leanZ !== 0) {
      const curvePower = Math.pow(t, 1.35);
      x += leanX * curvePower + Math.sin(t * Math.PI * 2.2) * bottomRadius * 0.12;
      z += leanZ * curvePower + (Math.cos(t * Math.PI * 1.7) - 1) * bottomRadius * 0.12;
    }

    // Western Hemlock's iconic drooping leader tip
    if (droopingLeader && t > 0.87) {
      const tipT = (t - 0.87) / 0.13;
      x += Math.pow(tipT, 2) * 1.15;
    }

    pos.setXYZ(i, x, y, z);
  }

  geo.computeVertexNormals();
  return geo;
}

/**
 * Builds a smooth tapered organic limb mesh along a 3D Catmull-Rom spline using
 * parallel-transport frames (zero twist flips), subtle gnarled organic cross-section
 * undulation, and arc-length continuous UVs for seamless peeling bark flow.
 */
function buildTaperedSplineLimbGeometry(
  controlPoints: THREE.Vector3[],
  rStart: number,
  rEnd: number,
  tubularSegs: number,
  radialSegs: number,
  seedPhase = 0,
  opts?: { tension?: number; gnarl?: number; tileV?: number }
): THREE.BufferGeometry {
  const tension = opts?.tension ?? 0.5;
  const gnarl = opts?.gnarl ?? 1.0;
  const tileV = opts?.tileV ?? 3.8;
  const curve = new THREE.CatmullRomCurve3(controlPoints, false, 'centripetal', tension);
  const totalLen = Math.max(0.2, curve.getLength());

  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  const tangents: THREE.Vector3[] = [];
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= tubularSegs; i++) {
    const t = i / tubularSegs;
    pts.push(curve.getPoint(t));
    tangents.push(curve.getTangent(t).normalize());
  }

  // Parallel-transport (Bishop) frame along the spline
  const upRef = Math.abs(tangents[0].y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  let frameN = new THREE.Vector3().crossVectors(tangents[0], upRef).normalize();
  let frameB = new THREE.Vector3().crossVectors(tangents[0], frameN).normalize();
  const rotAxis = new THREE.Vector3();

  for (let i = 0; i <= tubularSegs; i++) {
    if (i > 0) {
      const prevT = tangents[i - 1];
      const curT = tangents[i];
      rotAxis.crossVectors(prevT, curT);
      const sinA = rotAxis.length();
      if (sinA > 1e-5) {
        rotAxis.divideScalar(sinA);
        const angle = Math.atan2(sinA, THREE.MathUtils.clamp(prevT.dot(curT), -1, 1));
        frameN.applyAxisAngle(rotAxis, angle).normalize();
        frameB.crossVectors(curT, frameN).normalize();
      }
    }

    const t = i / tubularSegs;
    const baseR = THREE.MathUtils.lerp(rStart, rEnd, Math.pow(t, 0.85));
    // Subtle organic burl/muscle undulation along crooked bends
    const swell = 1 + 0.08 * gnarl * Math.sin(t * Math.PI * 3.2 + seedPhase);
    const rRing = Math.max(0.014, baseR * swell);
    const vCoord = (t * totalLen) / tileV;

    for (let j = 0; j <= radialSegs; j++) {
      const theta = (j / radialSegs) * Math.PI * 2;
      const cosT = Math.cos(theta);
      const sinT = Math.sin(theta);
      const lobe = 1 + 0.055 * gnarl * Math.sin(theta * 2 + t * 5.0 + seedPhase);
      const rr = rRing * lobe;
      const px = pts[i].x + (frameN.x * cosT + frameB.x * sinT) * rr;
      const py = pts[i].y + (frameN.y * cosT + frameB.y * sinT) * rr;
      const pz = pts[i].z + (frameN.z * cosT + frameB.z * sinT) * rr;
      positions.push(px, py, pz);
      uvs.push(j / radialSegs, vCoord);
    }
  }

  const stride = radialSegs + 1;
  for (let i = 0; i < tubularSegs; i++) {
    for (let j = 0; j < radialSegs; j++) {
      const a = i * stride + j;
      const b = (i + 1) * stride + j;
      const c = (i + 1) * stride + (j + 1);
      const d = i * stride + (j + 1);
      indices.push(a, b, d, b, c, d);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  ensureAoUv(geo);
  return geo;
}

interface BarkPeelAnchor {
  pos: THREE.Vector3;
  normal: THREE.Vector3;
  tangentUp: THREE.Vector3;
  width: number;
  length: number;
  curlDir: number;
}

/**
 * Generates a single lightweight merged mesh of real 3D paper-thin curling mahogany bark
 * peel ribbons lifting delicately off smooth Pacific Madrone trunks and limbs.
 */
function buildArbutusPeelRibbonsGeometry(
  anchors: BarkPeelAnchor[],
  rand: () => number
): THREE.BufferGeometry | null {
  if (anchors.length === 0) return null;
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  const steps = 4;
  const side = new THREE.Vector3();
  const baseCol = new THREE.Color();
  const tipCol = new THREE.Color();

  for (const a of anchors) {
    const baseIdx = positions.length / 3;
    side.crossVectors(a.tangentUp, a.normal).normalize();
    const flipDown = rand() > 0.45 ? -1 : 1;
    const maxLift = 0.014 + rand() * 0.026;
    const twistRate = (0.28 + rand() * 0.55) * a.curlDir;

    baseCol.set('#8f3f21');
    tipCol.set(rand() > 0.42 ? '#592012' : '#ab552b');

    for (let s = 0; s <= steps; s++) {
      const u = s / steps; // 0 = attached to trunk, 1 = lifted curling papery tip
      const halfW = a.width * (0.52 - u * 0.34) * (0.85 + 0.3 * Math.sin(u * Math.PI));
      const lift = Math.pow(u, 1.75) * maxLift;
      // Curls slightly backward near the free papery tip
      const curlBack = u > 0.65 ? Math.pow((u - 0.65) / 0.35, 2) * 0.018 : 0;
      const along = u * a.length * flipDown - curlBack * flipDown;
      const lateral = Math.sin(u * Math.PI * 0.85) * a.width * twistRate;

      const cx =
        a.pos.x +
        a.tangentUp.x * along +
        a.normal.x * (0.004 + lift) +
        side.x * lateral;
      const cy =
        a.pos.y +
        a.tangentUp.y * along +
        a.normal.y * (0.004 + lift) +
        side.y * lateral;
      const cz =
        a.pos.z +
        a.tangentUp.z * along +
        a.normal.z * (0.004 + lift) +
        side.z * lateral;

      const rCol = THREE.MathUtils.lerp(baseCol.r, tipCol.r, u);
      const gCol = THREE.MathUtils.lerp(baseCol.g, tipCol.g, u);
      const bCol = THREE.MathUtils.lerp(baseCol.b, tipCol.b, u);

      // Left and right ribbon edges (slight cup curvature across width)
      positions.push(
        cx - side.x * halfW + a.normal.x * (u * 0.008),
        cy - side.y * halfW + a.normal.y * (u * 0.008),
        cz - side.z * halfW + a.normal.z * (u * 0.008)
      );
      colors.push(rCol, gCol, bCol);

      positions.push(
        cx + side.x * halfW + a.normal.x * (u * 0.012),
        cy + side.y * halfW + a.normal.y * (u * 0.012),
        cz + side.z * halfW + a.normal.z * (u * 0.012)
      );
      colors.push(rCol * 0.88, gCol * 0.88, bCol * 0.88);
    }

    for (let s = 0; s < steps; s++) {
      const i0 = baseIdx + s * 2;
      const i1 = i0 + 1;
      const i2 = i0 + 2;
      const i3 = i0 + 3;
      indices.push(i0, i2, i1, i1, i2, i3);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

function createFoliageCluster(
  spec: SpeciesSpec,
  scale: number,
  rand: () => number,
  isDeadwood: boolean,
  botanicalCtx?: TreeBotanicalContext | null,
  outwardHint?: THREE.Vector3,
  crownHeightFrac = 0.5
): THREE.Group {
  if (botanicalCtx) {
    return buildBotanicalFoliageCluster(
      botanicalCtx,
      scale,
      rand,
      isDeadwood,
      outwardHint,
      crownHeightFrac
    );
  }
  const group = new THREE.Group();
  const deadColors = ['#6e543a', '#7c6244', '#5b4632'];

  const pickColor = () => {
    const arr = isDeadwood ? deadColors : spec.foliageColors;
    return arr[Math.floor(rand() * arr.length)];
  };

  if (spec.category === 'conifer') {
    const padCount = isDeadwood ? 3 : 5 + Math.floor(rand() * 3);
    for (let i = 0; i < padCount; i++) {
      let geo: THREE.BufferGeometry;
      if (spec.crownShape === 'sweeping_cone') {
        // Cedar: flat lacy drooping sprays
        geo = new THREE.ConeGeometry(scale * (0.64 + rand() * 0.28), scale * 0.34, 7);
        geo.scale(1.22, 0.58, 1.48);
      } else if (spec.crownShape === 'tiered_spruce') {
        // Sitka Spruce: crisp layered blue-green needle fans (finer, more organic!)
        geo = new THREE.DodecahedronGeometry(scale * (0.48 + rand() * 0.24), 1);
        geo.scale(1.32, 0.48, 1.15);
      } else if (spec.crownShape === 'graceful_feathery') {
        // Western Hemlock: soft elongated feathery plumes
        geo = new THREE.DodecahedronGeometry(scale * (0.46 + rand() * 0.24), 1);
        geo.scale(1.3, 0.44, 1.38);
      } else if (spec.crownShape === 'redwood_spire') {
        // California Redwood: wide flat feathery fog-belt needle sprays
        geo = new THREE.DodecahedronGeometry(scale * (0.52 + rand() * 0.24), 1);
        geo.scale(1.42, 0.36, 1.32);
      } else if (spec.crownShape === 'ponderosa_tuft') {
        // Ponderosa Pine: chunky irregular sunlit long-needle tufts perched on open boughs
        geo = new THREE.IcosahedronGeometry(scale * (0.54 + rand() * 0.26), 1);
        geo.scale(1.22, 0.72, 1.18);
      } else if (spec.crownShape === 'larch_spire') {
        // Western Larch: airy, luminous golden-amber deciduous needle tiers
        geo = new THREE.DodecahedronGeometry(scale * (0.44 + rand() * 0.22), 1);
        geo.scale(1.36, 0.38, 1.24);
      } else if (spec.crownShape === 'blue_spruce_cone') {
        // Blue Spruce: crisp, dense stiff glacier-blue needle whorls
        geo = new THREE.ConeGeometry(scale * (0.58 + rand() * 0.22), scale * 0.42, 7);
        geo.scale(1.18, 0.65, 1.18);
      } else if (spec.crownShape === 'white_pine_tiered') {
        // Western White Pine: soft horizontal layered blue-green needle plumes
        geo = new THREE.DodecahedronGeometry(scale * (0.52 + rand() * 0.24), 1);
        geo.scale(1.46, 0.34, 1.34);
      } else {
        // Douglas Fir: lush layered evergreen bough pads
        geo = new THREE.DodecahedronGeometry(scale * (0.5 + rand() * 0.26), 1);
        geo.scale(1.28, 0.52, 1.18);
      }

      const mat = new THREE.MeshStandardMaterial({
        color: pickColor(),
        roughness: 0.84,
        metalness: 0.02,
        flatShading: true,
      });

      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(
        (rand() - 0.5) * scale * 0.95,
        (rand() - 0.5) * scale * 0.3,
        (rand() - 0.5) * scale * 0.95
      );
      mesh.rotation.set(
        (rand() - 0.5) * 0.3,
        rand() * Math.PI * 2,
        (rand() - 0.5) * 0.3
      );
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
  } else if (spec.crownShape === 'weeping_curtain') {
    // Weeping Willow: soft airy crown tuft + long cascading chartreuse leaf drapes hanging downward!
    const topGeo = new THREE.IcosahedronGeometry(scale * 0.48, 1);
    topGeo.scale(1.15, 0.45, 1.15);
    const topMesh = new THREE.Mesh(
      topGeo,
      new THREE.MeshStandardMaterial({ color: pickColor(), roughness: 0.78, flatShading: true })
    );
    topMesh.position.y = scale * 0.1;
    topMesh.castShadow = true;
    topMesh.receiveShadow = true;
    group.add(topMesh);

    const curtainCount = isDeadwood ? 3 : 6 + Math.floor(rand() * 3);
    for (let i = 0; i < curtainCount; i++) {
      const a = (i / curtainCount) * Math.PI * 2 + rand() * 0.5;
      const rad = scale * (0.24 + rand() * 0.38);
      const len = scale * (1.15 + rand() * 0.85);
      const frondGeo = new THREE.ConeGeometry(scale * (0.12 + rand() * 0.06), len, 5);
      // Point tip downward like hanging willow streamers
      frondGeo.rotateX(Math.PI);
      frondGeo.translate(0, -len * 0.5, 0);
      const mesh = new THREE.Mesh(
        frondGeo,
        new THREE.MeshStandardMaterial({ color: pickColor(), roughness: 0.8, flatShading: true })
      );
      mesh.position.set(Math.cos(a) * rad, scale * 0.05, Math.sin(a) * rad);
      mesh.rotation.set((rand() - 0.5) * 0.16, rand() * Math.PI, (rand() - 0.5) * 0.16);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
  } else if (spec.crownShape === 'layered_garden') {
    // Japanese Maple ('Bloodgood'): sculptural horizontal flattened crimson cloud tiers!
    const tierCount = isDeadwood ? 2 : 4 + Math.floor(rand() * 2);
    for (let i = 0; i < tierCount; i++) {
      const r = scale * (0.58 + rand() * 0.34);
      const geo = new THREE.IcosahedronGeometry(r, 1);
      geo.scale(1.48, 0.34, 1.32);
      const mat = new THREE.MeshStandardMaterial({
        color: pickColor(),
        roughness: 0.74,
        metalness: 0.03,
        flatShading: true,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(
        (rand() - 0.5) * scale * 0.95,
        (i - tierCount * 0.4) * scale * 0.24,
        (rand() - 0.5) * scale * 0.95
      );
      mesh.rotation.y = rand() * Math.PI * 2;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
  } else if (spec.crownShape === 'blooming_hedge') {
    // Common Lilac: lush heart-green leaf dome studded with fragrant lavender-violet flower panicles!
    const leafColors = isDeadwood ? deadColors : spec.foliageColors.slice(0, 3);
    const bloomColors = isDeadwood ? deadColors : spec.foliageColors.slice(3);
    const leafCount = isDeadwood ? 2 : 3 + Math.floor(rand() * 2);
    for (let i = 0; i < leafCount; i++) {
      const r = scale * (0.56 + rand() * 0.28);
      const geo = new THREE.IcosahedronGeometry(r, 1);
      geo.scale(1.12, 0.85, 1.12);
      const mesh = new THREE.Mesh(
        geo,
        new THREE.MeshStandardMaterial({
          color: leafColors[Math.floor(rand() * leafColors.length)],
          roughness: 0.8,
          flatShading: true,
        })
      );
      mesh.position.set((rand() - 0.5) * scale * 0.75, (rand() - 0.4) * scale * 0.4, (rand() - 0.5) * scale * 0.75);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
    if (!isDeadwood) {
      const panicleCount = 4 + Math.floor(rand() * 3);
      for (let p = 0; p < panicleCount; p++) {
        const a = (p / panicleCount) * Math.PI * 2 + rand() * 0.5;
        const dist = scale * (0.35 + rand() * 0.45);
        const plumeGeo = new THREE.ConeGeometry(scale * 0.22, scale * 0.62, 6);
        const plume = new THREE.Mesh(
          plumeGeo,
          new THREE.MeshStandardMaterial({
            color: bloomColors[Math.floor(rand() * bloomColors.length)],
            roughness: 0.72,
            flatShading: true,
          })
        );
        plume.position.set(Math.cos(a) * dist, scale * (0.28 + rand() * 0.25), Math.sin(a) * dist);
        plume.rotation.set((rand() - 0.5) * 0.45, rand() * Math.PI, (rand() - 0.5) * 0.45);
        plume.castShadow = true;
        group.add(plume);
      }
    }
  } else if (spec.crownShape === 'smoky_plume') {
    // Eurasian Smoke Tree ('Royal Purple'): deep burgundy leaf core + airy purple-rose smoke haze!
    const coreColors = isDeadwood ? deadColors : spec.foliageColors.slice(0, 2);
    const smokeColors = isDeadwood ? deadColors : spec.foliageColors.slice(2);
    const coreCount = isDeadwood ? 2 : 3;
    for (let i = 0; i < coreCount; i++) {
      const r = scale * (0.52 + rand() * 0.24);
      const geo = new THREE.IcosahedronGeometry(r, 1);
      const mesh = new THREE.Mesh(
        geo,
        new THREE.MeshStandardMaterial({
          color: coreColors[Math.floor(rand() * coreColors.length)],
          roughness: 0.82,
          flatShading: true,
        })
      );
      mesh.position.set((rand() - 0.5) * scale * 0.65, (rand() - 0.4) * scale * 0.35, (rand() - 0.5) * scale * 0.65);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
    if (!isDeadwood) {
      const puffCount = 5 + Math.floor(rand() * 3);
      for (let i = 0; i < puffCount; i++) {
        const a = (i / puffCount) * Math.PI * 2 + rand() * 0.4;
        const dist = scale * (0.45 + rand() * 0.48);
        const r = scale * (0.42 + rand() * 0.28);
        const puffGeo = new THREE.IcosahedronGeometry(r, 1);
        const puff = new THREE.Mesh(
          puffGeo,
          new THREE.MeshStandardMaterial({
            color: smokeColors[Math.floor(rand() * smokeColors.length)],
            roughness: 0.92,
            transparent: true,
            opacity: 0.64,
            flatShading: true,
          })
        );
        puff.position.set(Math.cos(a) * dist, scale * (0.18 + rand() * 0.42), Math.sin(a) * dist);
        group.add(puff);
      }
    }
  } else if (spec.crownShape === 'rhody_bloom') {
    // Pacific Rhododendron: glossy dark evergreen leaf dome studded with vivid rose-magenta flower trusses!
    const leafColors = isDeadwood ? deadColors : spec.foliageColors.slice(0, 3);
    const bloomColors = isDeadwood ? deadColors : spec.foliageColors.slice(3);
    const leafCount = isDeadwood ? 2 : 4;
    for (let i = 0; i < leafCount; i++) {
      const r = scale * (0.56 + rand() * 0.26);
      const geo = new THREE.IcosahedronGeometry(r, 1);
      geo.scale(1.18, 0.78, 1.15);
      const mesh = new THREE.Mesh(
        geo,
        new THREE.MeshStandardMaterial({
          color: leafColors[Math.floor(rand() * leafColors.length)],
          roughness: 0.62,
          metalness: 0.05,
          flatShading: true,
        })
      );
      mesh.position.set(
        (rand() - 0.5) * scale * 0.75,
        (rand() - 0.4) * scale * 0.38,
        (rand() - 0.5) * scale * 0.75
      );
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
    if (!isDeadwood) {
      const trussCount = 4 + Math.floor(rand() * 3);
      for (let p = 0; p < trussCount; p++) {
        const a = (p / trussCount) * Math.PI * 2 + rand() * 0.45;
        const dist = scale * (0.32 + rand() * 0.42);
        const truss = new THREE.Mesh(
          new THREE.IcosahedronGeometry(scale * (0.24 + rand() * 0.1), 1),
          new THREE.MeshStandardMaterial({
            color: bloomColors[Math.floor(rand() * bloomColors.length)],
            roughness: 0.68,
            flatShading: true,
          })
        );
        truss.position.set(Math.cos(a) * dist, scale * (0.22 + rand() * 0.28), Math.sin(a) * dist);
        truss.castShadow = true;
        group.add(truss);
      }
    }
  } else if (spec.crownShape === 'gnarled_madrone') {
    // Pacific Arbutus: glossy oval evergreen foliage pads with subtle coral-orange coastal berry clusters!
    const leafColors = isDeadwood ? deadColors : spec.foliageColors.slice(0, 4);
    const berryColor = spec.foliageColors[4] ?? '#d96e46';
    const padCount = isDeadwood ? 2 : 4 + Math.floor(rand() * 2);
    for (let i = 0; i < padCount; i++) {
      const r = scale * (0.56 + rand() * 0.3);
      const geo = new THREE.IcosahedronGeometry(r, 1);
      geo.scale(1.26, 0.68, 1.18);
      const mesh = new THREE.Mesh(
        geo,
        new THREE.MeshStandardMaterial({
          color: leafColors[Math.floor(rand() * leafColors.length)],
          roughness: 0.58,
          metalness: 0.06,
          flatShading: true,
        })
      );
      mesh.position.set(
        (rand() - 0.5) * scale * 0.9,
        (rand() - 0.35) * scale * 0.45,
        (rand() - 0.5) * scale * 0.9
      );
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
    if (!isDeadwood && rand() > 0.35) {
      for (let b = 0; b < 2; b++) {
        const berry = new THREE.Mesh(
          new THREE.IcosahedronGeometry(scale * 0.15, 0),
          new THREE.MeshStandardMaterial({ color: berryColor, roughness: 0.55, flatShading: true })
        );
        berry.position.set(
          (rand() - 0.5) * scale * 0.75,
          scale * (0.15 + rand() * 0.25),
          (rand() - 0.5) * scale * 0.75
        );
        group.add(berry);
      }
    }
  } else if (spec.crownShape === 'eucalyptus_plume') {
    // Blue Gum Eucalyptus: airy silver-blue foliage tufts with pendulous hanging sickle-leaf drapes!
    const tuftCount = isDeadwood ? 2 : 3 + Math.floor(rand() * 2);
    for (let i = 0; i < tuftCount; i++) {
      const r = scale * (0.48 + rand() * 0.25);
      const geo = new THREE.IcosahedronGeometry(r, 1);
      geo.scale(1.12, 0.72, 1.12);
      const mesh = new THREE.Mesh(
        geo,
        new THREE.MeshStandardMaterial({
          color: pickColor(),
          roughness: 0.72,
          metalness: 0.04,
          flatShading: true,
        })
      );
      mesh.position.set(
        (rand() - 0.5) * scale * 0.8,
        (rand() - 0.2) * scale * 0.35,
        (rand() - 0.5) * scale * 0.8
      );
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
    const drapeCount = isDeadwood ? 2 : 5 + Math.floor(rand() * 2);
    for (let i = 0; i < drapeCount; i++) {
      const a = (i / drapeCount) * Math.PI * 2 + rand() * 0.5;
      const rad = scale * (0.28 + rand() * 0.36);
      const len = scale * (0.85 + rand() * 0.65);
      const drapeGeo = new THREE.ConeGeometry(scale * (0.15 + rand() * 0.07), len, 5);
      drapeGeo.rotateX(Math.PI);
      drapeGeo.translate(0, -len * 0.5, 0);
      const drape = new THREE.Mesh(
        drapeGeo,
        new THREE.MeshStandardMaterial({
          color: pickColor(),
          roughness: 0.74,
          flatShading: true,
        })
      );
      drape.position.set(Math.cos(a) * rad, scale * 0.05, Math.sin(a) * rad);
      drape.rotation.set((rand() - 0.5) * 0.22, rand() * Math.PI, (rand() - 0.5) * 0.22);
      drape.castShadow = true;
      group.add(drape);
    }
  } else if (spec.crownShape === 'chokecherry_thicket') {
    // Chokecherry: bushy deep-green oval thicket pads studded with white raceme blossoms & ruby berries
    const leafColors = isDeadwood ? deadColors : spec.foliageColors.slice(0, 3);
    const blossomColor = spec.foliageColors[3] ?? '#f3f1e8';
    const berryColor = spec.foliageColors[4] ?? '#6b1d35';
    const leafCount = isDeadwood ? 2 : 4 + Math.floor(rand() * 2);
    for (let i = 0; i < leafCount; i++) {
      const r = scale * (0.52 + rand() * 0.26);
      const geo = new THREE.IcosahedronGeometry(r, 1);
      geo.scale(1.16, 0.84, 1.12);
      const mesh = new THREE.Mesh(
        geo,
        new THREE.MeshStandardMaterial({
          color: leafColors[Math.floor(rand() * leafColors.length)],
          roughness: 0.76,
          flatShading: true,
        })
      );
      mesh.position.set(
        (rand() - 0.5) * scale * 0.88,
        (rand() - 0.35) * scale * 0.48,
        (rand() - 0.5) * scale * 0.88
      );
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
    if (!isDeadwood) {
      for (let b = 0; b < 3; b++) {
        const isBlossom = b < 2;
        const accent = new THREE.Mesh(
          isBlossom
            ? new THREE.ConeGeometry(scale * 0.14, scale * 0.42, 5)
            : new THREE.IcosahedronGeometry(scale * 0.14, 0),
          new THREE.MeshStandardMaterial({
            color: isBlossom ? blossomColor : berryColor,
            roughness: 0.55,
            flatShading: true,
          })
        );
        accent.position.set(
          (rand() - 0.5) * scale * 0.85,
          scale * (0.1 + rand() * 0.34),
          (rand() - 0.5) * scale * 0.85
        );
        accent.rotation.set((rand() - 0.5) * 0.5, rand() * Math.PI, (rand() - 0.5) * 0.5);
        group.add(accent);
      }
    }
  } else if (spec.crownShape === 'aspen_shimmer') {
    // Trembling Aspen: airy shimmering clusters of golden-yellow & chartreuse coin leaves
    const puffCount = isDeadwood ? 2 : 5 + Math.floor(rand() * 3);
    for (let i = 0; i < puffCount; i++) {
      const r = scale * (0.48 + rand() * 0.26);
      const geo = new THREE.IcosahedronGeometry(r, 1);
      geo.scale(1.15, 0.88, 1.15);
      const mesh = new THREE.Mesh(
        geo,
        new THREE.MeshStandardMaterial({
          color: pickColor(),
          roughness: 0.62,
          metalness: 0.06,
          flatShading: true,
        })
      );
      mesh.position.set(
        (rand() - 0.5) * scale * 0.92,
        (rand() - 0.25) * scale * 0.65,
        (rand() - 0.5) * scale * 0.92
      );
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
  } else {
    // Deciduous: Bigleaf Maple / Red Alder / White Poplar (shimmering silver-backed) lush sunlit leaf canopies
    const puffCount = isDeadwood ? 2 : spec.crownShape === 'silver_poplar' ? 5 + Math.floor(rand() * 3) : 4 + Math.floor(rand() * 3);
    for (let i = 0; i < puffCount; i++) {
      const r = scale * (0.62 + rand() * 0.36);
      const geo = new THREE.IcosahedronGeometry(r, 1);
      // Organic ruffled leaf cluster displacement
      const pos = geo.attributes.position;
      for (let v = 0; v < pos.count; v++) {
        const vx = pos.getX(v);
        const vy = pos.getY(v);
        const vz = pos.getZ(v);
        const n = 0.86 + Math.sin(vx * 5 + vy * 3) * 0.14 + Math.cos(vz * 4) * 0.1;
        pos.setXYZ(v, vx * n, vy * n * 0.82, vz * n);
      }
      geo.computeVertexNormals();

      const mat = new THREE.MeshStandardMaterial({
        color: pickColor(),
        roughness: spec.crownShape === 'silver_poplar' ? 0.68 : 0.78,
        metalness: spec.crownShape === 'silver_poplar' ? 0.06 : 0.03,
        flatShading: true,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(
        (rand() - 0.5) * scale * 0.95,
        (rand() - 0.35) * scale * 0.55,
        (rand() - 0.5) * scale * 0.95
      );
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
  }

  group.userData.isFoliage = true;
  return group;
}

export function buildTreeRuntime(
  spec: TreePlacementSpec,
  options: TreeBuildOptions = {}
): TreeRuntime {
  const quality: GraphicsQuality = options.quality ?? 'high';
  const site: SiteId = options.site ?? 'coastal_homestead';
  const weather: WeatherId = options.weather ?? 'sunny_morning';
  const speciesSpec = PNW_SPECIES[spec.species];
  const isArbutus = spec.species === 'arbutus';
  const isGarryOak = spec.species === 'garry_oak';
  const isSmokeTree = spec.species === 'smoke_tree';
  const isSculpturalHardwood = isArbutus || isGarryOak;
  const rand = makeRng(spec.seed);
  const barkProfile = SPECIES_BARK_PROFILES[spec.species];

  const rootGroup = new THREE.Group();
  rootGroup.position.set(spec.x, 0, spec.z);

  const baseRadius = Math.max(0.22, spec.height * speciesSpec.radiusRatio);
  const cutHeight = isSmokeTree
    ? Math.max(0.42, spec.height * 0.052)
    : spec.height < 11
      ? Math.max(0.58, spec.height * 0.075)
      : Math.min(1.15, Math.max(0.85, spec.height * 0.055));

  const upperHeightEst = isSmokeTree
    ? Math.max(2.6, (spec.height - cutHeight) * 0.42)
    : Math.max(4, spec.height - cutHeight);
  const trunkCircumference = 2 * Math.PI * baseRadius;
  const repeatX = Math.max(1, Math.round(trunkCircumference / 1.35));
  const repeatY = Math.max(2, Math.round(upperHeightEst / barkProfile.metersPerTileV));

  const pbrBark = pbrAssets.getPbrSet(barkProfile.textureId, quality, {
    repeatX,
    repeatY,
  });

  const pbrEndGrain = pbrAssets.getPbrSet('sawn_end_grain', quality, {
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
  });

  const wetClearcoat =
    weather === 'light_rain'
      ? 0.72 * barkProfile.wetSheen
      : weather === 'coastal_gale'
        ? 0.45 * barkProfile.wetSheen
        : weather === 'misty_fog'
          ? 0.16 * barkProfile.wetSheen
          : 0.0;

  let barkMat: THREE.MeshStandardMaterial;
  if (quality === 'high') {
    const physBark = new THREE.MeshPhysicalMaterial({
      map: pbrBark.map,
      normalMap: pbrBark.normalMap,
      normalScale: new THREE.Vector2(barkProfile.normalScale, barkProfile.normalScale),
      roughnessMap: pbrBark.armMap,
      aoMap: pbrBark.armMap,
      aoMapIntensity: barkProfile.aoIntensity,
      color: new THREE.Color(barkProfile.tint),
      roughness: barkProfile.roughness,
      metalness: 0.02,
      clearcoat: wetClearcoat,
      clearcoatRoughness: weather === 'light_rain' ? 0.22 : 0.3,
    });
    applyBarkSurfaceShader(physBark, {
      site,
      weather,
      mossAffinity: barkProfile.mossAffinity,
      arbutusMode: isArbutus,
    });
    barkMat = physBark;
  } else {
    barkMat = new THREE.MeshStandardMaterial({
      map: pbrBark.map,
      normalMap: pbrBark.normalMap,
      normalScale: new THREE.Vector2(barkProfile.normalScale * 0.85, barkProfile.normalScale * 0.85),
      color: new THREE.Color(barkProfile.tint),
      roughness: barkProfile.roughness,
      metalness: 0.02,
    });
    if (isArbutus) {
      applyBarkSurfaceShader(barkMat, {
        site,
        weather,
        mossAffinity: barkProfile.mossAffinity,
        arbutusMode: true,
      });
    }
  }

  // Lightweight shared material for real 3D curling papery Pacific Madrone bark peel ribbons
  const arbutusPeelMat = isArbutus
    ? new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.8,
        metalness: 0.02,
        side: THREE.DoubleSide,
      })
    : null;
  // Weathered silver-gray coastal deadwood snag material for gnarled Pacific Madrone & Garry Oak elbows
  const arbutusSnagMat =
    isArbutus || isGarryOak
      ? new THREE.MeshStandardMaterial({
          color: isGarryOak ? '#7f7b72' : '#888176',
          roughness: 0.95,
          metalness: 0.01,
        })
      : null;

  // Per-tree botanical sprig context for realistic species foliage (with conifer vs broadleaf deadwood)
  const botanicalCtx = createTreeBotanicalContext(
    spec.species,
    speciesSpec.category,
    quality,
    barkMat,
    options.windUniforms
  );

  // Blend species heartwood & sapwood into our Step-3 photographed chainsaw end-grain!
  const endTint = new THREE.Color(speciesSpec.sapwoodColor).lerp(
    new THREE.Color(speciesSpec.heartwoodColor),
    0.35
  );
  // Keep luminance lifted so photographed grain doesn't darken excessively
  endTint.lerp(new THREE.Color('#ffffff'), 0.42);

  const endGrainMat = new THREE.MeshStandardMaterial({
    map: pbrEndGrain.map,
    normalMap: quality === 'high' ? pbrEndGrain.normalMap : null,
    normalScale: new THREE.Vector2(0.65, 0.65),
    roughnessMap: quality === 'high' ? pbrEndGrain.armMap : null,
    aoMap: quality === 'high' ? pbrEndGrain.armMap : null,
    aoMapIntensity: 0.45,
    color: endTint,
    roughness: 0.82,
    metalness: 0.02,
  });

  const freshWoodMat = new THREE.MeshStandardMaterial({
    color: speciesSpec.heartwoodColor,
    roughness: 0.72,
    metalness: 0.02,
  });

  // 1. Stump (stays rooted in ground after felling!)
  const stumpGroup = new THREE.Group();
  const stumpGeo = buildFlutedTrunkGeometry(
    baseRadius * (isGarryOak ? 1.22 : isArbutus ? 1.16 : 1.06),
    baseRadius * 0.95,
    cutHeight,
    quality === 'high' ? 36 : 24,
    5,
    speciesSpec.buttressFlare * (isGarryOak ? 1.32 : isArbutus ? 1.24 : 1.0),
    0,
    0,
    false
  );
  // Match vertical bark texel density 1:1 between stump and butt log across the cut line
  const stumpUv = stumpGeo.attributes.uv;
  const stumpVScale = cutHeight / upperHeightEst;
  for (let i = 0; i < stumpUv.count; i++) {
    stumpUv.setY(i, stumpUv.getY(i) * stumpVScale);
  }
  stumpUv.needsUpdate = true;
  ensureAoUv(stumpGeo);
  const stumpMesh = new THREE.Mesh(stumpGeo, barkMat);
  stumpMesh.castShadow = true;
  stumpMesh.receiveShadow = true;
  stumpMesh.userData = { treeId: spec.id, part: 'stump' };
  stumpGroup.add(stumpMesh);

  // Stump top end-grain cap (seamless flush CircleGeometry — zero Z-fighting!)
  const stumpCapGeo = new THREE.CircleGeometry(baseRadius * 0.95, quality === 'high' ? 36 : 24);
  stumpCapGeo.rotateX(-Math.PI / 2);
  ensureAoUv(stumpCapGeo);
  const stumpCap = new THREE.Mesh(stumpCapGeo, endGrainMat);
  stumpCap.position.y = cutHeight;
  stumpCap.receiveShadow = true;
  stumpGroup.add(stumpCap);

  rootGroup.add(stumpGroup);

  // 2. Trunk Pivot (starts at cutHeight; hinges around XZ axis during felling!)
  const trunkPivot = new THREE.Group();
  trunkPivot.position.y = cutHeight;
  rootGroup.add(trunkPivot);

  const upperHeight = isSmokeTree
    ? Math.max(2.6, (spec.height - cutHeight) * 0.42)
    : spec.height - cutHeight;
  const leanDist = spec.leanStrength * spec.height * 0.09;
  const leanX = Math.cos(spec.leanAngle) * leanDist;
  const leanZ = Math.sin(spec.leanAngle) * leanDist;

  const trunkTopRadius = isGarryOak
    ? baseRadius * 0.15
    : isArbutus
      ? baseRadius * 0.16
      : speciesSpec.category === 'deciduous'
        ? baseRadius * 0.24
        : baseRadius * 0.08;

  // Seeded sculptural serpentine/wind-carved contortion parameters for Pacific Madrone & coastal Garry Oak
  const madroneAxis = spec.leanAngle + (rand() - 0.5) * 1.1;
  const madroneCos = Math.cos(madroneAxis);
  const madroneSin = Math.sin(madroneAxis);
  const madroneSweepMag = isArbutus
    ? spec.height * (0.175 + rand() * 0.08)
    : isGarryOak
      ? spec.height * (0.115 + rand() * 0.06)
      : 0;
  const madroneTwistMag = isArbutus
    ? spec.height * (0.095 + rand() * 0.055)
    : isGarryOak
      ? spec.height * (0.072 + rand() * 0.045)
      : 0;
  const madronePhaseA = rand() * Math.PI * 2;
  const madronePhaseB = rand() * Math.PI * 2;
  const madroneSign = rand() > 0.5 ? 1 : -1;

  const getTrunkCenterAt = (localY: number): THREE.Vector3 => {
    const t = Math.max(0, Math.min(1, localY / upperHeight));
    const cp = Math.pow(t, 1.35);
    let dx = leanX * cp + Math.sin(t * Math.PI * 2.2) * baseRadius * 0.12;
    let dz = leanZ * cp + (Math.cos(t * Math.PI * 1.7) - 1) * baseRadius * 0.12;
    if (isArbutus) {
      // Keep felling notch / back-cut collar (localY <= ~1.15m) straight & clean for exact chainsaw cuts,
      // then sweep boldly into an unmistakable gnarled coastal madrone S-curve & elbow!
      const s = THREE.MathUtils.smoothstep(localY, 1.05, upperHeight * 0.92);
      const sPow = Math.pow(s, 1.12);
      const alongSweep =
        madroneSweepMag * sPow +
        Math.sin(s * Math.PI * 1.85 + madronePhaseA * 0.35) * madroneTwistMag * 0.68 * s;
      const crossElbow =
        madroneSign *
        madroneTwistMag *
        (Math.sin(s * Math.PI * 2.25) * 0.85 +
          Math.sin(s * Math.PI * 3.6 + madronePhaseB * 0.4) * 0.28) *
        s;
      dx += madroneCos * alongSweep - madroneSin * crossElbow;
      dz += madroneSin * alongSweep + madroneCos * crossElbow;
    } else if (isGarryOak) {
      // Stout wind-carved coastal Garry Oak bole: clean felling collar, then crooked gnarled bend & angular shoulder
      const s = THREE.MathUtils.smoothstep(localY, 1.05, upperHeight * 0.88);
      const alongBend =
        madroneSweepMag * Math.pow(s, 1.05) +
        Math.sin(s * Math.PI * 2.4 + madronePhaseA * 0.45) * madroneTwistMag * 0.72 * s;
      const crossKink =
        madroneSign *
        madroneTwistMag *
        (Math.sin(s * Math.PI * 1.75) * 0.75 +
          Math.sin(s * Math.PI * 4.1 + madronePhaseB * 0.5) * 0.32) *
        s;
      dx += madroneCos * alongBend - madroneSin * crossKink;
      dz += madroneSin * alongBend + madroneCos * crossKink;
    }
    if (speciesSpec.droopingLeader && t > 0.87) {
      const tipT = (t - 0.87) / 0.13;
      dx += Math.pow(tipT, 2) * 1.15;
    }
    return new THREE.Vector3(dx, localY, dz);
  };

  const getTrunkRadiusAt = (localY: number): number => {
    const t = Math.max(0, Math.min(1, localY / upperHeight));
    let r = THREE.MathUtils.lerp(baseRadius * 0.95, trunkTopRadius, isGarryOak ? Math.pow(t, 1.45) : t);
    if (isArbutus || isGarryOak) {
      // Organic gnarled burl & fork swell along crooked bends (above the felling collar)
      const s = THREE.MathUtils.smoothstep(localY, 1.1, upperHeight * 0.4);
      r *= 1 + s * (isGarryOak ? 0.1 : 0.08) * Math.sin(t * Math.PI * 4.5 + madronePhaseA);
    }
    return r;
  };

  // Optional standing top-down piecing cuts (descending total heights -> localY along trunkPivot)
  const standingLocalYsDesc = (spec.standingTopCutHeights ?? [])
    .map((h) => Math.max(4.5, Math.min(upperHeight - 2.5, h - cutHeight)))
    .sort((a, b) => b - a);
  const standingLocalYsAsc = [...standingLocalYsDesc].reverse();
  const minStandingLocalY =
    standingLocalYsAsc.length > 0 ? standingLocalYsAsc[0] : Infinity;

  // Pre-compute bucking cut planes so the trunk is seamlessly built from real buckable sawlog segments!
  const buckSpacing = 4.2;
  const maxBuckDist = Math.min(
    upperHeight * 0.68,
    16.5,
    minStandingLocalY < Infinity ? minStandingLocalY - 1.4 : Infinity
  );
  const buckCutDistances: number[] = [];
  for (let d = 3.8; d <= maxBuckDist; d += buckSpacing) {
    buckCutDistances.push(d);
  }

  const cutBounds = [0, ...buckCutDistances, ...standingLocalYsAsc, upperHeight];
  const segments: LogSegmentData[] = [];

  for (let sIdx = 0; sIdx < cutBounds.length - 1; sIdx++) {
    const yStart = cutBounds[sIdx];
    const yEnd = cutBounds[sIdx + 1];
    const segLen = Math.max(0.2, yEnd - yStart);
    const midY = (yStart + yEnd) / 2;
    const midCenter = getTrunkCenterAt(midY);
    const rStart = getTrunkRadiusAt(yStart);
    const rEnd = getTrunkRadiusAt(yEnd);

    const segGroup = new THREE.Group();
    segGroup.position.copy(midCenter);

    const radialSegs = sIdx === 0 ? (quality === 'high' ? 36 : 24) : isSculpturalHardwood ? 20 : 16;
    const segHeightSegs = Math.max(
      isSculpturalHardwood ? 8 : 4,
      Math.round((segLen / upperHeight) * (isSculpturalHardwood ? 30 : 16))
    );
    const segGeo = new THREE.CylinderGeometry(rEnd, rStart, segLen, radialSegs, segHeightSegs, true);
    const pos = segGeo.attributes.position;
    const uv = segGeo.attributes.uv;
    for (let vIdx = 0; vIdx < pos.count; vIdx++) {
      const vx = pos.getX(vIdx);
      const vy = pos.getY(vIdx); // -segLen/2 .. +segLen/2
      const vz = pos.getZ(vIdx);
      const globalY = midY + vy;
      const c = getTrunkCenterAt(globalY);
      let sx = vx;
      let sz = vz;
      if (isSculpturalHardwood && globalY > 1.1) {
        const linR = THREE.MathUtils.lerp(rStart, rEnd, (vy + segLen * 0.5) / Math.max(0.001, segLen));
        const curR = getTrunkRadiusAt(globalY);
        const ang = Math.atan2(vz, vx);
        const swell = (curR / Math.max(0.01, linR)) * (1 + (isGarryOak ? 0.065 : 0.045) * Math.sin(ang * 3 + globalY * 1.35 + madronePhaseA));
        sx *= swell;
        sz *= swell;
      }
      pos.setXYZ(vIdx, sx + (c.x - midCenter.x), vy, sz + (c.z - midCenter.z));
      // Keep bark V texture coordinate continuous seamlessly across segment boundaries!
      uv.setY(vIdx, globalY / upperHeight);
    }
    segGeo.computeVertexNormals();
    ensureAoUv(segGeo);

    const segBarkMat = sIdx === 0 ? barkMat.clone() : barkMat;
    const segBarkMesh = new THREE.Mesh(segGeo, segBarkMat);
    segBarkMesh.castShadow = true;
    segBarkMesh.receiveShadow = true;
    segBarkMesh.userData = { treeId: spec.id, part: 'trunk' };
    segGroup.add(segBarkMesh);

    // Add real 3D paper-thin curling mahogany bark peel ribbons along smooth upper Arbutus trunk segments
    if (isArbutus && arbutusPeelMat && yEnd > 1.35) {
      const peelStart = Math.max(yStart + 0.15, 1.35);
      const peelSpan = Math.max(0, yEnd - 0.15 - peelStart);
      const peelCount = Math.round(peelSpan * (quality === 'high' ? 4.5 : 2.5));
      const anchors: BarkPeelAnchor[] = [];
      for (let p = 0; p < peelCount; p++) {
        const py = peelStart + rand() * peelSpan;
        const c0 = getTrunkCenterAt(py);
        const c1 = getTrunkCenterAt(Math.min(upperHeight, py + 0.18));
        const tUp = c1.clone().sub(c0).normalize();
        const rHere = getTrunkRadiusAt(py);
        const theta = rand() * Math.PI * 2;
        const norm = new THREE.Vector3(Math.cos(theta), 0, Math.sin(theta));
        // Orthogonalize outward normal against curved trunk tangent
        norm.addScaledVector(tUp, -norm.dot(tUp)).normalize();
        const posLocal = c0.clone().sub(midCenter).addScaledVector(norm, rHere * 0.99);
        anchors.push({
          pos: posLocal,
          normal: norm,
          tangentUp: tUp,
          width: 0.045 + rand() * 0.065,
          length: 0.22 + rand() * 0.36,
          curlDir: rand() > 0.5 ? 1 : -1,
        });
      }
      const peelGeo = buildArbutusPeelRibbonsGeometry(anchors, rand);
      if (peelGeo) {
        const peelMesh = new THREE.Mesh(peelGeo, arbutusPeelMat);
        peelMesh.castShadow = false;
        peelMesh.receiveShadow = true;
        segGroup.add(peelMesh);
      }
    }

    const startCenter = getTrunkCenterAt(yStart);
    const endCenter = getTrunkCenterAt(yEnd);

    // Bottom end-grain cross-section cap (visible on butt log immediately; revealed on cut for upper logs!)
    const bottomCapGeo = new THREE.CircleGeometry(rStart, radialSegs);
    bottomCapGeo.rotateX(Math.PI / 2);
    ensureAoUv(bottomCapGeo);
    const bottomCap = new THREE.Mesh(bottomCapGeo, endGrainMat);
    bottomCap.position.set(startCenter.x - midCenter.x, yStart - midCenter.y, startCenter.z - midCenter.z);
    bottomCap.visible = sIdx === 0;
    segGroup.add(bottomCap);

    // Top end-grain cross-section cap (revealed when this segment's upper bucking cut is sliced!)
    const topCapGeo = new THREE.CircleGeometry(rEnd, radialSegs);
    topCapGeo.rotateX(-Math.PI / 2);
    ensureAoUv(topCapGeo);
    const topCap = new THREE.Mesh(topCapGeo, endGrainMat);
    topCap.position.set(endCenter.x - midCenter.x, yEnd - midCenter.y, endCenter.z - midCenter.z);
    topCap.visible = false;
    segGroup.add(topCap);

    trunkPivot.add(segGroup);
    segments.push({
      index: sIdx,
      yStart,
      yEnd,
      avgRadius: (rStart + rEnd) * 0.5,
      group: segGroup,
      barkMesh: segBarkMesh,
      bottomCap,
      topCap,
      detached: false,
    });
  }

  const trunkMesh = segments[0].barkMesh;

  const findSegmentForY = (y: number): LogSegmentData => {
    for (const seg of segments) {
      if (y <= seg.yEnd) return seg;
    }
    return segments[segments.length - 1];
  };

  // Exact local trunk metrics for the Humboldt face notch & back cut (kept cleanly above stumpCap at y=0!)
  const cutTopY = Math.min(0.84, Math.max(0.56, baseRadius * 1.18));
  const cutCenter3 = getTrunkCenterAt(cutTopY);
  const cutCenterXZ = new THREE.Vector2(cutCenter3.x, cutCenter3.z);
  const cutRadius = getTrunkRadiusAt(cutTopY);
  const cutRadiusSlope = (trunkTopRadius - baseRadius * 0.95) / Math.max(1, upperHeight);

  // Local-space shader uniforms punch exact Humboldt notch & back-cut kerf in segments[0] bark
  const cutShaderUniforms: TreeRuntime['cutShaderUniforms'] = {
    uSeg0Pos: { value: segments[0].group.position.clone() },
    uCutCenterXZ: { value: cutCenterXZ.clone() },
    uAimDir: { value: new THREE.Vector2(1, 0) },
    uFaceEnabled: { value: 0 },
    uFaceTopY: { value: cutTopY },
    uFaceHingeX: { value: cutRadius },
    uFaceSlope: { value: 1.08 },
    uBackEnabled: { value: 0 },
    uBackCenterY: { value: cutTopY + 0.07 },
    uBackHalfH: { value: 0.03 },
    uBackTipX: { value: -cutRadius },
  };
  if (quality === 'high' || isArbutus) {
    applyBarkSurfaceShader(
      segments[0].barkMesh.material as THREE.MeshStandardMaterial,
      {
        site,
        weather,
        mossAffinity: barkProfile.mossAffinity,
        arbutusMode: isArbutus,
        cutUniforms: cutShaderUniforms,
      }
    );
  } else {
    applyTrunkCutDiscardShader(
      segments[0].barkMesh.material as THREE.MeshStandardMaterial,
      cutShaderUniforms
    );
  }

  // 3. Humboldt Face Notch (2 clean cylindrical-segment wood faces: flat horizontal ceiling + 47° sloped floor)
  const notchCutoutGroup = new THREE.Group();
  notchCutoutGroup.position.set(cutCenterXZ.x, 0, cutCenterXZ.y);
  notchCutoutGroup.visible = false;

  const notchCeilingMat = new THREE.MeshStandardMaterial({
    map: pbrEndGrain.map,
    normalMap: quality === 'high' ? pbrEndGrain.normalMap : null,
    normalScale: new THREE.Vector2(0.55, 0.55),
    roughnessMap: quality === 'high' ? pbrEndGrain.armMap : null,
    color: new THREE.Color('#c9a47e').lerp(endTint, 0.45),
    roughness: 0.85,
    metalness: 0.02,
    vertexColors: true,
  });
  const notchFloorMat = new THREE.MeshStandardMaterial({
    map: pbrEndGrain.map,
    normalMap: quality === 'high' ? pbrEndGrain.normalMap : null,
    normalScale: new THREE.Vector2(0.55, 0.55),
    roughnessMap: quality === 'high' ? pbrEndGrain.armMap : null,
    color: new THREE.Color('#f7e7cc').lerp(endTint, 0.45),
    roughness: 0.72,
    metalness: 0.02,
    vertexColors: true,
  });

  const notchCeiling = new THREE.Mesh(new THREE.BufferGeometry(), notchCeilingMat);
  const notchFloor = new THREE.Mesh(new THREE.BufferGeometry(), notchFloorMat);
  notchCeiling.receiveShadow = true;
  notchFloor.receiveShadow = true;
  notchCeiling.frustumCulled = false;
  notchFloor.frustumCulled = false;
  notchCutoutGroup.add(notchCeiling, notchFloor);
  trunkPivot.add(notchCutoutGroup);

  // 4. Back Cut Kerf (clean horizontal slot slightly above the Humboldt ceiling)
  const backCutGroup = new THREE.Group();
  backCutGroup.position.set(cutCenterXZ.x, 0, cutCenterXZ.y);
  backCutGroup.visible = false;

  const backTopFace = new THREE.Mesh(new THREE.BufferGeometry(), notchCeilingMat);
  const backBottomFace = new THREE.Mesh(new THREE.BufferGeometry(), notchFloorMat);
  const backHingeMat = new THREE.MeshStandardMaterial({
    color: '#5a3820',
    roughness: 0.9,
  });
  const backHingeWall = new THREE.Mesh(new THREE.BufferGeometry(), backHingeMat);
  for (const m of [backTopFace, backBottomFace, backHingeWall]) {
    m.frustumCulled = false;
  }
  backCutGroup.add(backTopFace, backBottomFace, backHingeWall);
  trunkPivot.add(backCutGroup);

  // 5. Felling Wedges (3 tapered high-vis forestry orange wedges driven into the back cut!)
  const wedgeMeshes: THREE.Mesh[] = [];
  const wedgeLen = Math.max(0.48, baseRadius * 1.12);
  const wedgeButtH = Math.max(0.14, baseRadius * 0.28);
  const wedgeWidth = Math.max(0.22, baseRadius * 0.42);
  const wedgeShape = new THREE.Shape();
  // Sharp tip at +X (points straight into the back cut), flat hammer butt at -X
  wedgeShape.moveTo(-wedgeLen * 0.5, -wedgeButtH * 0.5);
  wedgeShape.lineTo(wedgeLen * 0.5, -0.012);
  wedgeShape.lineTo(wedgeLen * 0.5, 0.012);
  wedgeShape.lineTo(-wedgeLen * 0.5, wedgeButtH * 0.5);
  wedgeShape.closePath();
  const wedgeGeo = new THREE.ExtrudeGeometry(wedgeShape, {
    depth: wedgeWidth,
    bevelEnabled: true,
    bevelThickness: 0.012,
    bevelSize: 0.01,
    bevelSegments: 2,
  });
  wedgeGeo.translate(0, 0, -wedgeWidth * 0.5);

  for (let w = 0; w < 3; w++) {
    const wedgeMat = new THREE.MeshStandardMaterial({
      color: '#ff6a13',
      emissive: '#ff5500',
      emissiveIntensity: 0.18,
      roughness: 0.36,
      metalness: 0.08,
      transparent: true,
      opacity: 1,
    });
    const wMesh = new THREE.Mesh(wedgeGeo, wedgeMat);
    const zOff = (w - 1) * baseRadius * 0.52;
    wMesh.position.set(cutCenterXZ.x - baseRadius * 1.05, cutTopY + 0.07, cutCenterXZ.y + zOff);
    wMesh.rotation.z = 0.05;
    wMesh.visible = false;
    wMesh.castShadow = true;
    wMesh.userData = { isWedge: true, wedgeLen };
    trunkPivot.add(wMesh);
    wedgeMeshes.push(wMesh);
  }

  // 6. Generate Realistic Branches (Interactive Prunable Lower/Mid Branches + Crown Foliage)
  const branches: BranchData[] = [];

  const totalInteractiveBranches =
    spec.species === 'arbutus'
      ? Math.max(7, spec.hazardBranches + 3)
      : spec.species === 'garry_oak'
        ? Math.max(8, spec.hazardBranches + 4)
        : spec.species === 'bigleaf_maple' || spec.species === 'weeping_willow'
          ? Math.max(10, spec.hazardBranches + 5)
      : spec.species === 'japanese_maple' ||
          spec.species === 'lilac' ||
          spec.species === 'smoke_tree' ||
          spec.species === 'rhododendron' ||
          spec.species === 'chokecherry'
        ? Math.max(8, spec.hazardBranches + 4)
        : spec.species === 'red_alder' ||
            spec.species === 'white_poplar' ||
            spec.species === 'eucalyptus' ||
            spec.species === 'trembling_aspen'
          ? Math.max(9, spec.hazardBranches + 4)
          : Math.max(11, spec.hazardBranches + 5);

  // Decide which branch indices are target hazard/deadwood/unbalanced branches
  const targetIndices = new Set<number>();
  for (let i = 0; i < spec.hazardBranches && i < totalInteractiveBranches; i++) {
    targetIndices.add(i);
  }

  const reasons: Array<BranchData['reason']> = [
    'deadwood',
    'overhanging',
    'weight_balance',
    'storm_cracked',
  ];

  // Build interactive lower-to-mid branches (prunable!)
  for (let i = 0; i < totalInteractiveBranches; i++) {
    const isTarget = targetIndices.has(i);
    let heightFrac =
      speciesSpec.category === 'deciduous'
        ? 0.28 + (i / totalInteractiveBranches) * 0.44 + (rand() - 0.5) * 0.04
        : 0.18 + (i / totalInteractiveBranches) * 0.46 + (rand() - 0.5) * 0.035;
    if (isArbutus) {
      // Irregular gnarled Pacific Madrone branching: clustered low-to-mid forks with wild height gaps
      const clusterBands = [0.22, 0.27, 0.41, 0.45, 0.56, 0.62, 0.69, 0.34, 0.52, 0.66];
      heightFrac = clusterBands[i % clusterBands.length] + (rand() - 0.5) * 0.07;
    } else if (isGarryOak) {
      // Stout pale-gray bole rises cleanly ~3.5m above the meadow before exploding into wide gnarled limbs
      const oakBands = [0.27, 0.32, 0.38, 0.44, 0.5, 0.56, 0.62, 0.35, 0.47, 0.59];
      heightFrac = oakBands[i % oakBands.length] + (rand() - 0.5) * 0.05;
    } else if (isSmokeTree) {
      // Low multi-stemmed Smoke Tree habit: branches sprout almost directly from near the ground collar!
      const smokeBands = [0.11, 0.16, 0.22, 0.28, 0.36, 0.44, 0.54, 0.20, 0.32, 0.48];
      heightFrac = smokeBands[i % smokeBands.length] + (rand() - 0.5) * 0.04;
    }

    const minAttachY = isSmokeTree ? 0.34 : spec.height < 11 ? 1.2 : 2.0;
    const rawAttachY = Math.max(minAttachY, upperHeight * Math.min(0.76, heightFrac));
    // Keep required hazard limbs on the remaining lower spar so top-down piecing never deadlocks pruning
    const attachY =
      isTarget && minStandingLocalY < Infinity
        ? Math.min(rawAttachY, Math.max(3.2, minStandingLocalY - 1.2 - (i % 4) * 1.15))
        : rawAttachY;
    const attachCenter = getTrunkCenterAt(attachY);
    const localTrunkR = getTrunkRadiusAt(attachY);

    // Direction around trunk: bias target branches toward hazardBranchAngle if provided
    let angle: number;
    if (isTarget && spec.hazardBranchAngle !== undefined) {
      const spread = (i - (spec.hazardBranches - 1) / 2) * 0.48 + (rand() - 0.5) * 0.24;
      angle = spec.hazardBranchAngle + spread;
    } else if (isArbutus) {
      // Asymmetrical wind-sculpted madrone azimuths (clustered reaching sides + open sculptural gaps)
      angle = madroneAxis + (i % 3 === 0 ? 0.35 : i % 3 === 1 ? -1.45 : 2.25) + (rand() - 0.5) * 0.95;
    } else if (isGarryOak) {
      // Broad, asymmetrical wind-swept Garry Oak bough directions (heavy lateral meadow reaches)
      angle = madroneAxis + (i / totalInteractiveBranches) * Math.PI * 2 + (rand() - 0.5) * 0.85;
    } else {
      angle = i * 2.39996 + rand() * 0.65; // golden angle spiral for natural spacing
    }

    const dirX = Math.cos(angle);
    const dirZ = Math.sin(angle);

    // Branch length & pitch per species
    const sizeFactor = 1.0 - (heightFrac - 0.18) * 0.62;
    const widthSpread =
      spec.species === 'garry_oak'
        ? 6.3
        : spec.species === 'weeping_willow'
          ? 4.4
          : spec.species === 'arbutus'
            ? 5.1
            : spec.species === 'japanese_maple' || spec.species === 'smoke_tree'
              ? 4.5
              : spec.species === 'lilac' ||
                  spec.species === 'rhododendron' ||
                  spec.species === 'chokecherry'
                ? 3.7
                : spec.species === 'eucalyptus'
                  ? 3.9
                  : spec.species === 'trembling_aspen'
                    ? 3.1
                    : speciesSpec.category === 'deciduous'
                      ? 3.8
                      : spec.species === 'ponderosa_pine' || spec.species === 'western_white_pine'
                        ? 3.5
                        : 3.2;
    const bLength =
      widthSpread *
      Math.max(0.55, sizeFactor) *
      Math.max(0.52, spec.height / 18) *
      (isTarget ? 1.18 : isSculpturalHardwood ? 0.86 + rand() * 0.44 : 0.92 + rand() * 0.25);

    const bRadius = Math.max(
      0.065,
      localTrunkR *
        (isGarryOak
          ? isTarget
            ? 0.52
            : 0.48 + rand() * 0.16
          : isArbutus
            ? isTarget
              ? 0.46
              : 0.44 + rand() * 0.14
            : isTarget
              ? 0.42
              : 0.34)
    );

    const branchGroup = new THREE.Group();
    const attachLocalPos = new THREE.Vector3(
      attachCenter.x + dirX * localTrunkR * 0.68,
      attachY,
      attachCenter.z + dirZ * localTrunkR * 0.68
    );
    branchGroup.position.copy(attachLocalPos);

    // Orient branchGroup +X axis along branch azimuth
    branchGroup.rotation.y = -angle;

    // Pitch based on species
    let pitch = 0.05;
    if (spec.species === 'western_red_cedar') pitch = -0.18;
    else if (spec.species === 'western_hemlock') pitch = -0.14;
    else if (spec.species === 'sitka_spruce') pitch = -0.05;
    else if (spec.species === 'bigleaf_maple') pitch = 0.32 + rand() * 0.22;
    else if (spec.species === 'red_alder') pitch = 0.42 + rand() * 0.18;
    else if (spec.species === 'weeping_willow') pitch = 0.18 + rand() * 0.18;
    else if (spec.species === 'japanese_maple') pitch = 0.14 + rand() * 0.14;
    else if (spec.species === 'lilac') pitch = 0.46 + rand() * 0.2;
    else if (spec.species === 'smoke_tree') pitch = 0.20 + rand() * 0.30;
    else if (spec.species === 'white_poplar') pitch = 0.44 + rand() * 0.22;
    else if (spec.species === 'garry_oak')
      pitch = (heightFrac < 0.34 ? 0.02 : 0.14) + (rand() - 0.38) * 0.32;
    else if (spec.species === 'arbutus') pitch = (heightFrac < 0.36 ? -0.12 : 0.12) + (rand() - 0.35) * 0.45;
    else if (spec.species === 'rhododendron') pitch = 0.36 + rand() * 0.22;
    else if (spec.species === 'chokecherry') pitch = 0.4 + rand() * 0.2;
    else if (spec.species === 'trembling_aspen') pitch = 0.46 + rand() * 0.2;
    else if (spec.species === 'eucalyptus') pitch = 0.38 + rand() * 0.22;
    else if (spec.species === 'california_redwood') pitch = -0.1;
    else if (spec.species === 'ponderosa_pine') pitch = 0.08 + rand() * 0.14;
    else if (spec.species === 'western_larch') pitch = -0.06 + rand() * 0.1;
    else if (spec.species === 'blue_spruce') pitch = -0.08;
    else if (spec.species === 'western_white_pine') pitch = 0.04 + rand() * 0.08;
    else if (spec.species === 'douglas_fir') pitch = 0.04 + (heightFrac - 0.18) * 0.36;
    else pitch = -0.06 + (heightFrac - 0.2) * 0.25;

    if (isTarget && spec.task === 'prune_only') {
      pitch -= 0.14; // overhanging / drooping hazard feel
    }

    // Build segmented curved limb geometry
    const bMat = isTarget
      ? new THREE.MeshStandardMaterial({
          color: '#6b5542',
          roughness: 0.95,
          metalness: 0.01,
        })
      : barkMat;

    const isDeadwoodVisual = isTarget && (i % 2 === 0 || spec.task === 'prune_only');
    const folScale = (speciesSpec.category === 'deciduous' ? 1.55 : 1.25) * (bLength / 3.2);
    const branchOutHint = new THREE.Vector3(1, 0, 0);
    const branchHFrac = THREE.MathUtils.clamp((attachY / Math.max(1, upperHeight) - 0.15) / 0.8, 0, 0.72);

    if (isArbutus) {
      // Sculptural contorted Pacific Madrone serpentine 3D spline limb (dips, elbows sideways, hooks skyward!)
      const zSign = rand() > 0.5 ? 1 : -1;
      const yaw1 = zSign * bLength * (0.18 + rand() * 0.22);
      const yaw2 = -zSign * bLength * (0.14 + rand() * 0.24);
      const elbowDip = (rand() - 0.62) * bLength * 0.26;
      const upHook = bLength * (0.28 + rand() * 0.26);

      const p0 = new THREE.Vector3(-localTrunkR * 0.22, 0, 0);
      const p1 = new THREE.Vector3(bLength * 0.26, Math.sin(pitch) * bLength * 0.26 + elbowDip * 0.35, yaw1 * 0.55);
      const p2 = new THREE.Vector3(bLength * 0.56, Math.sin(pitch) * bLength * 0.44 + elbowDip, yaw1);
      const p3 = new THREE.Vector3(bLength * 0.82, p2.y + upHook * 0.62, yaw1 * 0.35 + yaw2 * 0.7);
      const p4 = new THREE.Vector3(bLength * 1.04, p2.y + upHook * 1.12, yaw2);

      const mainLimbGeo = buildTaperedSplineLimbGeometry(
        [p0, p1, p2, p3, p4],
        bRadius,
        bRadius * 0.24,
        14,
        9,
        i * 1.7 + rand() * 3.1
      );
      const mainLimbMesh = new THREE.Mesh(mainLimbGeo, bMat);
      mainLimbMesh.castShadow = true;
      mainLimbMesh.receiveShadow = true;
      branchGroup.add(mainLimbMesh);

      // 2 twisting sculptural secondary elbows reaching outward & upward from mid/outer bends
      const forkTips: THREE.Vector3[] = [p4];
      for (let f = 0; f < 2; f++) {
        const fSide = f === 0 ? 1 : -1;
        const fStart = f === 0 ? p2.clone().lerp(p3, 0.35) : p1.clone().lerp(p2, 0.72);
        const fReach = bLength * (0.38 + rand() * 0.2);
        const fMid = fStart
          .clone()
          .add(new THREE.Vector3(fReach * 0.48, (rand() - 0.42) * fReach * 0.45, fSide * fReach * (0.52 + rand() * 0.25)));
        const fEnd = fMid
          .clone()
          .add(new THREE.Vector3(fReach * 0.42, fReach * (0.38 + rand() * 0.3), fSide * fReach * 0.22 + (rand() - 0.5) * 0.5));
        const forkGeo = buildTaperedSplineLimbGeometry(
          [fStart, fMid, fEnd],
          bRadius * (f === 0 ? 0.52 : 0.6),
          bRadius * 0.16,
          9,
          7,
          i * 3.1 + f * 2.2
        );
        const forkMesh = new THREE.Mesh(forkGeo, bMat);
        forkMesh.castShadow = true;
        forkMesh.receiveShadow = true;
        branchGroup.add(forkMesh);
        forkTips.push(fEnd);
      }

      // Add subtle 3D papery bark peel curls on healthy gnarled Arbutus boughs
      if (!isTarget && arbutusPeelMat && quality === 'high') {
        const limbCurve = new THREE.CatmullRomCurve3([p0, p1, p2, p3, p4]);
        const limbPeels: BarkPeelAnchor[] = [];
        for (let lp = 0; lp < 4; lp++) {
          const lt = 0.22 + (lp / 4) * 0.55 + rand() * 0.08;
          const lPos = limbCurve.getPoint(lt);
          const lTan = limbCurve.getTangent(lt).normalize();
          const lRad = THREE.MathUtils.lerp(bRadius, bRadius * 0.24, lt);
          const lNorm = new THREE.Vector3(0, 1, 0)
            .applyAxisAngle(lTan, rand() * Math.PI * 2);
          lNorm.addScaledVector(lTan, -lNorm.dot(lTan)).normalize();
          limbPeels.push({
            pos: lPos.clone().addScaledVector(lNorm, lRad * 0.98),
            normal: lNorm,
            tangentUp: lTan,
            width: Math.max(0.024, lRad * 0.42),
            length: 0.16 + rand() * 0.22,
            curlDir: rand() > 0.5 ? 1 : -1,
          });
        }
        const lpGeo = buildArbutusPeelRibbonsGeometry(limbPeels, rand);
        if (lpGeo) {
          const lpMesh = new THREE.Mesh(lpGeo, arbutusPeelMat);
          lpMesh.receiveShadow = true;
          branchGroup.add(lpMesh);
        }
      }

      // Keep inner ~65% of the sinuous orange-terracotta limb bare & sculptural;
      // perch evergreen leaf rosettes cleanly at the outer upturned fork tips!
      for (let tIdx = 0; tIdx < forkTips.length; tIdx++) {
        const tipPos = forkTips[tIdx];
        const tipScale = folScale * (tIdx === 0 ? 0.96 : 0.78);
        const outHint = tipPos.clone().normalize();
        const tipFol = createFoliageCluster(
          speciesSpec,
          tipScale,
          rand,
          isDeadwoodVisual,
          botanicalCtx,
          outHint.lengthSq() > 0.01 ? outHint : branchOutHint,
          branchHFrac
        );
        tipFol.position.set(tipPos.x, tipPos.y + 0.02, tipPos.z);
        branchGroup.add(tipFol);
      }
    } else if (isGarryOak) {
      // Tortured, angular, wind-carved coastal Garry Oak limb:
      // Heavy gnarled base -> sudden horizontal/dipping reach -> sharp zig-zagging elbows & crooked forks!
      const zSign = rand() > 0.5 ? 1 : -1;
      const zigZ1 = zSign * bLength * (0.16 + rand() * 0.18);
      const zigZ2 = -zSign * bLength * (0.14 + rand() * 0.2);
      const zigZ3 = zSign * bLength * (0.12 + rand() * 0.18);
      const lowDip = (heightFrac < 0.35 ? -0.14 : -0.06) * bLength * (0.65 + rand() * 0.5);
      const crankUp = bLength * (0.18 + rand() * 0.22);
      const tipDip = (rand() - 0.44) * bLength * 0.18;

      const p0 = new THREE.Vector3(-localTrunkR * 0.25, 0, 0);
      const p1 = new THREE.Vector3(bLength * 0.22, Math.sin(pitch) * bLength * 0.2 + lowDip * 0.3, zigZ1 * 0.65);
      const p2 = new THREE.Vector3(bLength * 0.46, p1.y + lowDip * 0.75 + (rand() - 0.5) * 0.35, zigZ1);
      const p3 = new THREE.Vector3(bLength * 0.68, p2.y + crankUp, zigZ2);
      const p4 = new THREE.Vector3(bLength * 0.88, p3.y + tipDip * 0.6, zigZ2 * 0.3 + zigZ3 * 0.7);
      const p5 = new THREE.Vector3(bLength * 1.06, p4.y + crankUp * 0.42 + tipDip * 0.4, zigZ3);

      const oakSplineOpts = { tension: 0.2, gnarl: 1.55, tileV: 2.0 };
      const mainOakGeo = buildTaperedSplineLimbGeometry(
        [p0, p1, p2, p3, p4, p5],
        bRadius,
        bRadius * 0.22,
        18,
        9,
        i * 2.1 + rand() * 3.7,
        oakSplineOpts
      );
      const mainOakMesh = new THREE.Mesh(mainOakGeo, bMat);
      mainOakMesh.castShadow = true;
      mainOakMesh.receiveShadow = true;
      branchGroup.add(mainOakMesh);

      // 3 tortured zig-zagging secondary oak forks branching sharply from gnarled elbows
      const oakTips: Array<{ pos: THREE.Vector3; scale: number }> = [
        { pos: p5, scale: folScale * 0.96 },
      ];
      const forkStarts = [p2, p3, p4];
      for (let f = 0; f < 3; f++) {
        const fSide = f === 0 ? 1 : f === 1 ? -1 : zSign;
        const fStart = forkStarts[f].clone();
        const fReach = bLength * (f === 0 ? 0.44 : f === 1 ? 0.38 : 0.3) * (0.85 + rand() * 0.32);
        const fElbow = fStart.clone().add(
          new THREE.Vector3(
            fReach * (0.42 + rand() * 0.2),
            (rand() - 0.45) * fReach * 0.52,
            fSide * fReach * (0.55 + rand() * 0.28)
          )
        );
        const fKink = fElbow.clone().add(
          new THREE.Vector3(
            fReach * (0.34 + rand() * 0.16),
            fReach * (0.18 + (rand() - 0.35) * 0.4),
            -fSide * fReach * (0.18 + rand() * 0.22)
          )
        );
        const fEnd = fKink.clone().add(
          new THREE.Vector3(
            fReach * 0.28,
            fReach * (0.16 + rand() * 0.24),
            fSide * fReach * (0.22 + rand() * 0.18)
          )
        );
        const forkGeo = buildTaperedSplineLimbGeometry(
          [fStart, fElbow, fKink, fEnd],
          bRadius * (0.56 - f * 0.08),
          bRadius * 0.15,
          11,
          7,
          i * 3.7 + f * 2.5,
          oakSplineOpts
        );
        const forkMesh = new THREE.Mesh(forkGeo, bMat);
        forkMesh.castShadow = true;
        forkMesh.receiveShadow = true;
        branchGroup.add(forkMesh);
        oakTips.push({ pos: fEnd, scale: folScale * (0.84 - f * 0.06) });
      }

      // Occasional crooked weathered deadwood spur poking from a lower gnarled oak elbow
      if (!isTarget && arbutusSnagMat && i % 2 === 0) {
        const s0 = p1.clone().lerp(p2, 0.65);
        const s1 = s0.clone().add(new THREE.Vector3(0.45, -0.32 - rand() * 0.25, -zSign * (0.45 + rand() * 0.35)));
        const s2 = s1.clone().add(new THREE.Vector3(0.42, 0.12 - rand() * 0.28, zSign * 0.25));
        const spurGeo = buildTaperedSplineLimbGeometry([s0, s1, s2], bRadius * 0.28, 0.018, 7, 5, i * 4.3, oakSplineOpts);
        const spurMesh = new THREE.Mesh(spurGeo, arbutusSnagMat);
        spurMesh.castShadow = true;
        branchGroup.add(spurMesh);
      }

      // Billowing dark-olive Garry Oak foliage clouds perched at the outer zig-zagged tips
      // (preserving gnarled pale-gray structural branches & sky windows beneath!)
      for (const tip of oakTips) {
        const outHint = tip.pos.clone().normalize();
        const tipFol = createFoliageCluster(
          speciesSpec,
          tip.scale,
          rand,
          isDeadwoodVisual,
          botanicalCtx,
          outHint.lengthSq() > 0.01 ? outHint : branchOutHint,
          branchHFrac
        );
        tipFol.position.set(tip.pos.x, tip.pos.y + 0.02, tip.pos.z);
        branchGroup.add(tipFol);
      }
    } else {
      const seg1Len = bLength * 0.56;
      const seg2Len = bLength * 0.48;

      const seg1Geo = new THREE.CylinderGeometry(bRadius * 0.65, bRadius, seg1Len, 7);
      seg1Geo.rotateZ(-Math.PI / 2);
      seg1Geo.translate(seg1Len / 2, 0, 0);
      const seg1Mesh = new THREE.Mesh(seg1Geo, bMat);
      seg1Mesh.rotation.z = pitch;
      seg1Mesh.castShadow = true;
      seg1Mesh.receiveShadow = true;
      branchGroup.add(seg1Mesh);

      const tip1X = Math.cos(pitch) * seg1Len;
      const tip1Y = Math.sin(pitch) * seg1Len;

      // Secondary limb bend (J-curve swoop upward for Cedar & Douglas Fir, cascading droop for Weeping Willow, tiered for Japanese Maple)
      const seg2Pitch =
        spec.species === 'western_red_cedar'
          ? pitch + 0.34
          : spec.species === 'douglas_fir'
            ? pitch + 0.22
            : spec.species === 'weeping_willow'
              ? pitch - 0.55
              : spec.species === 'japanese_maple'
                ? pitch - 0.1
                : spec.species === 'bigleaf_maple'
                  ? pitch - 0.12
                  : pitch - 0.08;

      const seg2Geo = new THREE.CylinderGeometry(bRadius * 0.26, bRadius * 0.64, seg2Len, 6);
      seg2Geo.rotateZ(-Math.PI / 2);
      seg2Geo.translate(seg2Len / 2, 0, 0);
      const seg2Mesh = new THREE.Mesh(seg2Geo, bMat);
      seg2Mesh.position.set(tip1X, tip1Y, 0);
      seg2Mesh.rotation.z = seg2Pitch;
      seg2Mesh.castShadow = true;
      branchGroup.add(seg2Mesh);

      // Side twig forks
      const forkCount = speciesSpec.category === 'deciduous' ? 2 : 2;
      for (let f = 0; f < forkCount; f++) {
        const fLen = bLength * 0.34;
        const fGeo = new THREE.CylinderGeometry(bRadius * 0.16, bRadius * 0.38, fLen, 5);
        fGeo.rotateZ(-Math.PI / 2);
        fGeo.translate(fLen / 2, 0, 0);
        const fMesh = new THREE.Mesh(fGeo, bMat);
        fMesh.position.set(tip1X * (0.65 + f * 0.28), tip1Y * (0.65 + f * 0.28), 0);
        fMesh.rotation.y = (f === 0 ? 1 : -1) * (0.55 + rand() * 0.25);
        fMesh.rotation.z = seg2Pitch + 0.1;
        fMesh.castShadow = true;
        branchGroup.add(fMesh);
      }

      // Foliage pads along the branch
      const tip2X = tip1X + Math.cos(seg2Pitch) * seg2Len;
      const tip2Y = tip1Y + Math.sin(seg2Pitch) * seg2Len;

      const midFol = createFoliageCluster(
        speciesSpec,
        folScale * 0.78,
        rand,
        isDeadwoodVisual,
        botanicalCtx,
        branchOutHint,
        branchHFrac
      );
      midFol.position.set(tip1X * 0.85, tip1Y * 0.85 + 0.22, 0);
      branchGroup.add(midFol);

      const tipFol = createFoliageCluster(
        speciesSpec,
        folScale,
        rand,
        isDeadwoodVisual,
        botanicalCtx,
        branchOutHint,
        branchHFrac
      );
      tipFol.position.set(tip2X, tip2Y + 0.25, 0);
      branchGroup.add(tipFol);
    }

    // Subtle forestry ribbon flag on target branches so player spots them effortlessly!
    if (isTarget) {
      const ribbonMat = new THREE.MeshStandardMaterial({
        color: '#f59e0b',
        emissive: '#d97706',
        emissiveIntensity: 0.45,
        roughness: 0.4,
        side: THREE.DoubleSide,
      });
      const ribbonWrap = new THREE.Mesh(
        new THREE.TorusGeometry(bRadius * 1.28, 0.045, 6, 14),
        ribbonMat
      );
      ribbonWrap.position.set(0.32, Math.sin(pitch) * 0.32, 0);
      ribbonWrap.rotation.y = Math.PI / 2;
      branchGroup.add(ribbonWrap);

      const ribbonTail = new THREE.Mesh(new THREE.PlaneGeometry(0.14, 0.65), ribbonMat);
      ribbonTail.position.set(0.34, Math.sin(pitch) * 0.32 - 0.36, 0.05);
      ribbonTail.rotation.z = 0.12;
      branchGroup.add(ribbonTail);
    }

    // Diegetic Branch Collar Ring (glows when hovered or pruning!)
    const collarRing = new THREE.Mesh(
      new THREE.TorusGeometry(bRadius * 1.48, 0.055, 8, 20),
      new THREE.MeshBasicMaterial({
        color: isTarget ? '#fbbf24' : '#38bdf8',
        transparent: true,
        opacity: isTarget ? 0.48 : 0.0,
      })
    );
    collarRing.rotation.y = Math.PI / 2;
    collarRing.position.set(0.14, Math.sin(pitch) * 0.14, 0);
    branchGroup.add(collarRing);

    // Generous invisible collider cylinder along branch for crisp, forgiving mouse raycasting
    const colliderGeo = new THREE.CylinderGeometry(
      Math.max(0.55, bRadius * 2.8),
      Math.max(0.45, bRadius * 2.4),
      bLength * 1.05,
      8
    );
    colliderGeo.rotateZ(-Math.PI / 2);
    colliderGeo.translate(bLength * 0.5, 0, 0);
    const colliderMesh = new THREE.Mesh(
      colliderGeo,
      new THREE.MeshBasicMaterial({ visible: false })
    );
    colliderMesh.rotation.z = pitch * 0.7;
    const branchId = `${spec.id}-b-${i}`;
    colliderMesh.userData = { treeId: spec.id, branchId, part: 'branch' };
    branchGroup.add(colliderMesh);

    const parentSeg = findSegmentForY(attachY);
    branchGroup.position.sub(parentSeg.group.position);
    parentSeg.group.add(branchGroup);

    branches.push({
      id: branchId,
      treeId: spec.id,
      meshGroup: branchGroup,
      colliderMesh,
      collarRing,
      attachLocalPos,
      worldDirection: new THREE.Vector3(dirX, 0, dirZ).normalize(),
      radius: bRadius,
      length: bLength,
      weight: isTarget ? 0.13 : 0.04,
      isTarget,
      isHealthy: !isTarget,
      reason: isTarget ? reasons[i % reasons.length] : undefined,
      cutProgress: 0,
      pruned: false,
    });
  }

  // 7. Upper Crown Canopy
  // Crown tiers overlapping the sawlog bucking zone become ground-limbable boughs once felled!
  const groundLimbCutoffY = maxBuckDist + 2.8;

  const upperCrownGroup = new THREE.Group();
  let crownLimbIdx = 0;

  if (speciesSpec.category === 'conifer') {
    const tiers = Math.floor(spec.height * 0.65);
    const startFrac = 0.52;
    const crownStartY = upperHeight * startFrac;
    const crownZoneSpan = Math.max(0.1, groundLimbCutoffY - crownStartY);
    // Group all crown foliage overlapping the sawlog bucking zone into 4 cohesive
    // limbable crown bough sections (2 bands x left/right) so limbing feels snappy & rewarding!
    const crownSectionBuckets: Array<{
      group: THREE.Group;
      ySum: number;
      count: number;
      dirAngle: number;
      maxReach: number;
    }> = [];
    for (let band = 0; band < 2; band++) {
      for (let side = 0; side < 2; side++) {
        crownSectionBuckets.push({
          group: new THREE.Group(),
          ySum: 0,
          count: 0,
          dirAngle: side * Math.PI + band * 1.1,
          maxReach: 1.5,
        });
      }
    }

    for (let tIdx = 0; tIdx < tiers; tIdx++) {
      const f = startFrac + (tIdx / tiers) * (0.98 - startFrac);
      const crownT = THREE.MathUtils.clamp((f - startFrac) / Math.max(0.01, 0.98 - startFrac), 0, 1);
      const heightFracForFol = THREE.MathUtils.lerp(0.32, 0.96, crownT);
      const y = upperHeight * f;
      const center = getTrunkCenterAt(y);
      const crownWidth = spec.species === 'california_redwood' ? 0.205 : 0.24;
      const crownRadius = (1 - (f - 0.15) / 0.88) * (spec.height * crownWidth) + 0.55;
      const boughsInTier = f > 0.88 ? 3 : 5;

      // Species-accurate conifer upper bough vertical sweep!
      const boughVertLift = (reach: number) =>
        spec.species === 'douglas_fir'
          ? reach * THREE.MathUtils.lerp(0.16, 0.44, crownT)
          : spec.species === 'sitka_spruce'
            ? reach * THREE.MathUtils.lerp(0.06, 0.32, crownT)
            : spec.species === 'western_red_cedar'
              ? reach * THREE.MathUtils.lerp(-0.18, 0.14, crownT)
              : spec.species === 'western_hemlock'
                ? reach * THREE.MathUtils.lerp(-0.22, -0.02, crownT)
                : spec.species === 'california_redwood'
                  ? reach * THREE.MathUtils.lerp(-0.08, 0.16, crownT)
                  : spec.species === 'ponderosa_pine'
                    ? reach * THREE.MathUtils.lerp(0.08, 0.36, crownT)
                    : spec.species === 'blue_spruce'
                      ? reach * THREE.MathUtils.lerp(0.02, 0.32, crownT)
                      : spec.species === 'western_larch'
                        ? reach * THREE.MathUtils.lerp(-0.08, 0.2, crownT)
                        : spec.species === 'western_white_pine'
                          ? reach * THREE.MathUtils.lerp(-0.02, 0.22, crownT)
                          : -0.1;

      if (y <= groundLimbCutoffY) {
        const band = y - crownStartY < crownZoneSpan * 0.5 ? 0 : 1;
        for (let b = 0; b < boughsInTier; b++) {
          const a = (b / boughsInTier) * Math.PI * 2 + tIdx * 1.15 + rand() * 0.3;
          const reach = crownRadius * (0.72 + rand() * 0.32);
          const padPos = new THREE.Vector3(
            center.x + Math.cos(a) * reach * 0.65,
            y + boughVertLift(reach),
            center.z + Math.sin(a) * reach * 0.65
          );
          const pad = createFoliageCluster(
            speciesSpec,
            Math.max(0.7, reach * 0.52),
            rand,
            false,
            botanicalCtx,
            new THREE.Vector3(Math.cos(a), 0, Math.sin(a)),
            heightFracForFol
          );
          pad.position.copy(padPos);
          const side = Math.cos(a - band * 1.1) >= 0 ? 0 : 1;
          const bucket = crownSectionBuckets[band * 2 + side];
          if (botanicalCtx) {
            const boughStart = new THREE.Vector3(center.x, y - 0.08, center.z);
            const limb = buildCrownScaffoldLimb(
              boughStart,
              padPos,
              Math.max(0.055, reach * 0.032),
              0.018,
              botanicalCtx.twigMat
            );
            if (limb) bucket.group.add(limb);
          }
          bucket.group.add(pad);
          bucket.ySum += y;
          bucket.count++;
          bucket.maxReach = Math.max(bucket.maxReach, reach);
        }
      } else {
        const tierSeg = findSegmentForY(y);
        for (let b = 0; b < boughsInTier; b++) {
          const a = (b / boughsInTier) * Math.PI * 2 + tIdx * 1.15 + rand() * 0.3;
          const reach = crownRadius * (0.72 + rand() * 0.32);
          const padLocal = new THREE.Vector3(
            center.x + Math.cos(a) * reach * 0.65 - tierSeg.group.position.x,
            y + boughVertLift(reach) - tierSeg.group.position.y,
            center.z + Math.sin(a) * reach * 0.65 - tierSeg.group.position.z
          );
          const pad = createFoliageCluster(
            speciesSpec,
            Math.max(0.7, reach * 0.52),
            rand,
            false,
            botanicalCtx,
            new THREE.Vector3(Math.cos(a), 0, Math.sin(a)),
            heightFracForFol
          );
          pad.position.copy(padLocal);
          if (botanicalCtx) {
            const boughStart = new THREE.Vector3(
              center.x - tierSeg.group.position.x,
              y - 0.08 - tierSeg.group.position.y,
              center.z - tierSeg.group.position.z
            );
            const limb = buildCrownScaffoldLimb(
              boughStart,
              padLocal,
              Math.max(0.045, reach * 0.028),
              0.016,
              botanicalCtx.twigMat
            );
            if (limb) tierSeg.group.add(limb);
          }
          tierSeg.group.add(pad);
        }
      }
    }

    // Finalize each non-empty crown section bucket as a ground-limbable BranchData!
    for (const bucket of crownSectionBuckets) {
      if (bucket.count === 0) continue;
      const avgY = bucket.ySum / bucket.count;
      const center = getTrunkCenterAt(avgY);
      const localR = getTrunkRadiusAt(avgY);
      const outDir = new THREE.Vector3(Math.cos(bucket.dirAngle), 0, Math.sin(bucket.dirAngle)).normalize();

      // Re-center children relative to bucket pivot at trunk attachment so tumbling physics rotate nicely!
      const boughGroup = new THREE.Group();
      boughGroup.position.set(center.x, avgY, center.z);
      while (bucket.group.children.length > 0) {
        const child = bucket.group.children[0];
        child.position.sub(boughGroup.position);
        boughGroup.add(child);
      }

      const bId = `${spec.id}-crown-${crownLimbIdx++}`;
      const collarRing = new THREE.Mesh(
        new THREE.TorusGeometry(Math.max(0.28, localR * 1.45), 0.065, 8, 18),
        new THREE.MeshBasicMaterial({
          color: '#22c55e',
          transparent: true,
          opacity: 0.0,
        })
      );
      collarRing.rotation.y = -bucket.dirAngle + Math.PI / 2;
      collarRing.position.set(outDir.x * localR * 0.9, 0, outDir.z * localR * 0.9);
      boughGroup.add(collarRing);

      const colGeo = new THREE.SphereGeometry(Math.max(1.6, bucket.maxReach * 0.72), 8, 6);
      const colMesh = new THREE.Mesh(colGeo, new THREE.MeshBasicMaterial({ visible: false }));
      colMesh.position.set(outDir.x * bucket.maxReach * 0.55, 0, outDir.z * bucket.maxReach * 0.55);
      colMesh.userData = { treeId: spec.id, branchId: bId, part: 'branch' };
      boughGroup.add(colMesh);

      const crownSeg = findSegmentForY(avgY);
      boughGroup.position.sub(crownSeg.group.position);
      crownSeg.group.add(boughGroup);
      branches.push({
        id: bId,
        treeId: spec.id,
        meshGroup: boughGroup,
        colliderMesh: colMesh,
        collarRing,
        attachLocalPos: new THREE.Vector3(center.x, avgY, center.z),
        worldDirection: outDir,
        radius: Math.max(0.08, localR * 0.35),
        length: bucket.maxReach,
        weight: 0,
        isTarget: false,
        isHealthy: true,
        groundLimbOnly: true,
        cutProgress: 0,
        pruned: false,
      });
    }
    // Leader crown cap
    const topCenter = getTrunkCenterAt(upperHeight);
    const spire = createFoliageCluster(speciesSpec, 1.05, rand, false, botanicalCtx, undefined, 1.0);
    spire.position.set(
      topCenter.x + (speciesSpec.droopingLeader ? 0.95 : 0),
      upperHeight - 0.15,
      topCenter.z
    );
    upperCrownGroup.add(spire);
  } else if (isArbutus) {
    // Sculptural multi-stem Pacific Madrone crown:
    // Thick, contorted co-dominant serpentine boughs forking asymmetrically with open negative space,
    // glowing peeling terracotta elbows, terminal berry-free evergreen rosettes, and weathered deadwood snags!
    const primarySpecs = [
      { hFrac: 0.46, azOffset: -0.95, reachScale: 1.32, riseScale: 0.62, droop: -0.32 },
      { hFrac: 0.62, azOffset: 1.05, reachScale: 1.18, riseScale: 0.84, droop: -0.18 },
      { hFrac: 0.74, azOffset: 2.55, reachScale: 1.08, riseScale: 0.94, droop: -0.1 },
      { hFrac: 0.84, azOffset: -2.05, reachScale: 0.96, riseScale: 1.0, droop: -0.04 },
      { hFrac: 0.95, azOffset: 0.25, reachScale: 0.9, riseScale: 1.08, droop: 0.06 },
    ];
    const baseReach = spec.height * 0.29;
    const rosetteScale = Math.max(1.25, spec.height * 0.115);

    for (let pIdx = 0; pIdx < primarySpecs.length; pIdx++) {
      const ps = primarySpecs[pIdx];
      const attachY = upperHeight * (ps.hFrac + (rand() - 0.5) * 0.05);
      const trunkPos = getTrunkCenterAt(attachY);
      const localTrunkR = getTrunkRadiusAt(attachY);
      const az = madroneAxis + ps.azOffset + (rand() - 0.5) * 0.55;
      const dx = Math.cos(az);
      const dz = Math.sin(az);
      // Orthogonal horizontal vector for wild 3D sideways serpentine bends
      const pxAxis = -dz;
      const pzAxis = dx;
      const twistSign = pIdx % 2 === 0 ? 1 : -1;

      const reach = baseReach * ps.reachScale * (0.88 + rand() * 0.28);
      const rise = baseReach * ps.riseScale * (0.72 + rand() * 0.34);
      const sideS1 = twistSign * reach * (0.24 + rand() * 0.18);
      const sideS2 = -twistSign * reach * (0.16 + rand() * 0.2);

      // 5-point wild serpentine co-dominant scaffold bough (in local coords relative to trunkPos)
      const c0 = new THREE.Vector3(0, 0, 0);
      const c1 = new THREE.Vector3(
        dx * reach * 0.28 + pxAxis * sideS1 * 0.55,
        rise * 0.18 + reach * ps.droop * 0.4,
        dz * reach * 0.28 + pzAxis * sideS1 * 0.55
      );
      const c2 = new THREE.Vector3(
        dx * reach * 0.62 + pxAxis * sideS1,
        rise * 0.38 + reach * ps.droop,
        dz * reach * 0.62 + pzAxis * sideS1
      );
      const c3 = new THREE.Vector3(
        dx * reach * 0.88 + pxAxis * (sideS1 * 0.3 + sideS2 * 0.75),
        rise * 0.78,
        dz * reach * 0.88 + pzAxis * (sideS1 * 0.3 + sideS2 * 0.75)
      );
      const c4 = new THREE.Vector3(
        dx * reach * 1.06 + pxAxis * sideS2,
        rise * 1.04,
        dz * reach * 1.06 + pzAxis * sideS2
      );

      const boughGroup = new THREE.Group();
      boughGroup.position.copy(trunkPos);

      const rBase = Math.max(0.11, localTrunkR * (pIdx >= 3 ? 0.86 : 0.74));
      const primaryGeo = buildTaperedSplineLimbGeometry(
        [c0, c1, c2, c3, c4],
        rBase,
        rBase * 0.24,
        15,
        10,
        pIdx * 2.3 + rand() * 4.0
      );
      const primaryMesh = new THREE.Mesh(primaryGeo, barkMat);
      primaryMesh.castShadow = true;
      primaryMesh.receiveShadow = true;
      boughGroup.add(primaryMesh);

      // Add 3D papery curling bark peels along major scaffold boughs
      if (arbutusPeelMat && quality === 'high') {
        const scCurve = new THREE.CatmullRomCurve3([c0, c1, c2, c3, c4]);
        const scPeels: BarkPeelAnchor[] = [];
        for (let sp = 0; sp < 5; sp++) {
          const st = 0.18 + (sp / 5) * 0.58 + rand() * 0.06;
          const sPos = scCurve.getPoint(st);
          const sTan = scCurve.getTangent(st).normalize();
          const sRad = THREE.MathUtils.lerp(rBase, rBase * 0.24, st);
          const sNorm = new THREE.Vector3(0, 1, 0).applyAxisAngle(sTan, rand() * Math.PI * 2);
          sNorm.addScaledVector(sTan, -sNorm.dot(sTan)).normalize();
          scPeels.push({
            pos: sPos.clone().addScaledVector(sNorm, sRad * 0.98),
            normal: sNorm,
            tangentUp: sTan,
            width: Math.max(0.028, sRad * 0.42),
            length: 0.18 + rand() * 0.24,
            curlDir: rand() > 0.5 ? 1 : -1,
          });
        }
        const spGeo = buildArbutusPeelRibbonsGeometry(scPeels, rand);
        if (spGeo) {
          const spMesh = new THREE.Mesh(spGeo, arbutusPeelMat);
          spMesh.receiveShadow = true;
          boughGroup.add(spMesh);
        }
      }

      // 2-3 crooked twisting secondary forks emerging from mid & outer elbows
      const tipAnchors: Array<{ pos: THREE.Vector3; scale: number }> = [
        { pos: c4, scale: rosetteScale * 1.15 },
      ];
      const subCount = pIdx < 3 ? 3 : 2;
      for (let sf = 0; sf < subCount; sf++) {
        const fSide = sf === 0 ? 1 : sf === 1 ? -1 : twistSign;
        const fStart =
          sf === 0
            ? c2.clone().lerp(c3, 0.25)
            : sf === 1
              ? c1.clone().lerp(c2, 0.72)
              : c3.clone().lerp(c4, 0.2);
        const fLen = reach * (0.42 + rand() * 0.22);
        const fOutX = dx * 0.55 + pxAxis * fSide * 0.82;
        const fOutZ = dz * 0.55 + pzAxis * fSide * 0.82;
        const fMid = fStart.clone().add(
          new THREE.Vector3(
            fOutX * fLen * 0.58,
            (rand() - 0.35) * fLen * 0.42,
            fOutZ * fLen * 0.58
          )
        );
        const fTip = fMid.clone().add(
          new THREE.Vector3(
            (fOutX * 0.7 + dx * 0.35) * fLen * 0.52,
            fLen * (0.36 + rand() * 0.32),
            (fOutZ * 0.7 + dz * 0.35) * fLen * 0.52
          )
        );
        const subGeo = buildTaperedSplineLimbGeometry(
          [fStart, fMid, fTip],
          rBase * (0.48 - sf * 0.08),
          rBase * 0.14,
          10,
          7,
          pIdx * 5.1 + sf * 2.7
        );
        const subMesh = new THREE.Mesh(subGeo, barkMat);
        subMesh.castShadow = true;
        subMesh.receiveShadow = true;
        boughGroup.add(subMesh);
        tipAnchors.push({ pos: fTip, scale: rosetteScale * (0.9 + rand() * 0.24) });
      }

      // Perch lush berry-free evergreen leaf rosettes ONLY at outer terminal tips
      // so the sculptural twisted terracotta limbs shine boldly through the open crown!
      for (const tip of tipAnchors) {
        const outDir = new THREE.Vector3(tip.pos.x, 0, tip.pos.z).normalize();
        const rosette = createFoliageCluster(
          speciesSpec,
          tip.scale,
          rand,
          false,
          botanicalCtx,
          outDir.lengthSq() > 0.01 ? outDir : new THREE.Vector3(dx, 0, dz),
          THREE.MathUtils.clamp(ps.hFrac, 0.45, 0.96)
        );
        rosette.position.set(tip.pos.x, tip.pos.y + 0.02, tip.pos.z);
        boughGroup.add(rosette);
      }

      // Occasional weathered silver-gray deadwood snag jutting from a lower-mid gnarled elbow
      if (arbutusSnagMat && pIdx < 3) {
        const snagStart = c1.clone().lerp(c2, 0.45);
        const snagLen = 0.85 + rand() * 0.95;
        const snagDirX = -pxAxis * twistSign * 0.7 + dx * 0.5;
        const snagDirZ = -pzAxis * twistSign * 0.7 + dz * 0.5;
        const snagMid = snagStart.clone().add(new THREE.Vector3(snagDirX * snagLen * 0.5, -0.18 + rand() * 0.25, snagDirZ * snagLen * 0.5));
        const snagEnd = snagMid.clone().add(new THREE.Vector3(snagDirX * snagLen * 0.5, 0.15 + rand() * 0.25, snagDirZ * snagLen * 0.5));
        const snagGeo = buildTaperedSplineLimbGeometry(
          [snagStart, snagMid, snagEnd],
          rBase * 0.34,
          0.022,
          7,
          6,
          pIdx * 7.3
        );
        const snagMesh = new THREE.Mesh(snagGeo, arbutusSnagMat);
        snagMesh.castShadow = true;
        boughGroup.add(snagMesh);
      }

      const outWorldDir = new THREE.Vector3(dx, 0, dz).normalize();
      if (attachY <= groundLimbCutoffY + 1.0) {
        const bId = `${spec.id}-crown-${crownLimbIdx++}`;
        const collarRing = new THREE.Mesh(
          new THREE.TorusGeometry(Math.max(0.28, rBase * 1.45), 0.055, 8, 18),
          new THREE.MeshBasicMaterial({ color: '#22c55e', transparent: true, opacity: 0.0 })
        );
        collarRing.position.copy(c1.clone().multiplyScalar(0.35));
        boughGroup.add(collarRing);

        const colMesh = new THREE.Mesh(
          new THREE.SphereGeometry(Math.max(1.4, reach * 0.55), 8, 6),
          new THREE.MeshBasicMaterial({ visible: false })
        );
        colMesh.position.copy(c2);
        colMesh.userData = { treeId: spec.id, branchId: bId, part: 'branch' };
        boughGroup.add(colMesh);

        const decSeg = findSegmentForY(Math.min(attachY, maxBuckDist + 1.2));
        boughGroup.position.sub(decSeg.group.position);
        decSeg.group.add(boughGroup);
        branches.push({
          id: bId,
          treeId: spec.id,
          meshGroup: boughGroup,
          colliderMesh: colMesh,
          collarRing,
          attachLocalPos: trunkPos.clone(),
          worldDirection: outWorldDir,
          radius: rBase,
          length: reach,
          weight: 0,
          isTarget: false,
          isHealthy: true,
          groundLimbOnly: true,
          cutProgress: 0,
          pruned: false,
        });
      } else {
        const upperSeg = findSegmentForY(Math.min(attachY, upperHeight));
        boughGroup.position.sub(upperSeg.group.position);
        upperSeg.group.add(boughGroup);
      }
    }
  } else if (isGarryOak) {
    // Wind-carved coastal Garry Oak savanna crown (wider than it is tall!):
    // 7 colossal, crooked, zig-zagging co-dominant primary oak boughs forking early from the stout bole,
    // each splitting into tortured angular secondary limbs with sky-windows & billowing dark-olive oak clouds!
    const oakPrimarySpecs = [
      { hFrac: 0.42, azOffset: -1.15, reachScale: 1.36, riseScale: 0.46, dip: -0.18 },
      { hFrac: 0.51, azOffset: 1.35, reachScale: 1.32, riseScale: 0.54, dip: -0.15 },
      { hFrac: 0.61, azOffset: 2.75, reachScale: 1.24, riseScale: 0.68, dip: -0.12 },
      { hFrac: 0.71, azOffset: -2.35, reachScale: 1.18, riseScale: 0.78, dip: -0.08 },
      { hFrac: 0.8, azOffset: 0.18, reachScale: 1.1, riseScale: 0.88, dip: -0.04 },
      { hFrac: 0.9, azOffset: -0.65, reachScale: 0.92, riseScale: 0.98, dip: 0.04 },
      { hFrac: 0.995, azOffset: 1.95, reachScale: 0.82, riseScale: 1.06, dip: 0.12 },
    ];
    const oakBaseReach = spec.height * 0.38;
    const oakCloudScale = Math.max(1.3, spec.height * 0.11);
    const oakSplineOpts = { tension: 0.18, gnarl: 1.65, tileV: 2.0 };

    for (let pIdx = 0; pIdx < oakPrimarySpecs.length; pIdx++) {
      const ps = oakPrimarySpecs[pIdx];
      const isCrownLeader = pIdx === oakPrimarySpecs.length - 1;
      const attachY = isCrownLeader
        ? upperHeight - 0.05
        : upperHeight * (ps.hFrac + (rand() - 0.5) * 0.04);
      const trunkPos = getTrunkCenterAt(attachY);
      const localTrunkR = getTrunkRadiusAt(attachY);
      const az = madroneAxis + ps.azOffset + (rand() - 0.5) * 0.48;
      const dx = Math.cos(az);
      const dz = Math.sin(az);
      const pxAxis = -dz;
      const pzAxis = dx;
      const zSign = pIdx % 2 === 0 ? 1 : -1;

      const reach = oakBaseReach * ps.reachScale * (0.88 + rand() * 0.24);
      const rise = oakBaseReach * ps.riseScale * (0.64 + rand() * 0.26);
      const zig1 = zSign * reach * (0.2 + rand() * 0.16);
      const zig2 = -zSign * reach * (0.16 + rand() * 0.18);
      const zig3 = zSign * reach * (0.14 + rand() * 0.16);

      // 6-point tortured zig-zagging primary oak scaffold bough (crown leader rises seamlessly from exact trunk apex!)
      const c0 = new THREE.Vector3(0, isCrownLeader ? -0.18 : 0, 0);
      const c1 = new THREE.Vector3(
        dx * reach * (isCrownLeader ? 0.14 : 0.22) + pxAxis * zig1 * 0.55,
        rise * (isCrownLeader ? 0.32 : 0.18) + reach * ps.dip * 0.35,
        dz * reach * (isCrownLeader ? 0.14 : 0.22) + pzAxis * zig1 * 0.55
      );
      const c2 = new THREE.Vector3(
        dx * reach * 0.46 + pxAxis * zig1,
        rise * (isCrownLeader ? 0.52 : 0.26) + reach * ps.dip,
        dz * reach * 0.46 + pzAxis * zig1
      );
      const c3 = new THREE.Vector3(
        dx * reach * 0.68 + pxAxis * zig2,
        rise * 0.66 + (rand() - 0.5) * 0.45,
        dz * reach * 0.68 + pzAxis * zig2
      );
      const c4 = new THREE.Vector3(
        dx * reach * 0.88 + pxAxis * (zig2 * 0.25 + zig3 * 0.75),
        rise * 0.8 + reach * ps.dip * 0.25,
        dz * reach * 0.88 + pzAxis * (zig2 * 0.25 + zig3 * 0.75)
      );
      const c5 = new THREE.Vector3(
        dx * reach * 1.06 + pxAxis * zig3,
        rise * 0.98 + (rand() - 0.4) * 0.5,
        dz * reach * 1.06 + pzAxis * zig3
      );

      const boughGroup = new THREE.Group();
      boughGroup.position.copy(trunkPos);

      const rBase = isCrownLeader
        ? Math.max(0.11, localTrunkR * 1.04)
        : Math.max(0.14, localTrunkR * (pIdx >= 5 ? 0.84 : 0.76));
      const primaryGeo = buildTaperedSplineLimbGeometry(
        [c0, c1, c2, c3, c4, c5],
        rBase,
        rBase * 0.22,
        18,
        10,
        pIdx * 2.9 + rand() * 3.5,
        oakSplineOpts
      );
      const primaryMesh = new THREE.Mesh(primaryGeo, barkMat);
      primaryMesh.castShadow = true;
      primaryMesh.receiveShadow = true;
      boughGroup.add(primaryMesh);

      // 3 crooked, angular secondary oak boughs zig-zagging outward & upward from gnarled knees
      // Keep lower boughs open along their inner span so the tortured pale-gray skeleton shines through sky-windows!
      const cloudAnchors: Array<{ pos: THREE.Vector3; scale: number }> = [
        { pos: c5, scale: oakCloudScale * 1.1 },
      ];
      if (pIdx >= 2) {
        cloudAnchors.push({ pos: c3.clone().add(new THREE.Vector3(0, 0.32, 0)), scale: oakCloudScale * 0.82 });
      }
      const subStarts = [c2, c3, c4];
      for (let sf = 0; sf < 3; sf++) {
        const fSide = sf === 0 ? 1 : sf === 1 ? -1 : zSign;
        const fStart = subStarts[sf].clone();
        const fLen = reach * (0.44 - sf * 0.05) * (0.86 + rand() * 0.28);
        const fDirX = dx * 0.5 + pxAxis * fSide * 0.84;
        const fDirZ = dz * 0.5 + pzAxis * fSide * 0.84;
        const fKnee1 = fStart.clone().add(
          new THREE.Vector3(
            fDirX * fLen * 0.46,
            (rand() - 0.48) * fLen * 0.42,
            fDirZ * fLen * 0.46
          )
        );
        const fKnee2 = fKnee1.clone().add(
          new THREE.Vector3(
            (fDirX * 0.65 + dx * 0.38 - pxAxis * fSide * 0.28) * fLen * 0.38,
            fLen * (0.24 + (rand() - 0.35) * 0.36),
            (fDirZ * 0.65 + dz * 0.38 - pzAxis * fSide * 0.28) * fLen * 0.38
          )
        );
        const fTip = fKnee2.clone().add(
          new THREE.Vector3(
            (fDirX * 0.72 + dx * 0.32) * fLen * 0.34,
            fLen * (0.18 + rand() * 0.26),
            (fDirZ * 0.72 + dz * 0.32) * fLen * 0.34
          )
        );
        const subGeo = buildTaperedSplineLimbGeometry(
          [fStart, fKnee1, fKnee2, fTip],
          rBase * (0.52 - sf * 0.08),
          rBase * 0.14,
          11,
          7,
          pIdx * 4.7 + sf * 3.1,
          oakSplineOpts
        );
        const subMesh = new THREE.Mesh(subGeo, barkMat);
        subMesh.castShadow = true;
        subMesh.receiveShadow = true;
        boughGroup.add(subMesh);
        cloudAnchors.push({ pos: fTip, scale: oakCloudScale * (0.94 + rand() * 0.2) });
      }

      // Billowing dark savanna-oak foliage clouds perched at the outer crooked branch tips
      for (const anchor of cloudAnchors) {
        const outDir = new THREE.Vector3(anchor.pos.x, 0, anchor.pos.z).normalize();
        const cloud = createFoliageCluster(
          speciesSpec,
          anchor.scale,
          rand,
          false,
          botanicalCtx,
          outDir.lengthSq() > 0.01 ? outDir : new THREE.Vector3(dx, 0, dz),
          THREE.MathUtils.clamp(ps.hFrac, 0.38, 0.98)
        );
        cloud.position.set(anchor.pos.x, anchor.pos.y + 0.02, anchor.pos.z);
        boughGroup.add(cloud);
      }

      // Weathered twisted deadwood lower oak snags jutting beneath the wide lower boughs (signature savanna oak character!)
      if (arbutusSnagMat && pIdx < 4) {
        const sn0 = c1.clone().lerp(c2, 0.6);
        const snLen = 1.15 + rand() * 1.1;
        const snDirX = dx * 0.45 - pxAxis * zSign * 0.78;
        const snDirZ = dz * 0.45 - pzAxis * zSign * 0.78;
        const sn1 = sn0.clone().add(new THREE.Vector3(snDirX * snLen * 0.48, -0.35 - rand() * 0.25, snDirZ * snLen * 0.48));
        const sn2 = sn1.clone().add(new THREE.Vector3((snDirX + pxAxis * zSign * 0.35) * snLen * 0.52, -0.1 + rand() * 0.32, (snDirZ + pzAxis * zSign * 0.35) * snLen * 0.52));
        const snGeo = buildTaperedSplineLimbGeometry(
          [sn0, sn1, sn2],
          rBase * 0.32,
          0.022,
          8,
          6,
          pIdx * 6.4,
          oakSplineOpts
        );
        const snMesh = new THREE.Mesh(snGeo, arbutusSnagMat);
        snMesh.castShadow = true;
        boughGroup.add(snMesh);
      }

      const outWorldDir = new THREE.Vector3(dx, 0, dz).normalize();
      if (attachY <= groundLimbCutoffY + 1.0) {
        const bId = `${spec.id}-crown-${crownLimbIdx++}`;
        const collarRing = new THREE.Mesh(
          new THREE.TorusGeometry(Math.max(0.3, rBase * 1.45), 0.055, 8, 18),
          new THREE.MeshBasicMaterial({ color: '#22c55e', transparent: true, opacity: 0.0 })
        );
        collarRing.position.copy(c1.clone().multiplyScalar(0.35));
        boughGroup.add(collarRing);

        const colMesh = new THREE.Mesh(
          new THREE.SphereGeometry(Math.max(1.5, reach * 0.55), 8, 6),
          new THREE.MeshBasicMaterial({ visible: false })
        );
        colMesh.position.copy(c2);
        colMesh.userData = { treeId: spec.id, branchId: bId, part: 'branch' };
        boughGroup.add(colMesh);

        const decSeg = findSegmentForY(Math.min(attachY, maxBuckDist + 1.2));
        boughGroup.position.sub(decSeg.group.position);
        decSeg.group.add(boughGroup);
        branches.push({
          id: bId,
          treeId: spec.id,
          meshGroup: boughGroup,
          colliderMesh: colMesh,
          collarRing,
          attachLocalPos: trunkPos.clone(),
          worldDirection: outWorldDir,
          radius: rBase,
          length: reach,
          weight: 0,
          isTarget: false,
          isHealthy: true,
          groundLimbOnly: true,
          cutProgress: 0,
          pruned: false,
        });
      } else {
        const upperSeg = findSegmentForY(Math.min(attachY, upperHeight));
        boughGroup.position.sub(upperSeg.group.position);
        upperSeg.group.add(boughGroup);
      }
    }
  } else if (isSmokeTree) {
    // Authentic low-branching multi-leader Smoke Tree (Cotinus coggygria 'Royal Purple'):
    // Branches almost from the ground collar (y ~ 0.75-1.4m) into 7 stout diverging co-dominant woody leaders
    // forming a wide, billowing shrub-tree mound (width > height) enveloped in gossamer raspberry-rose smoke plumes
    // with pockets of deep Royal Purple rounded leaves peeking through interior forks!
    const smokeSplineOpts = { tension: 0.34, gnarl: 0.92, tileV: 1.55 };
    const smokeCloudScale = Math.max(1.18, spec.height * 0.165);
    const baseAz = spec.leanAngle + (rand() - 0.5) * 0.9;
    const smokeLeaders: Array<{
      hFrac: number;
      az: number;
      reachFrac: number;
      riseFrac: number;
      sweepDrop: number;
      isApex?: boolean;
      spireTip?: boolean;
    }> = [
      // 3 bold low-sweeping outer leaders springing almost right off the ground collar (~0.70-1.15m off ground!)
      { hFrac: 0.08, az: baseAz + 0.16, reachFrac: 0.56, riseFrac: 0.26, sweepDrop: -0.07, spireTip: true },
      { hFrac: 0.11, az: baseAz + 2.34, reachFrac: 0.52, riseFrac: 0.31, sweepDrop: -0.05 },
      { hFrac: 0.14, az: baseAz - 2.06, reachFrac: 0.48, riseFrac: 0.34, sweepDrop: -0.04 },
      // 3 surging mid-height co-dominant leaders fanning out broadly in distinct undulating smoke lobes
      { hFrac: 0.19, az: baseAz + 1.18, reachFrac: 0.48, riseFrac: 0.52, sweepDrop: 0.02, spireTip: true },
      { hFrac: 0.23, az: baseAz - 0.94, reachFrac: 0.44, riseFrac: 0.48, sweepDrop: 0.02 },
      { hFrac: 0.29, az: baseAz + 3.24, reachFrac: 0.42, riseFrac: 0.58, sweepDrop: 0.04, spireTip: true },
      // 1 central rising crown leader continuing seamlessly from the short basal stem apex
      { hFrac: 1.0, az: baseAz + 0.65, reachFrac: 0.28, riseFrac: 0.46, sweepDrop: 0.06, isApex: true, spireTip: true },
    ];

    for (let sIdx = 0; sIdx < smokeLeaders.length; sIdx++) {
      const sl = smokeLeaders[sIdx];
      const isApex = Boolean(sl.isApex);
      const attachY = isApex
        ? upperHeight - 0.05
        : Math.max(0.28, upperHeight * (sl.hFrac + (rand() - 0.5) * 0.04));
      const trunkPos = getTrunkCenterAt(Math.min(attachY, upperHeight));
      const localTrunkR = getTrunkRadiusAt(Math.min(attachY, upperHeight));
      const az = sl.az + (rand() - 0.5) * 0.34;
      const dx = Math.cos(az);
      const dz = Math.sin(az);
      const pxAxis = -dz;
      const pzAxis = dx;
      const zSign = sIdx % 2 === 0 ? 1 : -1;

      const reach = spec.height * sl.reachFrac * (0.9 + rand() * 0.22);
      const rise = spec.height * sl.riseFrac * (0.88 + rand() * 0.24);
      const sway1 = zSign * reach * (0.14 + rand() * 0.12);
      const sway2 = -zSign * reach * (0.10 + rand() * 0.12);

      // 5-point curving woody co-dominant leader springing outward from low near the ground
      const p0 = new THREE.Vector3(0, isApex ? -0.14 : 0, 0);
      const p1 = new THREE.Vector3(
        dx * reach * 0.24 + pxAxis * sway1 * 0.45,
        rise * 0.28 + reach * sl.sweepDrop * 0.3,
        dz * reach * 0.24 + pzAxis * sway1 * 0.45
      );
      const p2 = new THREE.Vector3(
        dx * reach * 0.54 + pxAxis * sway1,
        rise * 0.56 + reach * sl.sweepDrop,
        dz * reach * 0.54 + pzAxis * sway1
      );
      const p3 = new THREE.Vector3(
        dx * reach * 0.82 + pxAxis * (sway1 * 0.35 + sway2 * 0.65),
        rise * 0.82 + (rand() - 0.4) * 0.35,
        dz * reach * 0.82 + pzAxis * (sway1 * 0.35 + sway2 * 0.65)
      );
      const p4 = new THREE.Vector3(
        dx * reach * 1.04 + pxAxis * sway2,
        rise * 1.02 + (rand() - 0.35) * 0.35,
        dz * reach * 1.04 + pzAxis * sway2
      );

      const boughGroup = new THREE.Group();
      boughGroup.position.copy(trunkPos);

      // Stout co-dominant leader radius so multiple woody stems are unmistakably visible rising from the base!
      const rBase = isApex
        ? Math.max(0.08, localTrunkR * 0.96)
        : Math.max(0.095, localTrunkR * (0.72 + (sIdx < 3 ? 0.1 : 0.04)));
      const leaderGeo = buildTaperedSplineLimbGeometry(
        [p0, p1, p2, p3, p4],
        rBase,
        rBase * 0.20,
        14,
        8,
        sIdx * 3.1 + rand() * 2.5,
        smokeSplineOpts
      );
      const leaderMesh = new THREE.Mesh(leaderGeo, barkMat);
      leaderMesh.castShadow = true;
      leaderMesh.receiveShadow = true;
      boughGroup.add(leaderMesh);

      // Billowing smoke-cloud & peeking dark-plum leaf anchor points along this leader
      const cloudAnchors: Array<{ pos: THREE.Vector3; scale: number; hFrac: number }> = [
        // Inner pocket: richer deep Royal Purple foliage peeking through interior stems
        { pos: p2.clone().add(new THREE.Vector3(0, 0.1, 0)), scale: smokeCloudScale * 0.92, hFrac: 0.24 },
        // Outer tip: lush billowing raspberry-rose smoke cloud
        { pos: p4, scale: smokeCloudScale * 1.18, hFrac: 0.88 },
      ];

      // 3 spreading secondary branches per leader so the whole wide mound fills with layered smoke puffs!
      const subStarts = [p1.clone().lerp(p2, 0.6), p2, p3];
      for (let sf = 0; sf < 3; sf++) {
        const fSide = sf === 0 ? 1 : sf === 1 ? -1 : zSign;
        const fStart = subStarts[sf].clone();
        const fLen = reach * (0.48 - sf * 0.05) * (0.85 + rand() * 0.28);
        const fDirX = dx * 0.56 + pxAxis * fSide * 0.82;
        const fDirZ = dz * 0.56 + pzAxis * fSide * 0.82;
        // Lowest outer forks drape gently down toward the grass just like mature lawn smoke trees!
        const drapeBias = sIdx < 3 && sf === 0 ? -0.18 : 0.24;
        const fMid = fStart.clone().add(
          new THREE.Vector3(fDirX * fLen * 0.52, fLen * (drapeBias + (rand() - 0.35) * 0.26), fDirZ * fLen * 0.52)
        );
        const fTip = fMid.clone().add(
          new THREE.Vector3(
            (fDirX * 0.72 + dx * 0.32) * fLen * 0.52,
            fLen * (drapeBias * 0.5 + 0.16 + rand() * 0.22),
            (fDirZ * 0.72 + dz * 0.32) * fLen * 0.52
          )
        );
        const subGeo = buildTaperedSplineLimbGeometry(
          [fStart, fMid, fTip],
          rBase * (0.50 - sf * 0.07),
          rBase * 0.13,
          9,
          6,
          sIdx * 4.3 + sf * 2.7,
          smokeSplineOpts
        );
        const subMesh = new THREE.Mesh(subGeo, barkMat);
        subMesh.castShadow = true;
        subMesh.receiveShadow = true;
        boughGroup.add(subMesh);

        cloudAnchors.push({
          pos: fTip,
          scale: smokeCloudScale * (0.98 + rand() * 0.24),
          hFrac: sf === 0 && sIdx < 3 ? 0.58 : 0.78 + rand() * 0.22,
        });
      }

      // Occasional tall airy smoke-plume spire rising organically above the billowing mound (signature Cotinus look!)
      if (sl.spireTip) {
        const spireBase = p3.clone().lerp(p4, 0.55);
        const spireMid = spireBase.clone().add(
          new THREE.Vector3(dx * 0.45 + pxAxis * zSign * 0.25, 0.75 + rand() * 0.4, dz * 0.45 + pzAxis * zSign * 0.25)
        );
        const spireTip = spireMid.clone().add(
          new THREE.Vector3(dx * 0.35, 0.65 + rand() * 0.45, dz * 0.35)
        );
        const spireGeo = buildTaperedSplineLimbGeometry(
          [spireBase, spireMid, spireTip],
          rBase * 0.24,
          0.016,
          7,
          5,
          sIdx * 6.1,
          smokeSplineOpts
        );
        const spireMesh = new THREE.Mesh(spireGeo, barkMat);
        spireMesh.castShadow = true;
        boughGroup.add(spireMesh);
        cloudAnchors.push({ pos: spireTip, scale: smokeCloudScale * 0.86, hFrac: 1.0 });
      }

      for (const anchor of cloudAnchors) {
        const outDir = new THREE.Vector3(anchor.pos.x, 0, anchor.pos.z).normalize();
        const cloud = createFoliageCluster(
          speciesSpec,
          anchor.scale,
          rand,
          false,
          botanicalCtx,
          outDir.lengthSq() > 0.01 ? outDir : undefined,
          anchor.hFrac
        );
        cloud.position.copy(anchor.pos);
        boughGroup.add(cloud);
      }

      const upperSeg = findSegmentForY(Math.min(attachY, upperHeight));
      boughGroup.position.sub(upperSeg.group.position);
      upperSeg.group.add(boughGroup);
    }
  } else {
    // Deciduous upper dome (tuned for wild hardwoods + ornamental garden trees + coastal broadleafs)
    const domeCenter = getTrunkCenterAt(
      upperHeight *
        (spec.species === 'japanese_maple' ||
        spec.species === 'smoke_tree' ||
        spec.species === 'garry_oak'
          ? 0.78
          : spec.species === 'eucalyptus'
            ? 0.88
            : 0.86)
    );
    const clusterCount =
      spec.species === 'bigleaf_maple' ||
      spec.species === 'weeping_willow' ||
      spec.species === 'garry_oak'
        ? 14
        : spec.species === 'white_poplar' ||
            spec.species === 'arbutus' ||
            spec.species === 'eucalyptus'
          ? 13
          : 11;
    const domeRadius =
      spec.species === 'garry_oak'
        ? spec.height * 0.35
        : spec.species === 'weeping_willow' || spec.species === 'arbutus'
          ? spec.height * 0.3
          : spec.species === 'japanese_maple' ||
              spec.species === 'smoke_tree' ||
              spec.species === 'rhododendron'
            ? spec.height * 0.33
            : spec.species === 'lilac' || spec.species === 'chokecherry'
              ? spec.height * 0.29
              : spec.species === 'bigleaf_maple'
                ? spec.height * 0.27
                : spec.species === 'eucalyptus'
                  ? spec.height * 0.24
                  : spec.species === 'white_poplar'
                    ? spec.height * 0.22
                    : spec.species === 'trembling_aspen'
                      ? spec.height * 0.2
                      : spec.height * 0.19;
    const folScale =
      spec.species === 'bigleaf_maple' || spec.species === 'garry_oak'
        ? 2.1
        : spec.species === 'weeping_willow' ||
            spec.species === 'arbutus' ||
            spec.species === 'eucalyptus'
          ? 1.65
          : spec.species === 'white_poplar' || spec.species === 'trembling_aspen'
            ? 1.38
            : spec.species === 'japanese_maple' ||
                spec.species === 'lilac' ||
                spec.species === 'smoke_tree' ||
                spec.species === 'rhododendron' ||
                spec.species === 'chokecherry'
              ? Math.max(1.05, spec.height * 0.165)
              : 1.55;
    for (let c = 0; c < clusterCount; c++) {
      const phi = Math.acos(1 - (c + 0.5) / clusterCount) * 0.74;
      const theta = c * 2.39996 + rand() * 0.4;
      const r = domeRadius * (0.62 + rand() * 0.42);
      const px = domeCenter.x + Math.sin(phi) * Math.cos(theta) * r;
      const py =
        domeCenter.y +
        Math.cos(phi) *
          r *
          (spec.species === 'japanese_maple'
            ? 0.48
            : spec.species === 'garry_oak'
              ? 0.56
              : spec.species === 'white_poplar' ||
                  spec.species === 'eucalyptus' ||
                  spec.species === 'trembling_aspen'
                ? 0.94
                : 0.72);
      const pz = domeCenter.z + Math.sin(phi) * Math.sin(theta) * r;
      const outDir = new THREE.Vector3(px - domeCenter.x, 0, pz - domeCenter.z).normalize();
      const domeHFrac = THREE.MathUtils.clamp(
        (py - upperHeight * 0.36) / Math.max(1, upperHeight * 0.72),
        0.44,
        1.0
      );
      const cluster = createFoliageCluster(
        speciesSpec,
        folScale,
        rand,
        false,
        botanicalCtx,
        outDir.lengthSq() > 0.01 ? outDir : undefined,
        domeHFrac
      );

      if (py <= groundLimbCutoffY + 1.0) {
        const boughGroup = new THREE.Group();
        boughGroup.position.set(px, py, pz);
        boughGroup.add(cluster);

        if (botanicalCtx) {
          // Woody scaffold branch connecting trunk crown fork to this outer foliage cluster
          const trunkAttachY = Math.max(upperHeight * 0.45, Math.min(py - 0.35, upperHeight * 0.88));
          const trunkAttach = getTrunkCenterAt(trunkAttachY);
          const localStart = trunkAttach.clone().sub(boughGroup.position);
          const limb = buildCrownScaffoldLimb(
            localStart,
            new THREE.Vector3(0, 0, 0),
            Math.max(0.06, baseRadius * 0.26),
            0.024,
            botanicalCtx.twigMat
          );
          if (limb) boughGroup.add(limb);
        }

        const bId = `${spec.id}-crown-${crownLimbIdx++}`;
        const collarRing = new THREE.Mesh(
          new THREE.TorusGeometry(0.45, 0.055, 8, 18),
          new THREE.MeshBasicMaterial({ color: '#22c55e', transparent: true, opacity: 0.0 })
        );
        boughGroup.add(collarRing);

        const colMesh = new THREE.Mesh(
          new THREE.SphereGeometry(folScale * 0.85, 8, 6),
          new THREE.MeshBasicMaterial({ visible: false })
        );
        colMesh.userData = { treeId: spec.id, branchId: bId, part: 'branch' };
        boughGroup.add(colMesh);

        const decSeg = findSegmentForY(Math.min(py, maxBuckDist + 1.2));
        boughGroup.position.sub(decSeg.group.position);
        decSeg.group.add(boughGroup);
        branches.push({
          id: bId,
          treeId: spec.id,
          meshGroup: boughGroup,
          colliderMesh: colMesh,
          collarRing,
          attachLocalPos: new THREE.Vector3(domeCenter.x, Math.min(py, maxBuckDist + 1.2), domeCenter.z),
          worldDirection: outDir.lengthSq() > 0.01 ? outDir : new THREE.Vector3(1, 0, 0),
          radius: 0.14,
          length: folScale * 1.4,
          weight: 0,
          isTarget: false,
          isHealthy: true,
          groundLimbOnly: true,
          cutProgress: 0,
          pruned: false,
        });
      } else {
        const upperSeg = findSegmentForY(Math.min(py, upperHeight));
        const clusterLocalPos = new THREE.Vector3(
          px - upperSeg.group.position.x,
          py - upperSeg.group.position.y,
          pz - upperSeg.group.position.z
        );
        cluster.position.copy(clusterLocalPos);
        if (botanicalCtx) {
          const trunkAttachY = Math.max(upperHeight * 0.52, Math.min(py - 0.4, upperHeight * 0.92));
          const trunkAttach = getTrunkCenterAt(trunkAttachY).sub(upperSeg.group.position);
          const limb = buildCrownScaffoldLimb(
            trunkAttach,
            clusterLocalPos,
            Math.max(0.055, baseRadius * 0.24),
            0.02,
            botanicalCtx.twigMat
          );
          if (limb) upperSeg.group.add(limb);
        }
        upperSeg.group.add(cluster);
      }
    }
  }
  const topSeg = segments[segments.length - 1];
  upperCrownGroup.position.copy(topSeg.group.position).negate();
  topSeg.group.add(upperCrownGroup);

  // 8. Bucking Cut Rings along the trunk (hidden until tree is fallen!)
  const buckRings: BuckRingData[] = [];
  for (let buckIdx = 0; buckIdx < buckCutDistances.length; buckIdx++) {
    const d = buckCutDistances[buckIdx];
    const rAtD = getTrunkRadiusAt(d);
    const centerAtD = getTrunkCenterAt(d);
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(rAtD * 1.38, 0.105, 10, 24),
      new THREE.MeshBasicMaterial({
        color: '#facc15',
        transparent: true,
        opacity: 0.92,
      })
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.copy(centerAtD);
    ring.visible = false;
    const buckId = `${spec.id}-buck-${buckIdx}`;
    ring.userData = { treeId: spec.id, buckId, part: 'buck_ring' };
    trunkPivot.add(ring);
    buckRings.push({
      id: buckId,
      distanceAlongTrunk: d,
      ringMesh: ring,
      cutProgress: 0,
      cutDone: false,
    });
  }

  // 8b. Standing Top-Down Piecing Rings (ordered highest first; only the active top ring is shown!)
  const standingTopCuts: StandingTopCutData[] = [];
  for (let tIdx = 0; tIdx < standingLocalYsDesc.length; tIdx++) {
    const localY = standingLocalYsDesc[tIdx];
    const rAtY = getTrunkRadiusAt(localY);
    const centerAtY = getTrunkCenterAt(localY);
    const startSegmentIndex = segments.findIndex((seg) => Math.abs(seg.yStart - localY) < 0.05);
    if (startSegmentIndex <= 0) continue;

    const topCutId = `${spec.id}-top-${tIdx}`;
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(Math.max(0.58, rAtY * 2.15), 0.145, 10, 28),
      new THREE.MeshBasicMaterial({
        color: '#facc15',
        transparent: true,
        opacity: 0.96,
        depthTest: false,
      })
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.copy(centerAtY);
    ring.renderOrder = 12;
    ring.visible = false;
    ring.userData = { treeId: spec.id, topCutId, part: 'standing_top_cut' };
    trunkPivot.add(ring);

    const collider = new THREE.Mesh(
      new THREE.CylinderGeometry(Math.max(1.75, rAtY * 4.6), Math.max(1.75, rAtY * 4.6), 2.5, 10),
      new THREE.MeshBasicMaterial({ visible: false })
    );
    collider.position.copy(centerAtY);
    collider.userData = { treeId: spec.id, topCutId, part: 'standing_top_cut' };
    trunkPivot.add(collider);

    standingTopCuts.push({
      id: topCutId,
      localY,
      remainingHeight: cutHeight + localY,
      startSegmentIndex,
      ringMesh: ring,
      colliderMesh: collider,
      cutProgress: 0,
      cutDone: false,
    });
  }

  // 9. Ground Selection Ring around Tree Base
  const selectionRing = new THREE.Mesh(
    new THREE.RingGeometry(baseRadius * 1.75, baseRadius * 2.15, 32),
    new THREE.MeshBasicMaterial({
      color: '#34d399',
      transparent: true,
      opacity: 0.6,
      side: THREE.DoubleSide,
    })
  );
  selectionRing.rotation.x = -Math.PI / 2;
  selectionRing.position.y = 0.08;
  rootGroup.add(selectionRing);

  // Pool foliage materials per tree for fewer shader compiles & draw switches,
  // and enable smooth organic lighting + wind vertex sway on High quality!
  const foliageMatPool = new Map<string, THREE.MeshStandardMaterial>();
  const isFoliageDescendant = (obj: THREE.Object3D): boolean => {
    let cur: THREE.Object3D | null = obj.parent;
    while (cur && cur !== rootGroup) {
      if (cur.userData?.isFoliage) return true;
      cur = cur.parent;
    }
    return false;
  };

  rootGroup.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    // Skip botanical sprig card & 2nd-order twig meshes (already pooled per tree with custom sprig shaders!)
    if (mesh.userData?.isBotanicalSprig || mesh.userData?.isBotanicalTwig) return;
    if (!isFoliageDescendant(mesh)) return;
    const orig = mesh.material;
    if (!(orig instanceof THREE.MeshStandardMaterial)) return;
    const key = `${orig.color.getHexString()}|${orig.roughness.toFixed(2)}|${orig.metalness.toFixed(2)}`;
    let pooled = foliageMatPool.get(key);
    if (!pooled) {
      pooled = orig;
      if (quality === 'high') {
        pooled.flatShading = false;
        pooled.roughness = Math.max(pooled.roughness, speciesSpec.category === 'conifer' ? 0.85 : 0.78);
        pooled.envMapIntensity = 0.42;
        if (options.windUniforms) {
          applyFoliageWindShader(pooled, options.windUniforms);
        }
        pooled.needsUpdate = true;
      }
      foliageMatPool.set(key, pooled);
    } else {
      orig.dispose();
      mesh.material = pooled;
    }
  });

  // Cache unique MeshStandardMaterials for camera-occlusion see-through fading
  const occlusionMaterials: Array<{ mat: THREE.Material; baseOpacity: number }> = [];
  const seenMats = new Set<THREE.Material>();
  rootGroup.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (mesh.userData?.isWedge) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of mats) {
      if (!mat || seenMats.has(mat)) continue;
      // Skip UI/guide MeshBasicMaterials (collar rings, buck rings, selection ring, colliders)
      if ((mat as THREE.MeshBasicMaterial).isMeshBasicMaterial) continue;
      seenMats.add(mat);
      occlusionMaterials.push({
        mat,
        baseOpacity: mat.opacity ?? 1,
      });
    }
  });

  const initialAim = spec.dropZone ? spec.dropZone.angle : spec.leanAngle;

  const runtime: TreeRuntime = {
    spec,
    speciesSpec,
    rootGroup,
    stumpGroup,
    trunkPivot,
    trunkMesh,
    segments,
    notchCutoutGroup,
    notchParts: {
      ceiling: notchCeiling,
      floor: notchFloor,
    },
    cutShaderUniforms,
    cutTopY,
    cutCenterXZ,
    cutRadius,
    cutRadiusSlope,
    backCutGroup,
    backCutParts: {
      topFace: backTopFace,
      bottomFace: backBottomFace,
      hingeWall: backHingeWall,
    },
    wedgeMeshes,
    branches,
    buckRings,
    standingTopCuts,
    topCutsCompleted: 0,
    currentHeight: spec.height,
    baseRadius,
    cutHeight,
    stage: 'standing',
    aimAngle: initialAim,
    notchDepth: 0,
    notchQuality: 0,
    backCutDepth: 0,
    hingeIntegrity: 1,
    wedgesDriven: 0,
    currentLeanVec: new THREE.Vector2(
      Math.cos(spec.leanAngle) * spec.leanStrength,
      Math.sin(spec.leanAngle) * spec.leanStrength
    ),
    fallAngle: 0,
    fallVelocity: 0,
    actualFallDirection: initialAim,
    fallBounce: 0,
    landedInDropZone: false,
    hitHazards: [],
    prunedTargetCount: 0,
    prunedHealthyPenaltyCount: 0,
    limbedCount: 0,
    buckedCount: 0,
    totalBuckCuts: buckRings.length,
    completed: false,
    occlusionFade: 1,
    occlusionMaterials,
    selectionRing,
  };

  recomputeTreeLean(runtime);
  syncTrunkCutVisuals(runtime);
  return runtime;
}

/** Dispose previous BufferGeometry on a mesh and assign a fresh one. */
function replaceMeshGeometry(mesh: THREE.Mesh, geo: THREE.BufferGeometry): void {
  const prev = mesh.geometry;
  mesh.geometry = geo;
  if (prev && prev !== geo) prev.dispose();
}

type CutShaderUniforms = TreeRuntime['cutShaderUniforms'];

/**
 * Local-space bark fragment discard for segments[0]:
 * Punches the exact analytical intersection of the cylindrical trunk with
 * the two Humboldt face-notch saw planes (horizontal ceiling + 41° sloped floor)
 * and the horizontal rear back-cut kerf.
 */
function applyTrunkCutDiscardShader(
  mat: THREE.MeshStandardMaterial,
  uniforms: CutShaderUniforms
): void {
  mat.customProgramCacheKey = () => 'trunk-cut-humboldt-local-v4';
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform vec3 uSeg0Pos;
        varying vec3 vPivotPos;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vPivotPos = transformed + uSeg0Pos;`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vPivotPos;
        uniform vec2 uCutCenterXZ;
        uniform vec2 uAimDir;
        uniform float uFaceEnabled;
        uniform float uFaceTopY;
        uniform float uFaceHingeX;
        uniform float uFaceSlope;
        uniform float uBackEnabled;
        uniform float uBackCenterY;
        uniform float uBackHalfH;
        uniform float uBackTipX;`
      )
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
        if (uFaceEnabled > 0.5 || uBackEnabled > 0.5) {
          float lx = dot(vPivotPos.xz - uCutCenterXZ, uAimDir);
          if (uFaceEnabled > 0.5 && lx > uFaceHingeX) {
            // Match inner bark radius (0.992) so the bark cleanly frames the sloped floor lip with zero gap
            float yFloor = uFaceTopY - uFaceSlope * max(0.0, lx * 0.992 - uFaceHingeX);
            if (vPivotPos.y < uFaceTopY - 0.002 && vPivotPos.y > yFloor) {
              discard;
            }
          }
          if (uBackEnabled > 0.5 && lx < uBackTipX) {
            if (abs(vPivotPos.y - uBackCenterY) < uBackHalfH - 0.001) {
              discard;
            }
          }
        }`
      );
  };
  mat.needsUpdate = true;
}

/**
 * Builds one D-shaped cylindrical cross-section face for the Humboldt notch
 * (either the flat horizontal ceiling or the 47° sloped floor) whose curved outer
 * edge tracks the tapered trunk radius rAtY(y) flush inside the 32-sided bark cylinder.
 */
function buildCylindricalNotchFace(
  rAtY: (y: number) => number,
  xHinge: number,
  yAtX: (x: number) => number,
  faceDown: boolean,
  steps = 28
): THREE.BufferGeometry {
  const yHinge = yAtX(xHinge);
  const rHinge = rAtY(yHinge);
  const clampedHinge = THREE.MathUtils.clamp(xHinge, -rHinge * 0.88, rHinge * 0.96);
  const thetaMax = Math.acos(THREE.MathUtils.clamp(clampedHinge / rHinge, -0.999, 0.999));

  const positions: number[] = [];
  const uvs: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const inv2R = 1 / Math.max(0.01, rHinge * 2);

  // Subtle ambient-occlusion gradient: darker inside deep V-crease apex, sunlit at outer bark rim
  const hingeShade = faceDown ? 0.58 : 0.66;
  const rimShade = faceDown ? 0.88 : 1.0;

  for (let i = 0; i <= steps; i++) {
    const theta = -thetaMax + (i / steps) * (thetaMax * 2);
    const cosT = Math.cos(theta);
    const sinT = Math.sin(theta);

    // 2 fixed-point iterations match exact tapered radius at height yArc
    let rArc = rHinge;
    let yArc = yHinge;
    for (let it = 0; it < 2; it++) {
      yArc = yAtX(Math.max(clampedHinge, rArc * cosT));
      rArc = rAtY(yArc);
    }
    const xArc = Math.max(clampedHinge, rArc * cosT);
    const zArc = rArc * sinT;
    const zHinge = Math.min(Math.abs(zArc), Math.sqrt(Math.max(0, rHinge * rHinge - clampedHinge * clampedHinge))) * Math.sign(zArc);

    // Hinge vertex (even index)
    positions.push(clampedHinge, yHinge, zHinge);
    uvs.push(0.5 + clampedHinge * inv2R, 0.5 + zHinge * inv2R);
    colors.push(hingeShade, hingeShade * 0.94, hingeShade * 0.86);

    // Outer bark-arc vertex (odd index)
    positions.push(xArc, yArc, zArc);
    uvs.push(0.5 + xArc * inv2R, 0.5 + zArc * inv2R);
    colors.push(rimShade, rimShade, rimShade);
  }

  for (let i = 0; i < steps; i++) {
    const h0 = i * 2;
    const a0 = i * 2 + 1;
    const h1 = (i + 1) * 2;
    const a1 = (i + 1) * 2 + 1;
    if (faceDown) {
      // Normal points -Y (downward ceiling)
      indices.push(h0, a0, a1, h0, a1, h1);
    } else {
      // Normal points (+slope, +1, 0) (upward & outward 47° floor)
      indices.push(h0, h1, a1, h0, a1, a0);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Builds one D-shaped cylindrical horizontal face for the rear back-cut kerf
 * on the -X side of the trunk (from -radius up to xTip).
 */
function buildCylindricalBackFace(
  radius: number,
  xTip: number,
  yConst: number,
  faceUp: boolean,
  steps = 24
): THREE.BufferGeometry {
  const clampedTip = THREE.MathUtils.clamp(xTip, -radius * 0.96, radius * 0.88);
  const alpha = Math.acos(THREE.MathUtils.clamp(-clampedTip / radius, -0.999, 0.999));

  const positions: number[] = [];
  const uvs: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const inv2R = 1 / Math.max(0.01, radius * 2);

  for (let i = 0; i <= steps; i++) {
    const u = -alpha + (i / steps) * (alpha * 2);
    const xArc = -radius * Math.cos(u);
    const zArc = radius * Math.sin(u);

    positions.push(clampedTip, yConst, zArc);
    uvs.push(0.5 + clampedTip * inv2R, 0.5 + zArc * inv2R);
    colors.push(0.55, 0.50, 0.45);

    positions.push(xArc, yConst, zArc);
    uvs.push(0.5 + xArc * inv2R, 0.5 + zArc * inv2R);
    colors.push(0.95, 0.95, 0.95);
  }

  for (let i = 0; i < steps; i++) {
    const h0 = i * 2;
    const a0 = i * 2 + 1;
    const h1 = (i + 1) * 2;
    const a1 = (i + 1) * 2 + 1;
    if (faceUp) {
      indices.push(h0, a0, a1, h0, a1, h1);
    } else {
      indices.push(h0, h1, a1, h0, a1, a0);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/** Vertical inner wood wall at the advancing tip of the rear back-cut slot (faces -X). */
function buildBackHingeWall(
  xTip: number,
  yBottom: number,
  yTop: number,
  zHalf: number
): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(
      [
        xTip, yBottom, -zHalf,
        xTip, yBottom, zHalf,
        xTip, yTop, zHalf,
        xTip, yTop, -zHalf,
      ],
      3
    )
  );
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Rebuilds the cylindrical Humboldt face notch & rear back-cut kerf
 * and updates local-space bark-discard uniforms so the trunk cleanly opens
 * into a crisp textbook wedge as the player saws.
 */
export function syncTrunkCutVisuals(tree: TreeRuntime): void {
  const r = tree.cutRadius;
  const yTop = tree.cutTopY;
  const rotY = -tree.aimAngle;
  const u = tree.cutShaderUniforms;

  // Exact tapered inner radius at height y (nested flush inside the 32-sided bark cylinder)
  const rAtY = (y: number) => (r + tree.cutRadiusSlope * (y - yTop)) * 0.995;

  u.uAimDir.value.set(Math.cos(tree.aimAngle), Math.sin(tree.aimAngle));
  u.uCutCenterXZ.value.copy(tree.cutCenterXZ);
  u.uFaceTopY.value = yTop;

  // --- 1. Humboldt Face Notch (flat horizontal top + ~47° sloped bottom rising to hinge) ---
  const showFace = tree.notchDepth > 0.015 && tree.notchCutoutGroup.visible;
  // notchDepth = 0.30 (ideal) -> depth ≈ 0.72 * r (~36% of diameter 2r)
  const depth = Math.min(r * 1.16, r * (0.14 + tree.notchDepth * 1.92));
  const xHinge = r - depth;
  // Keep bottom of Humboldt mouth safely above stumpCap (y=0) even at max overcut
  const maxOpenH = Math.max(0.16, yTop - 0.06);
  const slope = Math.min(1.08, maxOpenH / Math.max(0.05, depth));

  tree.notchCutoutGroup.position.set(tree.cutCenterXZ.x, 0, tree.cutCenterXZ.y);
  tree.notchCutoutGroup.rotation.set(0, rotY, 0);
  tree.notchCutoutGroup.scale.set(1, 1, 1);

  u.uFaceEnabled.value = showFace ? 1 : 0;
  u.uFaceHingeX.value = xHinge;
  u.uFaceSlope.value = slope;

  const faceKey = showFace ? Math.round(tree.notchDepth * 250) : -1;
  if ((tree.notchCutoutGroup.userData.faceKey ?? -2) !== faceKey) {
    tree.notchCutoutGroup.userData.faceKey = faceKey;
    if (showFace) {
      replaceMeshGeometry(
        tree.notchParts.ceiling,
        buildCylindricalNotchFace(rAtY, xHinge, () => yTop, true)
      );
      replaceMeshGeometry(
        tree.notchParts.floor,
        buildCylindricalNotchFace(
          rAtY,
          xHinge,
          (x) => yTop - slope * Math.max(0, x - xHinge),
          false
        )
      );
    }
  }

  // --- 2. Rear Back Cut (horizontal kerf slot ~7cm above Humboldt ceiling) ---
  const showBack = tree.backCutDepth > 0.015 && tree.backCutGroup.visible;
  const yBack = yTop + 0.07;
  const halfH = Math.max(0.028, r * 0.055);
  const rBack = rAtY(yBack);
  // Advances from -r toward xHinge, leaving a visible holding hinge near backCutDepth = 0.82
  const spanToHinge = Math.max(r * 0.65, xHinge + r);
  const backAdvance = Math.min(r * 1.82, spanToHinge * Math.min(1.04, tree.backCutDepth * 1.06));
  const xBackTip = -r + backAdvance;

  tree.backCutGroup.position.set(tree.cutCenterXZ.x, 0, tree.cutCenterXZ.y);
  tree.backCutGroup.rotation.set(0, rotY, 0);
  tree.backCutGroup.scale.set(1, 1, 1);

  u.uBackEnabled.value = showBack ? 1 : 0;
  u.uBackCenterY.value = yBack;
  u.uBackHalfH.value = halfH;
  u.uBackTipX.value = xBackTip;

  const backKey = showBack ? Math.round(tree.backCutDepth * 250) : -1;
  if ((tree.backCutGroup.userData.backKey ?? -2) !== backKey) {
    tree.backCutGroup.userData.backKey = backKey;
    if (showBack) {
      const clampedTip = THREE.MathUtils.clamp(xBackTip, -rBack * 0.96, rBack * 0.88);
      const zHalf = Math.sqrt(Math.max(0.0001, rBack * rBack - clampedTip * clampedTip));
      replaceMeshGeometry(
        tree.backCutParts.bottomFace,
        buildCylindricalBackFace(rAtY(yBack - halfH), clampedTip, yBack - halfH, true)
      );
      replaceMeshGeometry(
        tree.backCutParts.topFace,
        buildCylindricalBackFace(rAtY(yBack + halfH), clampedTip, yBack + halfH, false)
      );
      replaceMeshGeometry(
        tree.backCutParts.hingeWall,
        buildBackHingeWall(clampedTip, yBack - halfH, yBack + halfH, zHalf)
      );
    }
  }
}

/**
 * Recomputes a tree's effective lean vector dynamically based on its base trunk lean
 * plus the remaining unpruned branches' asymmetric weight.
 * Pruning heavy branches on the lean side visibly stabilizes the tree!
 */
export function recomputeTreeLean(tree: TreeRuntime): void {
  // Pruning overhanging hazard limbs genuinely relieves a major portion of the tree's lean,
  // while severe storm/coastal wind-lean contracts still retain trunk lean + wind pull.
  const totalTargets = tree.spec.hazardBranches;
  const remainingTargets = tree.branches.filter((b) => b.isTarget && !b.pruned).length;
  const targetRemainingFrac = totalTargets > 0 ? remainingTargets / totalTargets : 1;
  const heightRatio = Math.max(0.35, Math.min(1, tree.currentHeight / Math.max(1, tree.spec.height)));
  const baseLeanMag =
    tree.spec.leanStrength * (0.24 + 0.34 * targetRemainingFrac) * (0.58 + 0.42 * heightRatio);
  const vx = Math.cos(tree.spec.leanAngle) * baseLeanMag;
  const vz = Math.sin(tree.spec.leanAngle) * baseLeanMag;

  let bx = 0;
  let bz = 0;
  for (const b of tree.branches) {
    if (!b.pruned) {
      bx += b.worldDirection.x * b.weight;
      bz += b.worldDirection.z * b.weight;
    }
  }

  // Clamp branch contribution so total lean stays realistic and responsive
  const bLen = Math.hypot(bx, bz);
  const maxBranchShift = Math.max(0.28, tree.spec.leanStrength * 0.65);
  if (bLen > maxBranchShift) {
    bx = (bx / bLen) * maxBranchShift;
    bz = (bz / bLen) * maxBranchShift;
  }

  tree.currentLeanVec.set(vx + bx, vz + bz);
}
