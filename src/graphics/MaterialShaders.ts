import * as THREE from 'three';
import { SiteId, WeatherId } from '../types';
import { SITE_TERRAIN_PROFILES } from './PbrAssetManager';

export interface FoliageWindUniforms {
  uTime: { value: number };
  uWindStrength: { value: number };
  uWindDir: { value: THREE.Vector2 };
  uSunDir: { value: THREE.Vector3 };
  uSunColor: { value: THREE.Color };
}

/**
 * Terrain anti-tiling & biome macro-detail injection for High quality:
 * - Breaks up 240x240m PBR texture repetition with dual-frequency world-space FBM color/roughness variation
 * - Blends subtle mossy/rocky hue shifts on steeper slopes (mossy coastal vs warm limestone Kootenays)
 */
export function applyTerrainDetailShader(
  mat: THREE.MeshStandardMaterial,
  site: SiteId,
  weather: WeatherId
): void {
  const profile = SITE_TERRAIN_PROFILES[site];
  const isWet = weather === 'light_rain' || weather === 'coastal_gale';

  mat.customProgramCacheKey = () => `terrain-detail-${site}-${isWet ? 'wet' : 'dry'}`;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uMacroA = { value: new THREE.Color(profile.macroColorA) };
    shader.uniforms.uMacroB = { value: new THREE.Color(profile.macroColorB) };
    shader.uniforms.uSlopeRock = { value: new THREE.Color(profile.slopeRockColor) };
    shader.uniforms.uWetness = { value: isWet ? 0.52 : weather === 'misty_fog' ? 0.22 : 0.0 };

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vTerrainWorldPos;
        varying vec3 vTerrainWorldNormal;`
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
        vTerrainWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vec3 tWn = mat3(modelMatrix) * objectNormal;
        vTerrainWorldNormal = dot(tWn, tWn) > 1e-8 ? normalize(tWn) : vec3(0.0, 1.0, 0.0);`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform vec3 uMacroA;
        uniform vec3 uMacroB;
        uniform vec3 uSlopeRock;
        uniform float uWetness;
        varying vec3 vTerrainWorldPos;
        varying vec3 vTerrainWorldNormal;

        float tHash(vec2 p) {
          p = fract(p * vec2(127.1, 311.7));
          p += dot(p, p + 34.5);
          return fract(p.x * p.y);
        }
        float tNoise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(
            mix(tHash(i), tHash(i + vec2(1.0, 0.0)), u.x),
            mix(tHash(i + vec2(0.0, 1.0)), tHash(i + vec2(1.0, 1.0)), u.x),
            u.y
          );
        }`
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float nLarge = tNoise(vTerrainWorldPos.xz * 0.038);
        float nMed = tNoise(vTerrainWorldPos.xz * 0.14 + vec2(13.7, 5.2));
        float macroMix = clamp(nLarge * 0.65 + nMed * 0.35, 0.0, 1.0);
        vec3 macroTint = mix(uMacroA, uMacroB, macroMix);
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * macroTint * 1.18, 0.48);

        // Slope rock/scree exposure on steeper hillsides
        float slope = 1.0 - clamp(vTerrainWorldNormal.y, 0.0, 1.0);
        float rockMask = smoothstep(0.09, 0.30, slope + (nMed - 0.5) * 0.08);
        diffuseColor.rgb = mix(diffuseColor.rgb, uSlopeRock * (0.78 + nMed * 0.36), rockMask * 0.65);

        // Damp rain-soaked soil darkening in low spots
        float puddleMask = smoothstep(0.45, 0.78, nLarge) * uWetness * (1.0 - rockMask);
        diffuseColor.rgb *= (1.0 - puddleMask * 0.24);`
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        float rMacro = tNoise(vTerrainWorldPos.xz * 0.09 + vec2(4.2, 19.1));
        roughnessFactor = clamp(roughnessFactor + (rMacro - 0.5) * 0.14 - uWetness * 0.28 * smoothstep(0.42, 0.78, rMacro), 0.18, 0.98);`
      );
  };
}

/**
 * Adds organic moss patina (coastal sites) + rain-slick wetness modulation to tree bark materials.
 * Can optionally include Humboldt notch + back-cut local-space discard shader on butt-log segments[0]
 * so both effects coexist cleanly inside a single onBeforeCompile hook!
 */
export function applyBarkSurfaceShader(
  mat: THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial,
  opts: {
    site: SiteId;
    weather: WeatherId;
    mossAffinity: number;
    /** Enables non-repeating world-space Pacific Madrone peeling color zones + rough fissured basal bark */
    arbutusMode?: boolean;
    cutUniforms?: {
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
  }
): void {
  const siteHumidity: Record<SiteId, number> = {
    misty_creek: 1.0,
    timber_ridge: 0.88,
    coastal_homestead: 0.72,
    storm_bluff: 0.62,
    pacific_headland: 0.58,
    coastal_town: 0.36,
    kootenay_rockies: 0.08,
  };
  const mossAmount = THREE.MathUtils.clamp(opts.mossAffinity * siteHumidity[opts.site], 0, 0.9);
  const wetness =
    opts.weather === 'light_rain'
      ? 0.85
      : opts.weather === 'coastal_gale'
        ? 0.58
        : opts.weather === 'misty_fog'
          ? 0.24
          : 0.0;
  const hasCut = Boolean(opts.cutUniforms);
  const isArbutus = Boolean(opts.arbutusMode);

  mat.customProgramCacheKey = () =>
    `bark-surface-${isArbutus ? 'arbutus-' : ''}${hasCut ? 'cut-' : ''}${opts.site}-${opts.weather}-${Math.round(mossAmount * 10)}`;

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uMossAmount = { value: mossAmount };
    shader.uniforms.uBarkWetness = { value: wetness };
    if (opts.cutUniforms) {
      Object.assign(shader.uniforms, opts.cutUniforms);
    }

    const vCommonExtra = `
      varying vec3 vBarkWorldPos;
      varying vec3 vBarkWorldNormal;
      ${hasCut ? 'varying vec3 vCutLocalPos;' : ''}
    `;

    const vPosExtra = `
      vBarkWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
      vec3 bWn = mat3(modelMatrix) * objectNormal;
      vBarkWorldNormal = dot(bWn, bWn) > 1e-8 ? normalize(bWn) : vec3(0.0, 1.0, 0.0);
      ${hasCut ? 'vCutLocalPos = position;' : ''}
    `;

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${vCommonExtra}`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>\n${vPosExtra}`);

    const fCommonExtra = `
      uniform float uMossAmount;
      uniform float uBarkWetness;
      varying vec3 vBarkWorldPos;
      varying vec3 vBarkWorldNormal;
      ${
        hasCut
          ? `
      uniform vec3 uSeg0Pos;
      uniform vec2 uCutCenterXZ;
      uniform vec2 uAimDir;
      uniform float uFaceEnabled;
      uniform float uFaceTopY;
      uniform float uFaceHingeX;
      uniform float uFaceSlope;
      uniform float uBackEnabled;
      uniform float uBackCenterY;
      uniform float uBackHalfH;
      uniform float uBackTipX;
      varying vec3 vCutLocalPos;`
          : ''
      }
      float bHash(vec2 p) {
        p = fract(p * vec2(127.1, 311.7));
        p += dot(p, p + 19.19);
        return fract(p.x * p.y);
      }
      float bNoise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(
          mix(bHash(i), bHash(i + vec2(1.0, 0.0)), u.x),
          mix(bHash(i + vec2(0.0, 1.0)), bHash(i + vec2(1.0, 1.0)), u.x),
          u.y
        );
      }
      ${
        isArbutus
          ? `
      float bHash3(vec3 p) {
        p = fract(p * vec3(443.897, 441.423, 437.195));
        p += dot(p, p.yzx + 19.19);
        return fract((p.x + p.y) * p.z);
      }
      float bNoise3(vec3 p) {
        vec3 i = floor(p);
        vec3 f = fract(p);
        vec3 u = f * f * (3.0 - 2.0 * f);
        return mix(
          mix(
            mix(bHash3(i), bHash3(i + vec3(1.0, 0.0, 0.0)), u.x),
            mix(bHash3(i + vec3(0.0, 1.0, 0.0)), bHash3(i + vec3(1.0, 1.0, 0.0)), u.x),
            u.y
          ),
          mix(
            mix(bHash3(i + vec3(0.0, 0.0, 1.0)), bHash3(i + vec3(1.0, 0.0, 1.0)), u.x),
            mix(bHash3(i + vec3(0.0, 1.0, 1.0)), bHash3(i + vec3(1.0, 1.0, 1.0)), u.x),
            u.y
          ),
          u.z
        );
      }
      float bFbm3(vec3 p) {
        float v = 0.0;
        float a = 0.52;
        for (int i = 0; i < 3; i++) {
          v += a * bNoise3(p);
          p = p * 2.07 + vec3(7.3, 3.1, 11.9);
          a *= 0.48;
        }
        return v;
      }`
          : ''
      }
    `;

    const arbutusColorSnippet = isArbutus
      ? `
        // Non-repeating Pacific Madrone peeling bark synthesis:
        // Large-scale 3D world-space flowing inner-wood hues (deep mahogany -> terracotta -> honey-ochre -> olive-chartreuse)
        // + organic weathered dark gray-brown scaly basal bark climbing unevenly up the lower root buttress!
        vec3 aPos = vBarkWorldPos;
        vec3 aWarp = vec3(
          bFbm3(aPos * vec3(0.85, 0.35, 0.85)),
          bFbm3(aPos * vec3(0.55, 0.28, 0.55) + vec3(5.2, 1.7, 8.4)),
          bFbm3(aPos * vec3(0.85, 0.35, 0.85) + vec3(11.1, 4.3, 2.9))
        );
        float aMacroHue = bFbm3(aPos * vec3(0.65, 0.24, 0.65) + aWarp * 1.15);
        float aPatch = bFbm3(aPos * vec3(1.85, 0.62, 1.85) + aWarp * 1.4);
        float aFinePeel = bNoise3(aPos * vec3(5.4, 1.4, 5.4) + aWarp * 2.1);

        // Distinguish darker curling mahogany ribbons vs smooth exposed inner wood in the sampled albedo
        float texLuma = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
        float isCurlingStrip = smoothstep(0.36, 0.20, texLuma);

        // Smooth inner madrone palette: rich burnished terracotta-copper, warm golden-ochre, deep mahogany & subtle olive underbark
        vec3 colMahogany = vec3(0.24, 0.075, 0.042);
        vec3 colTerracotta = vec3(0.54, 0.19, 0.075);
        vec3 colOchre = vec3(0.68, 0.39, 0.12);
        vec3 colOlive = vec3(0.38, 0.42, 0.14);

        vec3 innerFlow = mix(colTerracotta, colOchre, smoothstep(0.26, 0.74, aMacroHue));
        // Freshly shed chartreuse-olive streaks appear more along sweeping upper curves & sunny bends
        float oliveMask = smoothstep(0.60, 0.80, aPatch) * smoothstep(1.2, 5.2, aPos.y) * (0.45 + 0.55 * aFinePeel);
        innerFlow = mix(innerFlow, colOlive, oliveMask * 0.55);
        // Deep burnished cinnamon-mahogany patches on older outer bark sheets
        float deepSheet = smoothstep(0.54, 0.76, bFbm3(aPos * vec3(1.3, 0.42, 1.3) + vec3(3.7, 9.1, 1.4) + aWarp * 0.9));
        innerFlow = mix(innerFlow, colMahogany, deepSheet * 0.52);

        // Keep fine photographic peel edges & dark curling ribbons from the high-res PBR map, broken up organically
        vec3 peelMod = mix(innerFlow * (0.72 + texLuma * 0.66), diffuseColor.rgb * mix(vec3(0.62, 0.46, 0.38), vec3(0.98, 0.84, 0.70), aFinePeel), 0.36);
        vec3 darkCurl = mix(colMahogany * 0.65, vec3(0.18, 0.06, 0.035), aFinePeel);
        diffuseColor.rgb = mix(peelMod, darkCurl, isCurlingStrip * (0.58 + 0.42 * deepSheet));

        // Occasional small weathered silver-gray exposed heartwood scars on mature lower bends
        float scarN = bFbm3(aPos * vec3(1.4, 0.55, 1.4) + vec3(17.2, 2.8, 9.5));
        float scarMask = smoothstep(0.77, 0.87, scarN) * smoothstep(0.6, 2.2, aPos.y) * smoothstep(7.5, 3.0, aPos.y);
        vec3 silverWood = mix(vec3(0.28, 0.26, 0.24), vec3(0.42, 0.39, 0.35), bNoise3(aPos * vec3(12.0, 2.2, 12.0)));
        diffuseColor.rgb = mix(diffuseColor.rgb, silverWood, scarMask * 0.68);

        // Weathered dark charcoal-brown scaly/fissured basal bark climbing unevenly up the lower trunk & root buttress!
        float basalEdgeNoise = bFbm3(vec3(aPos.x * 2.1, aPos.y * 0.45, aPos.z * 2.1)) * 1.95
                             + bNoise3(vec3(aPos.x * 6.5, aPos.y * 0.85, aPos.z * 6.5)) * 0.48;
        float aBasalMask = smoothstep(2.05, 0.65, aPos.y - basalEdgeNoise * 0.78);
        float basalFurrow = bNoise3(vec3(aPos.x * 22.0, aPos.y * 3.2, aPos.z * 22.0)) * 0.62
                          + bNoise3(vec3(aPos.x * 42.0, aPos.y * 8.5, aPos.z * 42.0)) * 0.38;
        vec3 basalCol = mix(vec3(0.075, 0.06, 0.052), vec3(0.22, 0.175, 0.145), basalFurrow);
        // Warm burnt-umber flaking transition rim where dark basal bark peels off into smooth terracotta
        float basalRim = smoothstep(0.06, 0.32, aBasalMask) * (1.0 - smoothstep(0.45, 0.78, aBasalMask));
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.22, 0.085, 0.045), basalRim * 0.68);
        diffuseColor.rgb = mix(diffuseColor.rgb, basalCol, aBasalMask * 0.94);
      `
      : '';

    const arbutusRoughnessSnippet = isArbutus
      ? `
        // Silky satin sheen on smooth peeled terracotta/ochre inner bark vs dry papery curls & rough scaly basal bark
        float aRPosY = vBarkWorldPos.y;
        float aREdge = bFbm3(vec3(vBarkWorldPos.x * 1.85, aRPosY * 0.55, vBarkWorldPos.z * 1.85)) * 1.75;
        float aRBasal = smoothstep(2.35, 0.42, aRPosY - aREdge * 0.72);
        float aRSmoothPatch = bFbm3(vBarkWorldPos * vec3(1.1, 0.4, 1.1) + vec3(4.1, 2.3, 6.8));
        // Smooth inner madrone wood gleams softly (0.44..0.58), rough scaly base stays matte (0.93)
        roughnessFactor = mix(clamp(roughnessFactor * 0.76 + (aRSmoothPatch - 0.5) * 0.14, 0.42, 0.84), 0.94, aRBasal);
      `
      : '';

    const arbutusNormalSnippet = isArbutus
      ? `
        // Add gritty fissured relief to the dark scaly basal bark while keeping upper peeled trunk silky smooth
        float aNEdge = bFbm3(vec3(vBarkWorldPos.x * 1.85, vBarkWorldPos.y * 0.55, vBarkWorldPos.z * 1.85)) * 1.75;
        float aNBasal = smoothstep(2.35, 0.42, vBarkWorldPos.y - aNEdge * 0.72);
        if (aNBasal > 0.02) {
          vec3 bp = vBarkWorldPos * vec3(22.0, 5.5, 22.0);
          float h0 = bNoise3(bp);
          vec3 bPerturb = vec3(
            bNoise3(bp + vec3(0.18, 0.0, 0.0)) - h0,
            bNoise3(bp + vec3(0.0, 0.18, 0.0)) - h0,
            bNoise3(bp + vec3(0.0, 0.0, 0.18)) - h0
          );
          vec3 bN = normal + bPerturb * (1.25 * aNBasal);
          normal = dot(bN, bN) > 1e-6 ? normalize(bN) : normal;
        }
      `
      : '';

    const cutDiscardSnippet = hasCut
      ? `
        if (uFaceEnabled > 0.5 || uBackEnabled > 0.5) {
          vec3 tp = vCutLocalPos + uSeg0Pos;
          float lx = dot(tp.xz - uCutCenterXZ, uAimDir);
          if (uFaceEnabled > 0.5 && lx > uFaceHingeX) {
            float yFloor = uFaceTopY - uFaceSlope * max(0.0, lx * 0.992 - uFaceHingeX);
            if (tp.y < uFaceTopY - 0.002 && tp.y > yFloor) {
              discard;
            }
          }
          if (uBackEnabled > 0.5 && lx < uBackTipX) {
            if (abs(tp.y - uBackCenterY) < uBackHalfH - 0.001) {
              discard;
            }
          }
        }
      `
      : '';

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${fCommonExtra}`)
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>\n${cutDiscardSnippet}`
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        ${arbutusColorSnippet}
        // Coastal moss growth on north/upward-facing lower bark
        if (uMossAmount > 0.02) {
          float northUp = clamp(vBarkWorldNormal.y * 0.75 + (-vBarkWorldNormal.z) * 0.45 + 0.22, 0.0, 1.0);
          float lowBoost = smoothstep(10.5, 0.8, vBarkWorldPos.y);
          float mNoise = bNoise(vBarkWorldPos.xz * 1.9 + vec2(0.0, vBarkWorldPos.y * 0.85));
          float mMask = smoothstep(0.46, 0.82, northUp * 0.65 + lowBoost * 0.4 + mNoise * 0.45 - 0.35) * uMossAmount;
          vec3 mossCol = mix(vec3(0.16, 0.28, 0.11), vec3(0.28, 0.38, 0.15), mNoise);
          diffuseColor.rgb = mix(diffuseColor.rgb, mossCol, clamp(mMask * 0.72, 0.0, 0.75));
        }
        // Wet rain-darkened bark absorption
        if (uBarkWetness > 0.05) {
          float streak = bNoise(vec2(vBarkWorldPos.x * 6.0 + vBarkWorldPos.z * 6.0, vBarkWorldPos.y * 0.9));
          diffuseColor.rgb *= (1.0 - uBarkWetness * (0.16 + streak * 0.12));
        }`
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        ${arbutusNormalSnippet}`
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        ${arbutusRoughnessSnippet}
        if (uBarkWetness > 0.05) {
          float wetStreak = bNoise(vec2(vBarkWorldPos.x * 7.5 + vBarkWorldPos.z * 7.5, vBarkWorldPos.y * 1.1));
          roughnessFactor = clamp(roughnessFactor - uBarkWetness * (0.28 + wetStreak * 0.22), 0.22, 0.98);
        }`
      );
  };
}

