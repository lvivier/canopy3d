import * as THREE from 'three';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import { GraphicsQuality, SiteId, SpeciesId, WeatherId } from '../types';

export type PbrTextureId =
  | 'pine_bark'
  | 'japanese_cedar_bark'
  | 'tree_bark_03'
  | 'bark_willow'
  | 'bark_brown_01'
  | 'sitka_spruce_bark'
  | 'arbutus_bark'
  | 'ponderosa_pine_bark'
  | 'aspen_bark'
  | 'windmill_palm_bark'
  | 'giant_sequoia_bark'
  | 'yellow_cedar_bark'
  | 'sawn_end_grain'
  | 'leaves_forest_ground'
  | 'grass_path_3'
  | 'brown_mud_leaves_01'
  | 'mossy_rock'
  | 'wood_planks'
  | 'gravel_road';

export interface PbrMaterialMaps {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  armMap: THREE.Texture; // R = AO, G = Roughness, B = Metalness
}

export interface SpeciesBarkProfile {
  textureId: PbrTextureId;
  tint: string;
  normalScale: number;
  roughness: number;
  aoIntensity: number;
  /** Real-world height (meters) covered by one vertical tile */
  metersPerTileV: number;
  /** Base mossiness affinity (0..1), boosted on humid coastal sites */
  mossAffinity: number;
  /** Subtle wet sheen boost (e.g. smooth arbutus/alder/cherry gleam faster in rain) */
  wetSheen: number;
}

