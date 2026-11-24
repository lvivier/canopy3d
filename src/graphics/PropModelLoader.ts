import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import type { GraphicsQuality } from '../types';

export type PropModelId = 'truck';

interface MaterialOverrideRule {
  /** Regex matched against material.name (case-insensitive) */
  match: RegExp;
  color?: string;
  roughness?: number;
  metalness?: number;
  clearcoat?: number;
  clearcoatRoughness?: number;
  opacity?: number;
  transparent?: boolean;
  envMapIntensity?: number;
}

interface PropModelConfig {
  id: PropModelId;
  lod0Url: string;
  lod1Url?: string;
  /** Target real-world footprint length along Z (meters) for uniform auto-scaling */
  targetLength?: number;
  /** Target real-world footprint width along X (meters) if targetLength is omitted */
  targetWidth?: number;
  /** Target real-world height along Y (meters) if length & width are omitted */
  targetHeight?: number;
  /** Extra yaw rotation (radians) to align model forward with Canopy 3D (+Z) */
  rotationY?: number;
  /** Global IBL reflection strength multiplier for PBR materials */
  envMapIntensity?: number;
  /** Optional per-material visual polish (e.g. PNW Forestry Service paint, automotive glass) */
  materialOverrides?: MaterialOverrideRule[];
}

/**
 * Central registry for photorealistic GLB background props.
 * Adding a new background object (car, cabin, aframe, barn, shed, gazebo, utility pole, etc.)
 * only requires adding its normalized GLB under public/assets/models/<id>/ and adding an entry here.
 */
const PROP_MODEL_REGISTRY: Record<PropModelId, PropModelConfig> = {
  truck: {
    id: 'truck',
    // High-detail lod0 (~37k tris) is omitted for now. Every quality level uses lod1 (~10k tris).
    lod0Url: '/assets/models/truck/lod1.glb',
    targetLength: 5.15,
    rotationY: Math.PI, // Align grille/headlights to +Z matching procedural pickup orientation
    envMapIntensity: 0.92,
    materialOverrides: [
      {
        // Classic Pacific Northwest Forestry Service dark pine-green metallic paint (body + tailgate, excludes rim_paint)
        match: /^paint(_body|$)/i,
        color: '#284a39',
        roughness: 0.26,
        metalness: 0.34,
        clearcoat: 0.82,
        clearcoatRoughness: 0.14,
        envMapIntensity: 1.15,
      },
      {
        // Realistic tinted automotive glass with crisp sky reflections
        match: /^glass/i,
        color: '#1c2b33',
        roughness: 0.08,
        metalness: 0.18,
        opacity: 0.82,
        transparent: true,
        envMapIntensity: 1.35,
      },
      {
        // Textured dark-charcoal bedliner & rugged rubber wheel flares
        match: /bedliner|trim_matte|tire|tyre/i,
        roughness: 0.88,
        metalness: 0.04,
      },
    ],
  },
};

let sharedLoader: GLTFLoader | null = null;
let sharedKtx2: KTX2Loader | null = null;
let sharedDraco: DRACOLoader | null = null;

/** Cache of normalized prototype scenes keyed by `${propId}:${lod}` */
const prototypePromises = new Map<string, Promise<THREE.Group | null>>();

/**
 * Initializes the shared GLTF + KTX2 (Basis) + Draco + Meshopt loader once with the active WebGLRenderer.
 */
export function initPropModelLoader(renderer: THREE.WebGLRenderer): void {
  if (!sharedLoader) {
    sharedLoader = new GLTFLoader();
    sharedDraco = new DRACOLoader();
    sharedDraco.setDecoderPath('/assets/decoders/draco/');
    sharedLoader.setDRACOLoader(sharedDraco);
    sharedLoader.setMeshoptDecoder(MeshoptDecoder);
  }
  if (!sharedKtx2) {
    sharedKtx2 = new KTX2Loader();
    sharedKtx2.setTranscoderPath('/assets/decoders/basis/');
    sharedKtx2.detectSupport(renderer);
    sharedLoader.setKTX2Loader(sharedKtx2);
  }
}

function getLoader(): GLTFLoader {
  if (!sharedLoader) {
    sharedLoader = new GLTFLoader();
    sharedDraco = new DRACOLoader();
    sharedDraco.setDecoderPath('/assets/decoders/draco/');
    sharedLoader.setDRACOLoader(sharedDraco);
    sharedLoader.setMeshoptDecoder(MeshoptDecoder);
  }
  return sharedLoader;
}

