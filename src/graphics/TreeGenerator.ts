import * as THREE from 'three';
import {
  BranchData,
  BuckRingData,
  LogSegmentData,
  SpeciesSpec,
  StandingTopCutData,
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

  return group;
}

export function buildTreeRuntime(spec: TreePlacementSpec): TreeRuntime {
  const speciesSpec = PNW_SPECIES[spec.species];
  const rand = makeRng(spec.seed);
  const barkSet = textureCache.getBarkTextures(spec.species);

  const rootGroup = new THREE.Group();
  rootGroup.position.set(spec.x, 0, spec.z);

  const baseRadius = Math.max(0.22, spec.height * speciesSpec.radiusRatio);
  const cutHeight =
    spec.height < 11
      ? Math.max(0.58, spec.height * 0.075)
      : Math.min(1.15, Math.max(0.85, spec.height * 0.055));

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
    32,
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

  // Stump top end-grain cap (seamless flush CircleGeometry — zero Z-fighting!)
  const stumpCapGeo = new THREE.CircleGeometry(baseRadius * 0.95, 32);
  stumpCapGeo.rotateX(-Math.PI / 2);
  const stumpCap = new THREE.Mesh(stumpCapGeo, endGrainMat);
  stumpCap.position.y = cutHeight;
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

  const getTrunkCenterAt = (localY: number): THREE.Vector3 => {
    const t = Math.max(0, Math.min(1, localY / upperHeight));
    const cp = Math.pow(t, 1.35);
    let dx = leanX * cp + Math.sin(t * Math.PI * 2.2) * baseRadius * 0.12;
    const dz = leanZ * cp + (Math.cos(t * Math.PI * 1.7) - 1) * baseRadius * 0.12;
    if (speciesSpec.droopingLeader && t > 0.87) {
      const tipT = (t - 0.87) / 0.13;
      dx += Math.pow(tipT, 2) * 1.15;
    }
    return new THREE.Vector3(dx, localY, dz);
  };

  const getTrunkRadiusAt = (localY: number): number => {
    const t = Math.max(0, Math.min(1, localY / upperHeight));
    return THREE.MathUtils.lerp(baseRadius * 0.95, trunkTopRadius, t);
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

    const radialSegs = sIdx === 0 ? 32 : 16;
    const segHeightSegs = Math.max(4, Math.round((segLen / upperHeight) * 16));
    const segGeo = new THREE.CylinderGeometry(rEnd, rStart, segLen, radialSegs, segHeightSegs, true);
    const pos = segGeo.attributes.position;
    const uv = segGeo.attributes.uv;
    for (let vIdx = 0; vIdx < pos.count; vIdx++) {
      const vx = pos.getX(vIdx);
      const vy = pos.getY(vIdx); // -segLen/2 .. +segLen/2
      const vz = pos.getZ(vIdx);
      const globalY = midY + vy;
      const c = getTrunkCenterAt(globalY);
      pos.setXYZ(vIdx, vx + (c.x - midCenter.x), vy, vz + (c.z - midCenter.z));
      // Keep bark V texture coordinate continuous seamlessly across segment boundaries!
      uv.setY(vIdx, globalY / upperHeight);
    }
    segGeo.computeVertexNormals();

    const segBarkMat = sIdx === 0 ? barkMat.clone() : barkMat;
    const segBarkMesh = new THREE.Mesh(segGeo, segBarkMat);
    segBarkMesh.castShadow = true;
    segBarkMesh.receiveShadow = true;
    segBarkMesh.userData = { treeId: spec.id, part: 'trunk' };
    segGroup.add(segBarkMesh);

    const startCenter = getTrunkCenterAt(yStart);
    const endCenter = getTrunkCenterAt(yEnd);

    // Bottom end-grain cross-section cap (visible on butt log immediately; revealed on cut for upper logs!)
    const bottomCapGeo = new THREE.CircleGeometry(rStart, radialSegs);
    bottomCapGeo.rotateX(Math.PI / 2);
    const bottomCap = new THREE.Mesh(bottomCapGeo, endGrainMat);
    bottomCap.position.set(startCenter.x - midCenter.x, yStart - midCenter.y, startCenter.z - midCenter.z);
    bottomCap.visible = sIdx === 0;
    segGroup.add(bottomCap);

    // Top end-grain cross-section cap (revealed when this segment's upper bucking cut is sliced!)
    const topCapGeo = new THREE.CircleGeometry(rEnd, radialSegs);
    topCapGeo.rotateX(-Math.PI / 2);
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
  applyTrunkCutDiscardShader(
    segments[0].barkMesh.material as THREE.MeshStandardMaterial,
    cutShaderUniforms
  );

  // 3. Humboldt Face Notch (2 clean cylindrical-segment wood faces: flat horizontal ceiling + 47° sloped floor)
  const notchCutoutGroup = new THREE.Group();
  notchCutoutGroup.position.set(cutCenterXZ.x, 0, cutCenterXZ.y);
  notchCutoutGroup.visible = false;

  const notchCeilingMat = new THREE.MeshStandardMaterial({
    map: barkSet.endGrainMap,
    color: '#b5906a',
    roughness: 0.85,
    metalness: 0.02,
    vertexColors: true,
  });
  const notchFloorMat = new THREE.MeshStandardMaterial({
    map: barkSet.endGrainMap,
    color: '#f2dec0',
    roughness: 0.68,
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
    spec.species === 'bigleaf_maple' ||
    spec.species === 'weeping_willow' ||
    spec.species === 'garry_oak' ||
    spec.species === 'arbutus'
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
    const heightFrac =
      speciesSpec.category === 'deciduous'
        ? 0.28 + (i / totalInteractiveBranches) * 0.44 + (rand() - 0.5) * 0.04
        : 0.18 + (i / totalInteractiveBranches) * 0.46 + (rand() - 0.5) * 0.035;

    const minAttachY = spec.height < 11 ? 1.2 : 2.0;
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
    } else {
      angle = i * 2.39996 + rand() * 0.65; // golden angle spiral for natural spacing
    }

    const dirX = Math.cos(angle);
    const dirZ = Math.sin(angle);

    // Branch length & pitch per species
    const sizeFactor = 1.0 - (heightFrac - 0.18) * 0.62;
    const widthSpread =
      spec.species === 'garry_oak'
        ? 4.9
        : spec.species === 'weeping_willow'
          ? 4.4
          : spec.species === 'arbutus'
            ? 4.3
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
      (isTarget ? 1.18 : 0.92 + rand() * 0.25);

    const bRadius = Math.max(0.065, localTrunkR * (isTarget ? 0.42 : 0.34));

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
    else if (spec.species === 'smoke_tree') pitch = 0.34 + rand() * 0.2;
    else if (spec.species === 'white_poplar') pitch = 0.44 + rand() * 0.22;
    else if (spec.species === 'garry_oak') pitch = 0.2 + rand() * 0.18;
    else if (spec.species === 'arbutus') pitch = 0.28 + rand() * 0.24;
    else if (spec.species === 'rhododendron') pitch = 0.36 + rand() * 0.22;
    else if (spec.species === 'chokecherry') pitch = 0.4 + rand() * 0.2;
    else if (spec.species === 'trembling_aspen') pitch = 0.46 + rand() * 0.2;
    else if (spec.species === 'eucalyptus') pitch = 0.38 + rand() * 0.22;
    else if (spec.species === 'california_redwood') pitch = -0.1;
    else if (spec.species === 'ponderosa_pine') pitch = 0.08 + rand() * 0.14;
    else if (spec.species === 'western_larch') pitch = -0.06 + rand() * 0.1;
    else if (spec.species === 'blue_spruce') pitch = -0.08;
    else if (spec.species === 'western_white_pine') pitch = 0.04 + rand() * 0.08;
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

    // Secondary limb bend (J-curve swoop upward for Cedar, cascading droop for Weeping Willow, tiered for Japanese Maple)
    const seg2Pitch =
      spec.species === 'western_red_cedar'
        ? pitch + 0.34
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
      const y = upperHeight * f;
      const center = getTrunkCenterAt(y);
      const crownWidth = spec.species === 'california_redwood' ? 0.205 : 0.24;
      const crownRadius = (1 - (f - 0.15) / 0.88) * (spec.height * crownWidth) + 0.55;
      const boughsInTier = f > 0.88 ? 3 : 5;

      if (y <= groundLimbCutoffY) {
        const band = y - crownStartY < crownZoneSpan * 0.5 ? 0 : 1;
        for (let b = 0; b < boughsInTier; b++) {
          const a = (b / boughsInTier) * Math.PI * 2 + tIdx * 1.15 + rand() * 0.3;
          const reach = crownRadius * (0.72 + rand() * 0.32);
          const pad = createFoliageCluster(speciesSpec, Math.max(0.7, reach * 0.52), rand, false);
          pad.position.set(
            center.x + Math.cos(a) * reach * 0.65,
            y - (spec.species === 'western_red_cedar' ? 0.35 : 0.1),
            center.z + Math.sin(a) * reach * 0.65
          );
          const side = Math.cos(a - band * 1.1) >= 0 ? 0 : 1;
          const bucket = crownSectionBuckets[band * 2 + side];
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
          const pad = createFoliageCluster(speciesSpec, Math.max(0.7, reach * 0.52), rand, false);
          pad.position.set(
            center.x + Math.cos(a) * reach * 0.65 - tierSeg.group.position.x,
            y - (spec.species === 'western_red_cedar' ? 0.35 : 0.1) - tierSeg.group.position.y,
            center.z + Math.sin(a) * reach * 0.65 - tierSeg.group.position.z
          );
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
    const spire = createFoliageCluster(speciesSpec, 1.05, rand, false);
    spire.position.set(
      topCenter.x + (speciesSpec.droopingLeader ? 0.95 : 0),
      upperHeight - 0.2,
      topCenter.z
    );
    upperCrownGroup.add(spire);
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
      const cluster = createFoliageCluster(speciesSpec, folScale, rand, false);

      if (py <= groundLimbCutoffY + 1.0) {
        const boughGroup = new THREE.Group();
        boughGroup.position.set(px, py, pz);
        boughGroup.add(cluster);

        const outDir = new THREE.Vector3(px - domeCenter.x, 0, pz - domeCenter.z).normalize();
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
        cluster.position.set(
          px - upperSeg.group.position.x,
          py - upperSeg.group.position.y,
          pz - upperSeg.group.position.z
        );
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