export const SPECIES_BARK_PROFILES: Record<SpeciesId, SpeciesBarkProfile> = {
  douglas_fir: {
    textureId: 'pine_bark',
    tint: '#e8d0be',
    normalScale: 1.45,
    roughness: 0.94,
    aoIntensity: 0.78,
    metersPerTileV: 2.2,
    mossAffinity: 0.42,
    wetSheen: 0.6,
  },
  western_red_cedar: {
    textureId: 'japanese_cedar_bark',
    tint: '#e6c0ab',
    normalScale: 1.35,
    roughness: 0.92,
    aoIntensity: 0.75,
    metersPerTileV: 2.0,
    mossAffinity: 0.48,
    wetSheen: 0.55,
  },
  yellow_cedar: {
    textureId: 'yellow_cedar_bark',
    tint: '#f2efe8',
    normalScale: 1.38,
    roughness: 0.93,
    aoIntensity: 0.72,
    metersPerTileV: 1.85,
    mossAffinity: 0.52,
    wetSheen: 0.5,
  },
  sitka_spruce: {
    textureId: 'sitka_spruce_bark',
    tint: '#f3edef',
    normalScale: 1.3,
    roughness: 0.9,
    aoIntensity: 0.72,
    metersPerTileV: 1.8,
    mossAffinity: 0.5,
    wetSheen: 0.65,
  },
  bigleaf_maple: {
    textureId: 'tree_bark_03',
    tint: '#cdd8bf',
    normalScale: 1.3,
    roughness: 0.93,
    aoIntensity: 0.8,
    metersPerTileV: 1.6,
    mossAffinity: 0.85,
    wetSheen: 0.55,
  },
  red_alder: {
    textureId: 'bark_willow',
    tint: '#dce4dc',
    normalScale: 0.65,
    roughness: 0.84,
    aoIntensity: 0.55,
    metersPerTileV: 1.5,
    mossAffinity: 0.52,
    wetSheen: 0.82,
  },
  western_hemlock: {
    textureId: 'pine_bark',
    tint: '#d6b6a8',
    normalScale: 1.2,
    roughness: 0.92,
    aoIntensity: 0.74,
    metersPerTileV: 2.0,
    mossAffinity: 0.55,
    wetSheen: 0.62,
  },
  weeping_willow: {
    textureId: 'bark_willow',
    tint: '#d8cec0',
    normalScale: 1.3,
    roughness: 0.92,
    aoIntensity: 0.76,
    metersPerTileV: 1.6,
    mossAffinity: 0.45,
    wetSheen: 0.6,
  },
  japanese_maple: {
    textureId: 'bark_willow',
    tint: '#cbbab2',
    normalScale: 0.55,
    roughness: 0.8,
    aoIntensity: 0.5,
    metersPerTileV: 1.2,
    mossAffinity: 0.25,
    wetSheen: 0.85,
  },
  lilac: {
    textureId: 'japanese_cedar_bark',
    tint: '#d2cabf',
    normalScale: 0.95,
    roughness: 0.9,
    aoIntensity: 0.65,
    metersPerTileV: 1.3,
    mossAffinity: 0.25,
    wetSheen: 0.6,
  },
  smoke_tree: {
    textureId: 'sitka_spruce_bark',
    tint: '#d3c5c2',
    normalScale: 1.0,
    roughness: 0.88,
    aoIntensity: 0.66,
    metersPerTileV: 1.3,
    mossAffinity: 0.22,
    wetSheen: 0.62,
  },
  white_poplar: {
    textureId: 'aspen_bark',
    tint: '#f3f5f0',
    normalScale: 0.9,
    roughness: 0.84,
    aoIntensity: 0.62,
    metersPerTileV: 1.6,
    mossAffinity: 0.18,
    wetSheen: 0.75,
  },
  arbutus: {
    textureId: 'arbutus_bark',
    tint: '#e6d8cc',
    normalScale: 1.15,
    roughness: 0.72,
    aoIntensity: 0.72,
    metersPerTileV: 3.8,
    mossAffinity: 0.08,
    wetSheen: 0.94,
  },
  garry_oak: {
    textureId: 'tree_bark_03',
    tint: '#ebe9e0',
    normalScale: 1.42,
    roughness: 0.94,
    aoIntensity: 0.8,
    metersPerTileV: 2.0,
    mossAffinity: 0.42,
    wetSheen: 0.55,
  },
  california_redwood: {
    textureId: 'japanese_cedar_bark',
    tint: '#e8a28d',
    normalScale: 1.5,
    roughness: 0.94,
    aoIntensity: 0.82,
    metersPerTileV: 2.4,
    mossAffinity: 0.35,
    wetSheen: 0.52,
  },
  giant_sequoia: {
    textureId: 'giant_sequoia_bark',
    tint: '#f6ebe2',
    normalScale: 1.65,
    roughness: 0.95,
    aoIntensity: 0.76,
    metersPerTileV: 2.8,
    mossAffinity: 0.1,
    wetSheen: 0.3,
  },
  rhododendron: {
    textureId: 'bark_brown_01',
    tint: '#d8c8bc',
    normalScale: 0.85,
    roughness: 0.88,
    aoIntensity: 0.62,
    metersPerTileV: 1.2,
    mossAffinity: 0.45,
    wetSheen: 0.7,
  },
  eucalyptus: {
    textureId: 'bark_willow',
    tint: '#dde2d8',
    normalScale: 0.88,
    roughness: 0.82,
    aoIntensity: 0.62,
    metersPerTileV: 2.0,
    mossAffinity: 0.08,
    wetSheen: 0.78,
  },
  ponderosa_pine: {
    textureId: 'ponderosa_pine_bark',
    tint: '#ffffff',
    normalScale: 1.45,
    roughness: 0.94,
    aoIntensity: 0.8,
    metersPerTileV: 1.9,
    mossAffinity: 0.06,
    wetSheen: 0.5,
  },
  western_larch: {
    textureId: 'bark_brown_01',
    tint: '#e8b9a3',
    normalScale: 1.3,
    roughness: 0.93,
    aoIntensity: 0.76,
    metersPerTileV: 2.0,
    mossAffinity: 0.08,
    wetSheen: 0.52,
  },
  blue_spruce: {
    textureId: 'sitka_spruce_bark',
    tint: '#e2e6ec',
    normalScale: 1.2,
    roughness: 0.9,
    aoIntensity: 0.72,
    metersPerTileV: 1.7,
    mossAffinity: 0.12,
    wetSheen: 0.6,
  },
  western_white_pine: {
    textureId: 'tree_bark_03',
    tint: '#dcded9',
    normalScale: 1.15,
    roughness: 0.91,
    aoIntensity: 0.74,
    metersPerTileV: 1.9,
    mossAffinity: 0.1,
    wetSheen: 0.58,
  },
  chokecherry: {
    textureId: 'bark_brown_01',
    tint: '#c9a69d',
    normalScale: 0.85,
    roughness: 0.84,
    aoIntensity: 0.64,
    metersPerTileV: 1.3,
    mossAffinity: 0.1,
    wetSheen: 0.8,
  },
  trembling_aspen: {
    textureId: 'aspen_bark',
    tint: '#ffffff',
    normalScale: 0.88,
    roughness: 0.82,
    aoIntensity: 0.6,
    metersPerTileV: 1.6,
    mossAffinity: 0.05,
    wetSheen: 0.78,
  },
  windmill_palm: {
    textureId: 'windmill_palm_bark',
    tint: '#ffffff',
    normalScale: 1.45,
    roughness: 0.94,
    aoIntensity: 0.56,
    metersPerTileV: 0.92,
    mossAffinity: 0.14,
    wetSheen: 0.25,
  },
};