function polishMaterial(
  srcMat: THREE.Material,
  cfg: PropModelConfig,
  paintColorOverride?: string
): THREE.Material {
  const mat = srcMat.clone();
  const std = mat as THREE.MeshStandardMaterial & {
    clearcoat?: number;
    clearcoatRoughness?: number;
    transmission?: number;
  };

  if (typeof std.envMapIntensity === 'number' && cfg.envMapIntensity !== undefined) {
    std.envMapIntensity = cfg.envMapIntensity;
  }

  // Disable expensive multi-pass transmission on distant background props (uses crisp tinted glass instead)
  if (typeof std.transmission === 'number' && std.transmission > 0) {
    std.transmission = 0;
  }

  if (cfg.materialOverrides) {
    const name = mat.name || '';
    for (const rule of cfg.materialOverrides) {
      if (!rule.match.test(name)) continue;
      const chosenColor =
        paintColorOverride && /paint/i.test(name) ? paintColorOverride : rule.color;
      if (chosenColor && std.color) {
        std.color.set(chosenColor);
      }
      if (rule.roughness !== undefined && typeof std.roughness === 'number') {
        std.roughness = rule.roughness;
      }
      if (rule.metalness !== undefined && typeof std.metalness === 'number') {
        std.metalness = rule.metalness;
      }
      if (rule.clearcoat !== undefined && typeof std.clearcoat === 'number') {
        std.clearcoat = rule.clearcoat;
      }
      if (rule.clearcoatRoughness !== undefined && typeof std.clearcoatRoughness === 'number') {
        std.clearcoatRoughness = rule.clearcoatRoughness;
      }
      if (rule.opacity !== undefined) {
        std.opacity = rule.opacity;
      }
      if (rule.transparent !== undefined) {
        std.transparent = rule.transparent;
      }
      if (rule.envMapIntensity !== undefined && typeof std.envMapIntensity === 'number') {
        std.envMapIntensity = rule.envMapIntensity;
      }
    }
  }

  mat.needsUpdate = true;
  return mat;
}

function loadNormalizedPrototype(
  propId: PropModelId,
  quality: GraphicsQuality
): Promise<THREE.Group | null> {
  const cfg = PROP_MODEL_REGISTRY[propId];
  const useLod1 = quality !== 'high' && Boolean(cfg.lod1Url);
  const url = useLod1 && cfg.lod1Url ? cfg.lod1Url : cfg.lod0Url;
  const cacheKey = `${propId}:${useLod1 ? 'lod1' : 'lod0'}`;

  const existing = prototypePromises.get(cacheKey);
  if (existing) return existing;

  const promise = new Promise<THREE.Group | null>((resolve) => {
    getLoader().load(
      url,
      (gltf) => {
        const wrapper = new THREE.Group();
        wrapper.name = `prop-proto-${propId}`;

        const inner = gltf.scene;
        if (cfg.rotationY) {
          inner.rotation.y = cfg.rotationY;
        }
        inner.updateMatrixWorld(true);

        // Compute world bounds, scale uniformly to target real-world footprint, center XZ, ground minY = 0
        const rawBox = new THREE.Box3().setFromObject(inner);
        const rawSize = new THREE.Vector3();
        rawBox.getSize(rawSize);

        let scale = 1.0;
        if (cfg.targetLength && rawSize.z > 1e-4) {
          scale = cfg.targetLength / rawSize.z;
        } else if (cfg.targetWidth && rawSize.x > 1e-4) {
          scale = cfg.targetWidth / rawSize.x;
        } else if (cfg.targetHeight && rawSize.y > 1e-4) {
          scale = cfg.targetHeight / rawSize.y;
        }

        inner.scale.multiplyScalar(scale);
        inner.updateMatrixWorld(true);

        const scaledBox = new THREE.Box3().setFromObject(inner);
        const scaledCenter = new THREE.Vector3();
        scaledBox.getCenter(scaledCenter);

        inner.position.x -= scaledCenter.x;
        inner.position.z -= scaledCenter.z;
        inner.position.y -= scaledBox.min.y;
        inner.updateMatrixWorld(true);

        inner.traverse((obj) => {
          const mesh = obj as THREE.Mesh;
          if (!mesh.isMesh) return;
          mesh.castShadow = true;
          mesh.receiveShadow = true;
        });

        wrapper.add(inner);
        resolve(wrapper);
      },
      undefined,
      (err) => {
        console.warn(`[PropModelLoader] Failed to load ${propId} (${url}), keeping procedural fallback:`, err);
        resolve(null);
      }
    );
  });

  prototypePromises.set(cacheKey, promise);
  return promise;
}

export interface AttachPropModelOptions {
  /** Optional body paint color override for per-contract vehicle variety */
  paintColor?: string;
}

/**
 * Upgrades a procedural hazard/prop Group asynchronously to its photorealistic GLB model.
 * Keeps existing procedural children visible as an instant zero-pop-in fallback until the GLB loads,
 * then swaps cleanly without allocating duplicate geometry buffers across instances.
 */
export function attachPropModel(
  container: THREE.Group,
  propId: PropModelId,
  quality: GraphicsQuality,
  opts?: AttachPropModelOptions
): void {
  const cfg = PROP_MODEL_REGISTRY[propId];
  if (!cfg) return;

  // Snapshot existing procedural fallback meshes so we can hide/dispose them cleanly once GLB is ready
  const fallbackChildren = [...container.children];

  loadNormalizedPrototype(propId, quality).then((proto) => {
    if (!proto) return;

    const instance = proto.clone(true);
    // Apply cloned/polished materials per instance (keeps shared GPU BufferGeometries & Textures!)
    const matCache = new Map<THREE.Material, THREE.Material>();
    instance.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh || !mesh.material) return;
      if (Array.isArray(mesh.material)) {
        mesh.material = mesh.material.map((m) => {
          let p = matCache.get(m);
          if (!p) {
            p = polishMaterial(m, cfg, opts?.paintColor);
            matCache.set(m, p);
          }
          return p;
        });
      } else {
        let p = matCache.get(mesh.material);
        if (!p) {
          p = polishMaterial(mesh.material, cfg, opts?.paintColor);
          matCache.set(mesh.material, p);
        }
        mesh.material = p;
      }
    });

    // Swap out procedural fallback meshes
    for (const child of fallbackChildren) {
      container.remove(child);
    }
    container.add(instance);
  });
}