/**
 * High-detail foliage shader:
 * - Organic vertex wind sway keyed to contract windSpeed/windAngle
 * - World-space 3D leaf/needle cluster micro-dapple, canopy underside cavity AO,
 *   procedural micro-normal breakup (kills smooth/faceted low-poly look!),
 *   and warm backlit subsurface translucency when sun shines through the crown!
 */
export function applyFoliageWindShader(
  mat: THREE.MeshStandardMaterial,
  windUniforms: FoliageWindUniforms
): void {
  mat.customProgramCacheKey = () => 'foliage-wind-detail-v2';
  mat.envMapIntensity = 0.42;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = windUniforms.uTime;
    shader.uniforms.uWindStrength = windUniforms.uWindStrength;
    shader.uniforms.uWindDir = windUniforms.uWindDir;
    shader.uniforms.uSunDir = windUniforms.uSunDir;
    shader.uniforms.uSunColor = windUniforms.uSunColor;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uTime;
        uniform float uWindStrength;
        uniform vec2 uWindDir;
        varying vec3 vFolWorldPos;
        varying vec3 vFolWorldNormal;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vec4 wBase = modelMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        float hMask = clamp((wBase.y - 2.0) * 0.08, 0.12, 1.0);
        float phase = wBase.x * 0.43 + wBase.z * 0.37 + wBase.y * 0.29;
        float gust = sin(uTime * (1.7 + uWindStrength * 2.1) + phase) * 0.65
                   + sin(uTime * 3.6 + phase * 1.9 + position.x * 2.1) * 0.35;
        float sway = gust * (0.045 + uWindStrength * 0.16) * hMask;
        transformed.x += uWindDir.x * sway;
        transformed.z += uWindDir.y * sway;
        transformed.y += sin(uTime * 2.9 + phase * 1.3) * abs(sway) * 0.22;`
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
        vFolWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vec3 fWn = mat3(modelMatrix) * objectNormal;
        vFolWorldNormal = dot(fWn, fWn) > 1e-8 ? normalize(fWn) : vec3(0.0, 1.0, 0.0);`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform vec3 uSunDir;
        uniform vec3 uSunColor;
        varying vec3 vFolWorldPos;
        varying vec3 vFolWorldNormal;

        float fHash3(vec3 p) {
          p = fract(p * vec3(443.897, 441.423, 437.195));
          p += dot(p, p.yzx + 19.19);
          return fract((p.x + p.y) * p.z);
        }
        float fNoise3(vec3 p) {
          vec3 i = floor(p);
          vec3 f = fract(p);
          vec3 u = f * f * (3.0 - 2.0 * f);
          return mix(
            mix(
              mix(fHash3(i), fHash3(i + vec3(1.0, 0.0, 0.0)), u.x),
              mix(fHash3(i + vec3(0.0, 1.0, 0.0)), fHash3(i + vec3(1.0, 1.0, 0.0)), u.x),
              u.y
            ),
            mix(
              mix(fHash3(i + vec3(0.0, 0.0, 1.0)), fHash3(i + vec3(1.0, 0.0, 1.0)), u.x),
              mix(fHash3(i + vec3(0.0, 1.0, 1.0)), fHash3(i + vec3(1.0, 1.0, 1.0)), u.x),
              u.y
            ),
            u.z
          );
        }`
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        // Multi-scale organic leaf & needle cluster dapple
        float nCluster = fNoise3(vFolWorldPos * 2.1);
        float nLeaf = fNoise3(vFolWorldPos * 8.5 + vec3(nCluster * 1.4));
        float nFine = fNoise3(vFolWorldPos * 22.0);
        float dapple = nCluster * 0.38 + nLeaf * 0.42 + nFine * 0.20;
        // Soft underside shadow + sunlit top leaf warmth
        float upLight = clamp(vFolWorldNormal.y * 0.5 + 0.5, 0.0, 1.0);
        float shadeMod = mix(0.64, 1.18, dapple) * mix(0.68, 1.12, upLight);
        diffuseColor.rgb *= shadeMod;
        // Subtle warm golden-green shift on sunlit leaf tips
        diffuseColor.rgb += vec3(0.03, 0.045, 0.005) * smoothstep(0.55, 0.92, dapple) * upLight;`
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        // Perturb shading normal with fine 3D foliage tuft noise to break up geometric facets
        vec3 fp = vFolWorldPos * 7.2;
        float e = 0.08;
        float hc = fNoise3(fp);
        vec3 leafPerturb = vec3(
          fNoise3(fp + vec3(e, 0.0, 0.0)) - hc,
          fNoise3(fp + vec3(0.0, e, 0.0)) - hc,
          fNoise3(fp + vec3(0.0, 0.0, e)) - hc
        );
        vec3 perturbedFolN = normal + leafPerturb * 0.58;
        normal = dot(perturbedFolN, perturbedFolN) > 1e-6 ? normalize(perturbedFolN) : normal;`
      )
      .replace(
        '#include <dithering_fragment>',
        `// Backlit subsurface scattering when sun shines through canopy edges (NaN-safe for Metal/WebGL2 HalfFloat bloom)
        vec3 toCam = cameraPosition - vFolWorldPos;
        vec3 vDir = dot(toCam, toCam) > 1e-8 ? normalize(toCam) : vec3(0.0, 0.0, 1.0);
        vec3 lDir = dot(uSunDir, uSunDir) > 1e-8 ? normalize(uSunDir) : vec3(0.0, 1.0, 0.0);
        vec3 nWorld = dot(vFolWorldNormal, vFolWorldNormal) > 1e-8 ? normalize(vFolWorldNormal) : vec3(0.0, 1.0, 0.0);
        float bs = clamp(dot(-vDir, lDir), 0.0, 1.0);
        float backScatter = bs * bs * bs;
        float rimBase = clamp(1.0 - abs(dot(nWorld, vDir)), 0.0, 1.0);
        float rimThin = rimBase > 1e-4 ? pow(rimBase, 1.6) : 0.0;
        float sss = (backScatter * 0.55 + rimThin * 0.25) * clamp(nWorld.y * 0.45 + 0.65, 0.15, 1.0);
        gl_FragColor.rgb += diffuseColor.rgb * uSunColor * sss * 0.36;
        #include <dithering_fragment>`
      );
  };
}