export interface TerrainPbrProfile {
  textureId: PbrTextureId;
  tint: string;
  repeat: number;
  normalScale: number;
  roughness: number;
  aoIntensity: number;
  /** Subtle world-space macro color variation tints */
  macroColorA: string;
  macroColorB: string;
  slopeRockColor: string;
}

export const SITE_TERRAIN_PROFILES: Record<SiteId, TerrainPbrProfile> = {
  coastal_homestead: {
    textureId: 'grass_path_3',
    tint: '#b8c9a3',
    repeat: 44,
    normalScale: 0.95,
    roughness: 0.94,
    aoIntensity: 0.65,
    macroColorA: '#8da478',
    macroColorB: '#b9c69b',
    slopeRockColor: '#6f786b',
  },
  misty_creek: {
    textureId: 'leaves_forest_ground',
    tint: '#94ab84',
    repeat: 48,
    normalScale: 1.15,
    roughness: 0.9,
    aoIntensity: 0.74,
    macroColorA: '#6c875e',
    macroColorB: '#a5ad86',
    slopeRockColor: '#5e6b62',
  },
  timber_ridge: {
    textureId: 'leaves_forest_ground',
    tint: '#a89f82',
    repeat: 46,
    normalScale: 1.2,
    roughness: 0.94,
    aoIntensity: 0.78,
    macroColorA: '#82775d',
    macroColorB: '#95a176',
    slopeRockColor: '#6b6d65',
  },
  storm_bluff: {
    textureId: 'brown_mud_leaves_01',
    tint: '#9fa88e',
    repeat: 46,
    normalScale: 1.15,
    roughness: 0.91,
    aoIntensity: 0.72,
    macroColorA: '#7a8770',
    macroColorB: '#aba58c',
    slopeRockColor: '#687174',
  },
  coastal_town: {
    textureId: 'grass_path_3',
    tint: '#b6cf9c',
    repeat: 42,
    normalScale: 0.72,
    roughness: 0.92,
    aoIntensity: 0.56,
    macroColorA: '#94b57c',
    macroColorB: '#c2d4a5',
    slopeRockColor: '#818c7d',
  },
  pacific_headland: {
    textureId: 'brown_mud_leaves_01',
    tint: '#c4b889',
    repeat: 44,
    normalScale: 1.1,
    roughness: 0.94,
    aoIntensity: 0.68,
    macroColorA: '#a59e72',
    macroColorB: '#d1c294',
    slopeRockColor: '#8d887a',
  },
  kootenay_rockies: {
    textureId: 'brown_mud_leaves_01',
    tint: '#d6c196',
    repeat: 44,
    normalScale: 1.15,
    roughness: 0.95,
    aoIntensity: 0.72,
    macroColorA: '#b59d74',
    macroColorB: '#e0cfa3',
    slopeRockColor: '#a29b8b',
  },
};

/** Ensure uv1 exists on a geometry so Three.js aoMap samples cleanly from the ARM red channel */
export function ensureAoUv(geo: THREE.BufferGeometry): void {
  if (!geo.attributes.uv1 && geo.attributes.uv) {
    geo.setAttribute('uv1', geo.attributes.uv);
  }
}

function assetUrl(relPath: string): string {
  const base = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? './';
  return `${base.endsWith('/') ? base : `${base}/`}${relPath}`;
}

class PbrAssetManager {
  private loader = new THREE.TextureLoader();
  private rgbeLoader = new RGBELoader();
  private texCache = new Map<string, THREE.Texture>();
  private texLoaded = new Set<string>();
  private texListeners = new Map<string, Array<() => void>>();
  private hdriCache = new Map<WeatherId, Promise<THREE.Texture | null>>();
  private maxAnisotropy = 4;
  private pmremGen: THREE.PMREMGenerator | null = null;

  public configureRenderer(renderer: THREE.WebGLRenderer, quality: GraphicsQuality): void {
    const cap = renderer.capabilities.getMaxAnisotropy();
    this.maxAnisotropy = quality === 'high' ? Math.min(8, cap) : Math.min(4, cap);
    for (const tex of this.texCache.values()) {
      tex.anisotropy = this.maxAnisotropy;
      tex.needsUpdate = true;
    }
    if (!this.pmremGen) {
      this.pmremGen = new THREE.PMREMGenerator(renderer);
      this.pmremGen.compileEquirectangularShader();
    }
  }

