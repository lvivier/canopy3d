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

  mat.customProgramCacheKey = () =>
    `bark-surface-${hasCut ? 'cut-' : ''}${opts.site}-${opts.weather}-${Math.round(mossAmount * 10)}`;

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
    `;

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
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
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