export interface FoliageCardShaderOptions {
  /** 'bottom' locks stem base (uv.y = 0) & flutters leaf tips; 'top' locks willow anchor (uv.y = 1) & sways hanging fronds */
  anchor: 'bottom' | 'top';
  /** Strength of subsurface sun translucency (0 for brittle deadwood, ~0.48 for crimson maple / chartreuse willow) */
  sssStrength: number;
  /** Flutter amplitude multiplier (higher on weeping willow curtains, tighter on stiff conifers) */
  flutterScale: number;
  /** Optional Pass-2 gossamer veil cutoff: renders only translucent wisps below this alpha */
  softVeilMaxAlpha?: number;
}

/**
 * State-of-the-art botanical sprig card shader (SpeedTree / Ghost of Tsushima architecture):
 *  - Two-tier GPU wind: macro limb sway + UV-masked micro leaf/frond tip flutter
 *  - Preserves transferred canopy-outward volumetric normals across double-sided cards (no harsh card-plane seams)
 *  - NaN-safe backlit sun subsurface translucency (SSS) for luminous sunlit leaves & needles
 */
export function applyFoliageCardShader(
  mat: THREE.MeshStandardMaterial,
  windUniforms: FoliageWindUniforms,
  opts: FoliageCardShaderOptions
): void {
  const anchorFlag = opts.anchor === 'top' ? 1.0 : 0.0;
  const sssVal = opts.sssStrength.toFixed(3);
  const flutterVal = opts.flutterScale.toFixed(3);
  const veilMax = opts.softVeilMaxAlpha ?? 0;
  const veilKey = veilMax > 0 ? `-veil${veilMax.toFixed(2)}` : '';

  mat.customProgramCacheKey = () =>
    `foliage-card-v1-${opts.anchor}-${sssVal}-${flutterVal}${veilKey}`;

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = windUniforms.uTime;
    shader.uniforms.uWindStrength = windUniforms.uWindStrength;
    shader.uniforms.uWindDir = windUniforms.uWindDir;
    shader.uniforms.uSunDir = windUniforms.uSunDir;
    shader.uniforms.uSunColor = windUniforms.uSunColor;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uTime;
        uniform float uWindStrength;
        uniform vec2 uWindDir;
        varying vec3 vCardWorldPos;
        varying vec3 vCardWorldNormal;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vec4 cardWPos = modelMatrix * vec4(transformed, 1.0);
        float cardHMask = clamp((cardWPos.y - 1.2) * 0.11, 0.14, 1.0);
        // Anchor mask: 0 at stem/bough attachment, 1 at free leaf/strand tip
        float flexRaw = ${anchorFlag > 0.5 ? '1.0 - uv.y' : 'uv.y'};
        float flexMask = smoothstep(0.08, 0.96, flexRaw);
        float flexCurve = flexMask * flexMask;

        // Tier 1: Macro branch/bough wind sway
        float macroPhase = cardWPos.x * 0.42 + cardWPos.z * 0.37 + cardWPos.y * 0.25;
        float macroGust = sin(uTime * (1.55 + uWindStrength * 2.0) + macroPhase) * 0.65
                        + sin(uTime * 2.85 + macroPhase * 1.7) * 0.35;
        float macroSway = macroGust * (0.042 + uWindStrength * 0.15) * cardHMask * (0.32 + 0.68 * flexMask);

        // Tier 2: High-frequency per-sprig tip flutter (or sweeping curtain ripple on weeping willow)
        float microPhase = cardWPos.x * 2.35 + cardWPos.z * 2.15 + cardWPos.y * 1.65 + uv.x * 3.14;
        float microWave = sin(uTime * (3.6 + uWindStrength * 3.2) + microPhase) * 0.65
                        + cos(uTime * 5.8 + microPhase * 1.45) * 0.35;
        float flutterAmp = (0.022 + uWindStrength * 0.085) * ${flutterVal} * flexCurve;

        transformed.x += uWindDir.x * (macroSway + flutterAmp * microWave) + normal.x * flutterAmp * microWave * 0.45;
        transformed.z += uWindDir.y * (macroSway + flutterAmp * microWave) + normal.z * flutterAmp * microWave * 0.45;
        transformed.y += sin(uTime * 3.1 + microPhase) * flutterAmp * 0.42;`
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
        vCardWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vec3 cWn = mat3(modelMatrix) * objectNormal;
        vCardWorldNormal = dot(cWn, cWn) > 1e-8 ? normalize(cWn) : vec3(0.0, 1.0, 0.0);`
      );

    const veilAlphaSnippet =
      veilMax > 0
        ? `
        // Pass-2 gossamer feather veil: smoothly blends only translucent wisps outside the opaque core
        // and fades grazing edge-on cards softly so plumes never flash as flat translucent ribbons!
        if (diffuseColor.a >= ${veilMax.toFixed(3)} || diffuseColor.a < 0.025) discard;
        vec3 vGeoN = cross(dFdx(vCardWorldPos), dFdy(vCardWorldPos));
        vec3 vCamV = cameraPosition - vCardWorldPos;
        float vFace = (dot(vGeoN, vGeoN) > 1e-10 && dot(vCamV, vCamV) > 1e-8)
          ? abs(dot(normalize(vGeoN), normalize(vCamV)))
          : 1.0;
        float vEdgeFade = smoothstep(0.14, 0.46, vFace);
        diffuseColor.a = pow(clamp(diffuseColor.a / ${veilMax.toFixed(3)}, 0.0, 1.0), 0.88) * 0.88 * vEdgeFade;
        if (diffuseColor.a < 0.015) discard;`
        : '';

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform vec3 uSunDir;
        uniform vec3 uSunColor;
        varying vec3 vCardWorldPos;
        varying vec3 vCardWorldNormal;`
      )
      .replace(
        '#include <alphatest_fragment>',
        `#include <alphatest_fragment>${veilAlphaSnippet}`
      )
      .replace(
        '#include <normal_fragment_begin>',
        `#include <normal_fragment_begin>
        #ifdef DOUBLE_SIDED
          // Preserve canopy-outward transferred volumetric normal across double-sided cards
          // so overlapping sprigs shade like one lush 3D volume instead of dark intersecting planes
          vec3 smoothVolN = dot(vNormal, vNormal) > 1e-6 ? normalize(vNormal) : normal;
          normal = normalize(mix(smoothVolN, normal, 0.18));
        #endif`
      )
      .replace(
        '#include <dithering_fragment>',
        `// Backlit sun subsurface translucency through thin leaves & needles (NaN-safe for HalfFloat bloom)
        vec3 cToCam = cameraPosition - vCardWorldPos;
        vec3 cVDir = dot(cToCam, cToCam) > 1e-8 ? normalize(cToCam) : vec3(0.0, 0.0, 1.0);
        vec3 cLDir = dot(uSunDir, uSunDir) > 1e-8 ? normalize(uSunDir) : vec3(0.0, 1.0, 0.0);
        vec3 cNWorld = dot(vCardWorldNormal, vCardWorldNormal) > 1e-8 ? normalize(vCardWorldNormal) : vec3(0.0, 1.0, 0.0);
        float cBs = clamp(dot(-cVDir, cLDir), 0.0, 1.0);
        float cBackScatter = cBs * cBs * cBs;
        float cWrap = clamp(dot(cNWorld, cLDir) * 0.45 + 0.55, 0.15, 1.0);
        float cSss = (cBackScatter * 0.72 + cWrap * 0.18) * clamp(cNWorld.y * 0.45 + 0.65, 0.2, 1.0);
        gl_FragColor.rgb += diffuseColor.rgb * uSunColor * cSss * ${sssVal};
        #include <dithering_fragment>`
      );
  };
}