  private loadTexture(
    relPath: string,
    opts: { srgb?: boolean; wrapS?: THREE.Wrapping; wrapT?: THREE.Wrapping } = {}
  ): { tex: THREE.Texture; key: string } {
    const key = `${relPath}|${opts.srgb ? 'srgb' : 'lin'}|${opts.wrapS ?? THREE.RepeatWrapping}|${opts.wrapT ?? THREE.RepeatWrapping}`;
    const cached = this.texCache.get(key);
    if (cached) return { tex: cached, key };

    const tex = this.loader.load(assetUrl(relPath), () => {
      this.texLoaded.add(key);
      tex.needsUpdate = true;
      const listeners = this.texListeners.get(key);
      if (listeners) {
        for (const fn of listeners) fn();
        this.texListeners.delete(key);
      }
    });
    tex.wrapS = opts.wrapS ?? THREE.RepeatWrapping;
    tex.wrapT = opts.wrapT ?? THREE.RepeatWrapping;
    tex.colorSpace = opts.srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.anisotropy = this.maxAnisotropy;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    this.texCache.set(key, tex);
    return { tex, key };
  }

  /**
   * Returns a PBR texture set (diffuse, OpenGL normal, ARM) for the given asset ID.
   * On 'standard' quality, loads the lightweight 1K diffuse; on 'high', loads the 2K diffuse.
   * Each caller that needs custom repeat/offset gets a lightweight Texture clone sharing the same GPU image.
   */
  public getPbrSet(
    id: PbrTextureId,
    quality: GraphicsQuality,
    opts: { wrapS?: THREE.Wrapping; wrapT?: THREE.Wrapping; repeatX?: number; repeatY?: number } = {}
  ): PbrMaterialMaps {
    const diffPath =
      quality === 'high'
        ? `assets/textures/${id}/diff.webp`
        : `assets/textures/${id}/diff_1k.webp`;
    const norPath = `assets/textures/${id}/nor.webp`;
    const armPath = `assets/textures/${id}/arm.webp`;

    const baseDiff = this.loadTexture(diffPath, { srgb: true, wrapS: opts.wrapS, wrapT: opts.wrapT });
    const baseNor = this.loadTexture(norPath, { srgb: false, wrapS: opts.wrapS, wrapT: opts.wrapT });
    const baseArm = this.loadTexture(armPath, { srgb: false, wrapS: opts.wrapS, wrapT: opts.wrapT });

    const rx = opts.repeatX ?? 1;
    const ry = opts.repeatY ?? 1;

    if (rx === 1 && ry === 1) {
      return { map: baseDiff.tex, normalMap: baseNor.tex, armMap: baseArm.tex };
    }

    const cloneWithRepeat = (entry: { tex: THREE.Texture; key: string }) => {
      const c = entry.tex.clone();
      c.repeat.set(rx, ry);
      c.wrapS = opts.wrapS ?? THREE.RepeatWrapping;
      c.wrapT = opts.wrapT ?? THREE.RepeatWrapping;
      c.anisotropy = this.maxAnisotropy;
      if (this.texLoaded.has(entry.key)) {
        c.needsUpdate = true;
      } else {
        const arr = this.texListeners.get(entry.key) ?? [];
        arr.push(() => {
          c.source = entry.tex.source;
          c.needsUpdate = true;
        });
        this.texListeners.set(entry.key, arr);
      }
      return c;
    };

    return {
      map: cloneWithRepeat(baseDiff),
      normalMap: cloneWithRepeat(baseNor),
      armMap: cloneWithRepeat(baseArm),
    };
  }

  /** Loads and PMREM-prefilters the weather-matched CC0 HDRI for IBL lighting on High quality. */
  public loadWeatherHDRI(weather: WeatherId, renderer: THREE.WebGLRenderer): Promise<THREE.Texture | null> {
    if (!this.pmremGen) {
      this.pmremGen = new THREE.PMREMGenerator(renderer);
      this.pmremGen.compileEquirectangularShader();
    }
    const existing = this.hdriCache.get(weather);
    if (existing) return existing;

    const url = assetUrl(`assets/hdri/${weather}.hdr`);
    const promise = new Promise<THREE.Texture | null>((resolve) => {
      this.rgbeLoader.load(
        url,
        (hdrTex) => {
          try {
            hdrTex.mapping = THREE.EquirectangularReflectionMapping;
            const envRT = this.pmremGen!.fromEquirectangular(hdrTex);
            hdrTex.dispose();
            resolve(envRT.texture);
          } catch {
            resolve(null);
          }
        },
        undefined,
        () => resolve(null)
      );
    });
    this.hdriCache.set(weather, promise);
    return promise;
  }

  public dispose(): void {
    for (const tex of this.texCache.values()) {
      tex.dispose();
    }
    this.texCache.clear();
    this.pmremGen?.dispose();
    this.pmremGen = null;
  }
}

export const pbrAssets = new PbrAssetManager();
