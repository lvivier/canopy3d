import * as THREE from 'three';
import {
  BranchData,
  BuckRingData,
  SpeciesSpec,
  TreePlacementSpec,
  TreeRuntime,
} from '../types';
import { PNW_SPECIES } from '../data/species';
import { textureCache } from './ProceduralTextures';

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
    false
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

    // Subtle trunk organic wobble + natural lean curve
    const curvePower = Math.pow(t, 1.35);
    x += leanX * curvePower + Math.sin(t * Math.PI * 2.2) * bottomRadius * 0.12;
    z += leanZ * curvePower + Math.cos(t * Math.PI * 1.7) * bottomRadius * 0.12;

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

function createFoliageCluster(
  spec: SpeciesSpec,
  scale: number,
  rand: () => number,
  isDeadwood: boolean
): THREE.Group {
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
  } else {
    // Deciduous: Bigleaf Maple / Red Alder lush sunlit leaf canopies
    const puffCount = isDeadwood ? 2 : 4 + Math.floor(rand() * 3);
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
        roughness: 0.78,
        metalness: 0.03,
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

  return group;
}

export function buildTreeRuntime(spec: TreePlacementSpec): TreeRuntime {
  const speciesSpec = PNW_SPECIES[spec.species];
  const rand = makeRng(spec.seed);
  const barkSet = textureCache.getBarkTextures(spec.species);

  const rootGroup = new THREE.Group();
  rootGroup.position.set(spec.x, 0, spec.z);

  const baseRadius = Math.max(0.28, spec.height * speciesSpec.radiusRatio);
  const cutHeight = Math.min(1.15, Math.max(0.85, spec.height * 0.055));

  const barkMat = new THREE.MeshStandardMaterial({
    map: barkSet.map,
    bumpMap: barkSet.bumpMap,
    bumpScale: 0.07,
    roughness: 0.92,
    metalness: 0.02,
  });

  const endGrainMat = new THREE.MeshStandardMaterial({
    map: barkSet.endGrainMap,
    roughness: 0.75,
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
    baseRadius * 1.06,
    baseRadius * 0.95,
    cutHeight,
    16,
    5,
    speciesSpec.buttressFlare,
    0,
    0,
    false
  );
  const stumpMesh = new THREE.Mesh(stumpGeo, barkMat);
  stumpMesh.castShadow = true;
  stumpMesh.receiveShadow = true;
  stumpMesh.userData = { treeId: spec.id, part: 'stump' };
  stumpGroup.add(stumpMesh);

  // Stump top end-grain cap (visible once tree starts tipping)
  const stumpCapGeo = new THREE.CylinderGeometry(baseRadius * 0.94, baseRadius * 0.94, 0.04, 16);
  const stumpCap = new THREE.Mesh(stumpCapGeo, endGrainMat);
  stumpCap.position.y = cutHeight - 0.01;
  stumpCap.receiveShadow = true;
  stumpGroup.add(stumpCap);

  rootGroup.add(stumpGroup);

  // 2. Trunk Pivot (starts at cutHeight; hinges around XZ axis during felling!)
  const trunkPivot = new THREE.Group();
  trunkPivot.position.y = cutHeight;
  rootGroup.add(trunkPivot);

  const upperHeight = spec.height - cutHeight;
  const leanDist = spec.leanStrength * spec.height * 0.09;
  const leanX = Math.cos(spec.leanAngle) * leanDist;
  const leanZ = Math.sin(spec.leanAngle) * leanDist;

  const trunkTopRadius =
    speciesSpec.category === 'deciduous' ? baseRadius * 0.24 : baseRadius * 0.08;
  const trunkGeo = buildFlutedTrunkGeometry(
    baseRadius * 0.95,
    trunkTopRadius,
    upperHeight,
    14,
    14,
    1.0,
    leanX,
    leanZ,
    Boolean(speciesSpec.droopingLeader)
  );
  const trunkMesh = new THREE.Mesh(trunkGeo, barkMat);
  trunkMesh.castShadow = true;
  trunkMesh.receiveShadow = true;
  trunkMesh.userData = { treeId: spec.id, part: 'trunk' };
  trunkPivot.add(trunkMesh);

  // Bottom end-grain cap on falling trunk
  const trunkBottomCap = new THREE.Mesh(
    new THREE.CylinderGeometry(baseRadius * 0.93, baseRadius * 0.93, 0.04, 14),
    endGrainMat
  );
  trunkBottomCap.position.y = 0.02;
  trunkPivot.add(trunkBottomCap);

  // 3. Dynamic 3D Face Notch Cutout Indicator (scales dynamically as player saws the notch!)
  const notchCutoutGroup = new THREE.Group();
  notchCutoutGroup.position.y = 0.06;
  notchCutoutGroup.visible = false;

  // Dark carved V-cavity + bright fresh heartwood floor/ceiling faces
  const notchDarkMat = new THREE.MeshStandardMaterial({
    color: '#1f120b',
    roughness: 0.95,
  });
  const notchWedgeGeo = new THREE.BoxGeometry(baseRadius * 1.15, baseRadius * 0.72, baseRadius * 1.85);
  const notchCavity = new THREE.Mesh(notchWedgeGeo, notchDarkMat);
  notchCavity.position.set(baseRadius * 0.56, 0.12, 0);
  notchCutoutGroup.add(notchCavity);

  const notchFloor = new THREE.Mesh(
    new THREE.BoxGeometry(baseRadius * 1.18, 0.07, baseRadius * 1.9),
    freshWoodMat
  );
  notchFloor.position.set(baseRadius * 0.55, -0.14, 0);
  notchCutoutGroup.add(notchFloor);

  const notchSlope = new THREE.Mesh(
    new THREE.BoxGeometry(baseRadius * 1.24, 0.07, baseRadius * 1.9),
    freshWoodMat
  );
  notchSlope.position.set(baseRadius * 0.56, 0.24, 0);
  notchSlope.rotation.z = -0.58;
  notchCutoutGroup.add(notchSlope);

  trunkPivot.add(notchCutoutGroup);

  // 4. Back Cut Kerf Slot (visible on opposite side of trunk as player saws back cut)
  const backCutGeo = new THREE.BoxGeometry(baseRadius * 1.25, 0.11, baseRadius * 1.92);
  const backCutMesh = new THREE.Mesh(
    backCutGeo,
    new THREE.MeshStandardMaterial({
      color: '#f2b866',
      emissive: '#3d220a',
      emissiveIntensity: 0.4,
      roughness: 0.65,
    })
  );
  backCutMesh.position.set(-baseRadius * 0.55, 0.14, 0);
  backCutMesh.visible = false;
  trunkPivot.add(backCutMesh);

  // 5. Felling Wedges (3 high-vis forestry orange wedges tucked into the back cut!)
  const wedgeMeshes: THREE.Mesh[] = [];
  const wedgeMat = new THREE.MeshStandardMaterial({
    color: '#f97316',
    roughness: 0.45,
    metalness: 0.15,
  });
  for (let w = 0; w < 3; w++) {
    const wGeo = new THREE.BoxGeometry(baseRadius * 0.72, 0.14, 0.18);
    const wMesh = new THREE.Mesh(wGeo, wedgeMat);
    const zOff = (w - 1) * baseRadius * 0.55;
    wMesh.position.set(-baseRadius * 1.08, 0.14, zOff);
    wMesh.rotation.z = 0.12;
    wMesh.visible = false;
    wMesh.castShadow = true;
    trunkPivot.add(wMesh);
    wedgeMeshes.push(wMesh);
  }

  // 6. Generate Realistic Branches (Interactive Prunable Lower/Mid Branches + Crown Foliage)
  const branches: BranchData[] = [];

  const getTrunkCenterAt = (localY: number): THREE.Vector3 => {
    const t = Math.max(0, Math.min(1, localY / upperHeight));
    const cp = Math.pow(t, 1.35);
    return new THREE.Vector3(
      leanX * cp + Math.sin(t * Math.PI * 2.2) * baseRadius * 0.12,
      localY,
      leanZ * cp + Math.cos(t * Math.PI * 1.7) * baseRadius * 0.12
    );
  };

  const getTrunkRadiusAt = (localY: number): number => {
    const t = Math.max(0, Math.min(1, localY / upperHeight));
    return THREE.MathUtils.lerp(baseRadius * 0.95, trunkTopRadius, t);
  };

  const totalInteractiveBranches =
    spec.species === 'bigleaf_maple'
      ? Math.max(10, spec.hazardBranches + 5)
      : spec.species === 'red_alder'
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
    const heightFrac =
      speciesSpec.category === 'deciduous'
        ? 0.28 + (i / totalInteractiveBranches) * 0.44 + (rand() - 0.5) * 0.04
        : 0.18 + (i / totalInteractiveBranches) * 0.46 + (rand() - 0.5) * 0.035;

    const attachY = Math.max(2.0, upperHeight * Math.min(0.76, heightFrac));
    const attachCenter = getTrunkCenterAt(attachY);
    const localTrunkR = getTrunkRadiusAt(attachY);

    // Direction around trunk: bias target branches toward hazardBranchAngle if provided
    let angle: number;
    if (isTarget && spec.hazardBranchAngle !== undefined) {
      const spread = (i - (spec.hazardBranches - 1) / 2) * 0.48 + (rand() - 0.5) * 0.24;
      angle = spec.hazardBranchAngle + spread;
    } else {
      angle = i * 2.39996 + rand() * 0.65; // golden angle spiral for natural spacing
    }

    const dirX = Math.cos(angle);
    const dirZ = Math.sin(angle);

    // Branch length & pitch per species
    const sizeFactor = 1.0 - (heightFrac - 0.18) * 0.62;
    const bLength =
      (speciesSpec.category === 'deciduous' ? 3.8 : 3.2) *
      Math.max(0.55, sizeFactor) *
      (spec.height / 18) *
      (isTarget ? 1.18 : 0.92 + rand() * 0.25);

    const bRadius = Math.max(0.08, localTrunkR * (isTarget ? 0.42 : 0.34));

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

    // Secondary limb bend (J-curve swoop upward for Cedar, outward fork for Maple, gentle droop for Hemlock)
    const seg2Pitch =
      spec.species === 'western_red_cedar'
        ? pitch + 0.34
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

    const isDeadwoodVisual = isTarget && (i % 2 === 0 || spec.task === 'prune_only');
    const folScale = (speciesSpec.category === 'deciduous' ? 1.55 : 1.25) * (bLength / 3.2);

    const midFol = createFoliageCluster(speciesSpec, folScale * 0.78, rand, isDeadwoodVisual);
    midFol.position.set(tip1X * 0.85, tip1Y * 0.85 + 0.22, 0);
    branchGroup.add(midFol);

    const tipFol = createFoliageCluster(speciesSpec, folScale, rand, isDeadwoodVisual);
    tipFol.position.set(tip2X, tip2Y + 0.25, 0);
    branchGroup.add(tipFol);

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

    trunkPivot.add(branchGroup);

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

  // 7. Upper Crown Canopy (Non-prunable upper spire / dome so tree looks full & magnificent!)
  const upperCrownGroup = new THREE.Group();
  if (speciesSpec.category === 'conifer') {
    const tiers = Math.floor(spec.height * 0.65);
    const startFrac = 0.52;
    for (let tIdx = 0; tIdx < tiers; tIdx++) {
      const f = startFrac + (tIdx / tiers) * (0.98 - startFrac);
      const y = upperHeight * f;
      const center = getTrunkCenterAt(y);
      const crownRadius = (1 - (f - 0.15) / 0.88) * (spec.height * 0.24) + 0.55;
      const boughsInTier = f > 0.88 ? 3 : 5;
      for (let b = 0; b < boughsInTier; b++) {
        const a = (b / boughsInTier) * Math.PI * 2 + tIdx * 1.15 + rand() * 0.3;
        const reach = crownRadius * (0.72 + rand() * 0.32);
        const pad = createFoliageCluster(speciesSpec, Math.max(0.7, reach * 0.52), rand, false);
        pad.position.set(
          center.x + Math.cos(a) * reach * 0.65,
          y - (spec.species === 'western_red_cedar' ? 0.35 : 0.1),
          center.z + Math.sin(a) * reach * 0.65
        );
        upperCrownGroup.add(pad);
      }
    }
    // Leader crown cap
    const topCenter = getTrunkCenterAt(upperHeight);
    const spire = createFoliageCluster(speciesSpec, 1.05, rand, false);
    spire.position.set(
      topCenter.x + (speciesSpec.droopingLeader ? 0.95 : 0),
      upperHeight - 0.2,
      topCenter.z
    );
    upperCrownGroup.add(spire);
  } else {
    // Deciduous upper dome (Bigleaf Maple / Red Alder)
    const domeCenter = getTrunkCenterAt(upperHeight * 0.86);
    const clusterCount = spec.species === 'bigleaf_maple' ? 14 : 10;
    const domeRadius = spec.species === 'bigleaf_maple' ? spec.height * 0.27 : spec.height * 0.19;
    for (let c = 0; c < clusterCount; c++) {
      const phi = Math.acos(1 - (c + 0.5) / clusterCount) * 0.72;
      const theta = c * 2.39996 + rand() * 0.4;
      const r = domeRadius * (0.62 + rand() * 0.42);
      const px = domeCenter.x + Math.sin(phi) * Math.cos(theta) * r;
      const py = domeCenter.y + Math.cos(phi) * r * 0.72;
      const pz = domeCenter.z + Math.sin(phi) * Math.sin(theta) * r;
      const cluster = createFoliageCluster(
        speciesSpec,
        spec.species === 'bigleaf_maple' ? 2.15 : 1.55,
        rand,
        false
      );
      cluster.position.set(px, py, pz);
      upperCrownGroup.add(cluster);
    }
  }
  trunkPivot.add(upperCrownGroup);

  // 8. Bucking Cut Rings along the trunk (hidden until tree is fallen!)
  const buckRings: BuckRingData[] = [];
  const buckSpacing = 4.2;
  const maxBuckDist = Math.min(upperHeight * 0.68, 16.5);
  let buckIdx = 0;
  for (let d = 3.8; d <= maxBuckDist; d += buckSpacing) {
    const rAtD = getTrunkRadiusAt(d);
    const centerAtD = getTrunkCenterAt(d);
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(rAtD * 1.25, 0.085, 10, 24),
      new THREE.MeshBasicMaterial({
        color: '#facc15',
        transparent: true,
        opacity: 0.9,
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
    buckIdx++;
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

  const initialAim = spec.dropZone ? spec.dropZone.angle : spec.leanAngle;

  const runtime: TreeRuntime = {
    spec,
    speciesSpec,
    rootGroup,
    stumpGroup,
    trunkPivot,
    trunkMesh,
    notchCutoutGroup,
    backCutMesh,
    wedgeMeshes,
    branches,
    buckRings,
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
    buckedCount: 0,
    totalBuckCuts: buckRings.length,
    completed: false,
    selectionRing,
  };

  recomputeTreeLean(runtime);
  return runtime;
}

/**
 * Recomputes a tree's effective lean vector dynamically based on its base trunk lean
 * plus the remaining unpruned branches' asymmetric weight.
 * Pruning heavy branches on the lean side visibly stabilizes the tree!
 */
export function recomputeTreeLean(tree: TreeRuntime): void {
  const baseLeanMag = tree.spec.leanStrength * 0.52;
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