/**
 * Instanced botanical ground-cover shader (PNW sword ferns, salal shrubs, Kootenay bunchgrass & wildflowers):
 * - Root-anchored GPU wind ripple (uv.y = 0 stays planted in the soil, tips sway naturally with gusts)
 * - Soft ground-contact AO darkening near base so plants nestle organically into forest duff & grass
 * - Smooth volumetric double-sided shading + backlit sunlit leaf translucency
 */
export function applyGroundCoverShader(
  mat: THREE.MeshStandardMaterial,
  windUniforms: FoliageWindUniforms,
  opts: {
    swayScale?: number;
    sssStrength?: number;
    baseAo?: number;
  } = {}
): void {
  const swayVal = (opts.swayScale ?? 1.0).toFixed(3);
  const sssVal = (opts.sssStrength ?? 0.34).toFixed(3);
  const aoMin = (opts.baseAo ?? 0.56).toFixed(3);

  mat.customProgramCacheKey = () => `ground-cover-${swayVal}-${sssVal}-${aoMin}`;

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = windUniforms.uTime;
    shader.uniforms.uWindStrength = windUniforms.uWindStrength;
    shader.uniforms.uWindDir = windUniforms.uWindDir;
    shader.uniforms.uSunDir = windUniforms.uSunDir;
    shader.uniforms.uSunColor = windUniforms.uSunColor;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uTime;
        uniform float uWindStrength;
        uniform vec2 uWindDir;
        varying vec3 vGcWorldPos;
        varying vec3 vGcWorldNormal;
        varying float vGcHeightUv;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vGcHeightUv = uv.y;
        #ifdef USE_INSTANCING
          vec4 gcBaseW = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        #else
          vec4 gcBaseW = modelMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        #endif
        float gcFlex = smoothstep(0.06, 0.96, uv.y);
        float gcBend = gcFlex * gcFlex;
        float gcPhase = gcBaseW.x * 0.65 + gcBaseW.z * 0.58 + position.x * 1.9 + position.z * 1.9;
        float gcWave = sin(uTime * (2.1 + uWindStrength * 2.6) + gcPhase) * 0.65
                     + cos(uTime * (3.7 + uWindStrength * 2.2) + gcPhase * 1.6) * 0.35;
        float gcAmp = (0.024 + uWindStrength * 0.088) * ${swayVal} * gcBend;
        // Apply sway in local XZ (rotational variety across instances adds natural turbulent rustle)
        transformed.x += gcWave * gcAmp;
        transformed.z += sin(uTime * 1.85 + gcPhase * 1.3 + 1.4) * gcAmp * 0.72;
        transformed.y -= abs(gcWave) * gcAmp * 0.18;`
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
        #ifdef USE_INSTANCING
          vGcWorldPos = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
          vec3 gcWn = mat3(modelMatrix) * (mat3(instanceMatrix) * objectNormal);
        #else
          vGcWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
          vec3 gcWn = mat3(modelMatrix) * objectNormal;
        #endif
        vGcWorldNormal = dot(gcWn, gcWn) > 1e-8 ? normalize(gcWn) : vec3(0.0, 1.0, 0.0);`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform vec3 uSunDir;
        uniform vec3 uSunColor;
        varying vec3 vGcWorldPos;
        varying vec3 vGcWorldNormal;
        varying float vGcHeightUv;`
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        // Soft soil-contact AO darkening near the plant root crown
        float gcAo = mix(${aoMin}, 1.04, smoothstep(0.0, 0.58, vGcHeightUv));
        diffuseColor.rgb *= gcAo;`
      )
      .replace(
        '#include <normal_fragment_begin>',
        `#include <normal_fragment_begin>
        #ifdef DOUBLE_SIDED
          // Keep crossed ground-cover planes smoothly lit from sky/sun without harsh back-face seams
          vec3 gcVolN = dot(vNormal, vNormal) > 1e-6 ? normalize(vNormal) : normal;
          normal = normalize(mix(gcVolN, normal, 0.22));
        #endif`
      )
      .replace(
        '#include <dithering_fragment>',
        `vec3 gcToCam = cameraPosition - vGcWorldPos;
        vec3 gcVDir = dot(gcToCam, gcToCam) > 1e-8 ? normalize(gcToCam) : vec3(0.0, 0.0, 1.0);
        vec3 gcLDir = dot(uSunDir, uSunDir) > 1e-8 ? normalize(uSunDir) : vec3(0.0, 1.0, 0.0);
        vec3 gcNWorld = dot(vGcWorldNormal, vGcWorldNormal) > 1e-8 ? normalize(vGcWorldNormal) : vec3(0.0, 1.0, 0.0);
        float gcBs = clamp(dot(-gcVDir, gcLDir), 0.0, 1.0);
        float gcBack = gcBs * gcBs * gcBs;
        float gcWrap = clamp(dot(gcNWorld, gcLDir) * 0.45 + 0.55, 0.2, 1.0);
        float gcSss = (gcBack * 0.68 + gcWrap * 0.22) * smoothstep(0.05, 0.72, vGcHeightUv);
        // Attenuate SSS on already-bright petals/straw so HDR bloom never blows flowers out to white
        float gcLuma = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
        float gcSssGuard = clamp(1.12 - gcLuma * 0.95, 0.16, 1.0);
        gl_FragColor.rgb += diffuseColor.rgb * uSunColor * gcSss * gcSssGuard * ${sssVal};
        #include <dithering_fragment>`
      );
  };
}

/**
 * Grounded geological rock shader for boulders, outcrops, river cobbles & scatter stones:
 * - World-space 3D stratified mineral variation so instanced boulders never look cloned
 * - Biome-authentic upward moss cap (humid PNW coast) or dusty alpine lichen patina (Kootenay Rockies)
 * - Soil-line grounding AO + earth blend along the buried base so stones sit naturally in the terrain
 */
export function applyGroundedRockShader(
  mat: THREE.MeshStandardMaterial,
  site: SiteId,
  weather: WeatherId
): void {
  const isRockies = site === 'kootenay_rockies';
  const siteMoss: Record<SiteId, number> = {
    misty_creek: 0.92,
    timber_ridge: 0.85,
    coastal_homestead: 0.72,
    storm_bluff: 0.58,
    pacific_headland: 0.52,
    coastal_town: 0.44,
    kootenay_rockies: 0.16,
  };
  const mossAmt = siteMoss[site];
  const wetness =
    weather === 'light_rain' ? 0.78 : weather === 'coastal_gale' ? 0.52 : weather === 'misty_fog' ? 0.22 : 0.0;
  const soilColor = isRockies ? '#62543d' : '#2e3325';
  const mossColor = isRockies ? '#6f7354' : '#354f27';

  mat.customProgramCacheKey = () => `grounded-rock-${site}-${weather}`;

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uRockMossAmt = { value: mossAmt };
    shader.uniforms.uRockWetness = { value: wetness };
    shader.uniforms.uRockSoilCol = { value: new THREE.Color(soilColor) };
    shader.uniforms.uRockMossCol = { value: new THREE.Color(mossColor) };
    shader.uniforms.uIsRockies = { value: isRockies ? 1.0 : 0.0 };

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vRockWorldPos;
        varying vec3 vRockWorldNormal;
        varying float vRockLocalY;`
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
        vRockLocalY = position.y;
        #ifdef USE_INSTANCING
          vRockWorldPos = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
          vec3 rWn = mat3(modelMatrix) * (mat3(instanceMatrix) * objectNormal);
        #else
          vRockWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
          vec3 rWn = mat3(modelMatrix) * objectNormal;
        #endif
        vRockWorldNormal = dot(rWn, rWn) > 1e-8 ? normalize(rWn) : vec3(0.0, 1.0, 0.0);`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uRockMossAmt;
        uniform float uRockWetness;
        uniform vec3 uRockSoilCol;
        uniform vec3 uRockMossCol;
        uniform float uIsRockies;
        varying vec3 vRockWorldPos;
        varying vec3 vRockWorldNormal;
        varying float vRockLocalY;

        float rkHash3(vec3 p) {
          p = fract(p * vec3(443.897, 441.423, 437.195));
          p += dot(p, p.yzx + 19.19);
          return fract((p.x + p.y) * p.z);
        }
        float rkNoise3(vec3 p) {
          vec3 i = floor(p);
          vec3 f = fract(p);
          vec3 u = f * f * (3.0 - 2.0 * f);
          return mix(
            mix(
              mix(rkHash3(i), rkHash3(i + vec3(1.0, 0.0, 0.0)), u.x),
              mix(rkHash3(i + vec3(0.0, 1.0, 0.0)), rkHash3(i + vec3(1.0, 1.0, 0.0)), u.x),
              u.y
            ),
            mix(
              mix(rkHash3(i + vec3(0.0, 0.0, 1.0)), rkHash3(i + vec3(1.0, 0.0, 1.0)), u.x),
              mix(rkHash3(i + vec3(0.0, 1.0, 1.0)), rkHash3(i + vec3(1.0, 1.0, 1.0)), u.x),
              u.y
            ),
            u.z
          );
        }`
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        // World-space stratified rock variation & mineral mottling (breaks up instanced repetition)
        float rkMacro = rkNoise3(vRockWorldPos * 0.55);
        float rkStrata = rkNoise3(vec3(vRockWorldPos.x * 1.4, vRockWorldPos.y * 4.6, vRockWorldPos.z * 1.4));
        float rkFine = rkNoise3(vRockWorldPos * 4.2 + vec3(5.3, 1.9, 8.7));
        float rkVar = 0.78 + rkMacro * 0.28 + (rkStrata - 0.5) * 0.18 + (rkFine - 0.5) * 0.12;
        vec3 warmMineral = uIsRockies > 0.5 ? vec3(1.05, 0.99, 0.90) : vec3(0.95, 0.98, 0.95);
        vec3 coolMineral = uIsRockies > 0.5 ? vec3(0.86, 0.85, 0.83) : vec3(0.80, 0.84, 0.82);
        diffuseColor.rgb *= rkVar * mix(coolMineral, warmMineral, rkMacro);

        // Crevice / shadow-side darkening & weathered top lightening
        float upDot = clamp(vRockWorldNormal.y, -1.0, 1.0);
        diffuseColor.rgb *= mix(0.76, 1.08, smoothstep(-0.35, 0.82, upDot));

        // Upward-facing PNW velvety moss cap (or alpine lichen flecking in the Rockies)
        float mossNoise = rkNoise3(vRockWorldPos * 1.85 + vec3(3.1, 7.4, 2.2)) * 0.65
                        + rkFine * 0.35;
        float mossMask = smoothstep(0.36, 0.78, upDot + (mossNoise - 0.5) * 0.42)
                       * smoothstep(-0.12, 0.25, vRockLocalY)
                       * uRockMossAmt;
        vec3 mossCol = uRockMossCol * (0.76 + mossNoise * 0.48);
        diffuseColor.rgb = mix(diffuseColor.rgb, mossCol, mossMask * 0.82);

        // Ground-contact soil skirt & ambient occlusion right where the rock emerges from the earth
        float baseBlend = smoothstep(0.18, -0.42, vRockLocalY + (rkFine - 0.5) * 0.16);
        diffuseColor.rgb = mix(diffuseColor.rgb, uRockSoilCol * (0.75 + rkFine * 0.35), baseBlend * 0.65);
        diffuseColor.rgb *= mix(1.0, 0.58, baseBlend);

        // Rain darkening on wet stone
        diffuseColor.rgb *= (1.0 - uRockWetness * 0.22);`
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        float rkRMoss = smoothstep(0.42, 0.78, vRockWorldNormal.y) * uRockMossAmt;
        float rkRSoil = smoothstep(0.16, -0.38, vRockLocalY);
        roughnessFactor = clamp(mix(roughnessFactor, 0.96, max(rkRMoss, rkRSoil)) - uRockWetness * 0.36 * (1.0 - rkRMoss * 0.7), 0.24, 0.98);`
      );
  };
}
