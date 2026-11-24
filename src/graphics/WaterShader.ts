import * as THREE from 'three';
import { SiteId, WeatherId } from '../types';

export interface WaterShaderConfig {
  site: SiteId;
  weather: WeatherId;
  sunDir: THREE.Vector3;
  sunColor: THREE.Color;
  skyHorizon: THREE.Color;
  skyZenith: THREE.Color;
  fogColor: THREE.Color;
  fogDensity: number;
  windSpeed: number;
}

export interface AnimatedWaterMaterial {
  material: THREE.ShaderMaterial;
  update: (elapsed: number) => void;
}

/**
 * Physically inspired Beer-Lambert coastal, creek & pond water shader for High detail:
 * - Multi-octave Gerstner-inspired wave normals & directional flow
 * - Beer-Lambert spectral absorption from shallow sandy/pebbly bed to deep coastal teal
 * - Procedural shimmering riverbed / cove caustics
 * - Schlick Fresnel sky reflection + crisp sun glint + stormy whitecap foam
 * - Full FogExp2 atmospheric integration
 */
export function createWaterShaderMaterial(cfg: WaterShaderConfig): AnimatedWaterMaterial {
  const isOcean = cfg.site === 'storm_bluff' || cfg.site === 'pacific_headland';
  const isStorm = cfg.site === 'storm_bluff' || cfg.weather === 'coastal_gale';
  const isCreek = cfg.site === 'misty_creek';
  const isPond = cfg.site === 'coastal_town';

  const shallowColor = isCreek
    ? new THREE.Color('#4f8f7e')
    : isPond
      ? new THREE.Color('#276763')
      : cfg.site === 'pacific_headland'
        ? new THREE.Color('#2f858d')
        : new THREE.Color('#2e5868');

  const deepColor = isCreek
    ? new THREE.Color('#193c44')
    : isPond
      ? new THREE.Color('#0f2d33')
      : cfg.site === 'pacific_headland'
        ? new THREE.Color('#0c2f44')
        : new THREE.Color('#102330');

  const bedColor = isCreek
    ? new THREE.Color('#6a624f')
    : isPond
      ? new THREE.Color('#354336')
      : new THREE.Color('#667164');

  const waveScale = isOcean ? 0.14 : isCreek ? 0.65 : 1.45;
  const waveAmp = isStorm ? 0.48 : isOcean ? 0.34 : isCreek ? 0.24 : 0.20;
  const flowDir = isCreek
    ? new THREE.Vector2(1.0, 0.12).normalize()
    : isOcean
      ? new THREE.Vector2(-0.72, -0.68).normalize()
      : new THREE.Vector2(0.4, 0.2).normalize();
  const flowSpeed = isCreek ? 1.55 : isStorm ? 1.25 : isOcean ? 0.72 : 0.42;
  const causticStrength = isCreek ? 0.52 : isPond ? 0.34 : cfg.site === 'pacific_headland' ? 0.24 : 0.08;
  const foamAmount = isStorm ? 0.58 : isCreek ? 0.34 : isOcean ? 0.26 : 0.05;
  const opacity = isOcean ? 0.96 : isCreek ? 0.88 : 0.92;
  const sunGlintStrength =
    cfg.weather === 'misty_fog' || cfg.weather === 'light_rain'
      ? 0.20
      : cfg.weather === 'coastal_gale'
        ? 0.32
        : 1.0;

  const uniforms = {
    uTime: { value: 0 },
    uSunDir: { value: cfg.sunDir.clone().normalize() },
    uSunColor: { value: cfg.sunColor.clone() },
    uSkyHorizon: { value: cfg.skyHorizon.clone() },
    uSkyZenith: { value: cfg.skyZenith.clone() },
    uShallowColor: { value: shallowColor },
    uDeepColor: { value: deepColor },
    uBedColor: { value: bedColor },
    uFogColor: { value: cfg.fogColor.clone() },
    uFogDensity: { value: cfg.fogDensity },
    uWaveScale: { value: waveScale },
    uWaveAmp: { value: waveAmp * (0.85 + cfg.windSpeed * 0.55) },
    uFlowDir: { value: flowDir },
    uFlowSpeed: { value: flowSpeed },
    uCausticStrength: { value: causticStrength },
    uFoamAmount: { value: foamAmount },
    uOpacity: { value: opacity },
    uIsOcean: { value: isOcean ? 1.0 : 0.0 },
    uIsStream: { value: isCreek ? 1.0 : 0.0 },
    uSunGlintStrength: { value: sunGlintStrength },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    transparent: !isOcean,
    depthWrite: isOcean,
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform float uWaveScale;
      uniform float uWaveAmp;
      uniform vec2 uFlowDir;
      uniform float uFlowSpeed;
      uniform float uIsOcean;

      varying vec3 vWorldPos;
      varying vec2 vStreamUv;
      varying float vWaveCrest;

      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        // Subtle vertex swell on ocean surfaces
        float crest = 0.0;
        if (uIsOcean > 0.5) {
          vec2 p = wp.xz * uWaveScale;
          float t = uTime * uFlowSpeed;
          float w1 = sin(dot(p, vec2(1.0, 0.7)) + t * 1.4);
          float w2 = sin(dot(p, vec2(-0.6, 1.1)) + t * 1.85);
          float disp = (w1 * 0.55 + w2 * 0.35) * uWaveAmp * 0.42;
          wp.y += disp;
          crest = clamp((w1 + w2) * 0.35 + 0.35, 0.0, 1.0);
        }
        vWaveCrest = crest;
        vWorldPos = wp.xyz;
        vStreamUv = uv;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uSunDir;
      uniform vec3 uSunColor;
      uniform vec3 uSkyHorizon;
      uniform vec3 uSkyZenith;
      uniform vec3 uShallowColor;
      uniform vec3 uDeepColor;
      uniform vec3 uBedColor;
      uniform vec3 uFogColor;
      uniform float uFogDensity;
      uniform float uWaveScale;
      uniform float uWaveAmp;
      uniform vec2 uFlowDir;
      uniform float uFlowSpeed;
      uniform float uCausticStrength;
      uniform float uFoamAmount;
      uniform float uOpacity;
      uniform float uIsOcean;
      uniform float uIsStream;
      uniform float uSunGlintStrength;

      varying vec3 vWorldPos;
      varying vec2 vStreamUv;
      varying float vWaveCrest;

      float hash21(vec2 p) {
        p = fract(p * vec2(234.34, 435.345));
        p += dot(p, p + 34.23);
        return fract(p.x * p.y);
      }

      float vnoise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        float a = hash21(i);
        float b = hash21(i + vec2(1.0, 0.0));
        float c = hash21(i + vec2(0.0, 1.0));
        float d = hash21(i + vec2(1.0, 1.0));
        return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
      }

      float waveHeight(vec2 xz, float t) {
        vec2 p = xz * uWaveScale;
        vec2 drift1 = uFlowDir * t * uFlowSpeed;
        vec2 drift2 = vec2(-uFlowDir.y, uFlowDir.x) * t * uFlowSpeed * 0.65;
        float h = 0.0;
        h += vnoise(p * 1.15 + drift1 * 0.9) * 0.55;
        h += vnoise(p * 2.45 - drift2 * 1.3 + vec2(4.7, 2.3)) * 0.30;
        h += vnoise(p * 5.2 + drift1 * 2.1 - vec2(1.9, 6.1)) * 0.15;
        return h;
      }

      float causticPattern(vec2 xz, float t) {
        vec2 p = xz * (uIsOcean > 0.5 ? 0.42 : 1.45) + uFlowDir * t * uFlowSpeed * 0.45;
        float n1 = vnoise(p * 2.3 + vec2(t * 0.35, -t * 0.25));
        float n2 = vnoise(p * 3.1 - vec2(t * 0.28, t * 0.42) + n1 * 1.1);
        float ridge = 1.0 - abs(n2 * 2.0 - 1.0);
        float r = clamp(ridge, 0.0, 1.0);
        float r2 = r * r;
        return r2 * r2;
      }

      float streamWaveHeight(vec2 suv, float t) {
        // suv.x is arc-length along meandering channel (meters), suv.y is across-bank [0..1]
        // Faster flow in mid-channel thalweg, gentler eddies along mossy banks
        float bankT = min(suv.y, 1.0 - suv.y) * 2.0;
        float speedScale = mix(0.62, 1.18, smoothstep(0.0, 0.7, bankT));
        float flow = t * uFlowSpeed * speedScale;
        vec2 p = vec2(suv.x * 0.55 - flow * 1.05, suv.y * 4.4);
        vec2 p2 = vec2(suv.x * 1.25 - flow * 1.65, suv.y * 8.2 + sin(suv.x * 0.45) * 0.4);
        float h = 0.0;
        h += vnoise(p * 1.15) * 0.50;
        h += vnoise(p2 + vec2(3.1, 1.7)) * 0.32;
        h += vnoise(vec2(suv.x * 2.6 - flow * 2.25, suv.y * 14.0)) * 0.18;
        return h;
      }

      void main() {
        float t = uTime;
        float eps = uIsOcean > 0.5 ? 0.28 : 0.09;
        float hC;
        float hX;
        float hZ;
        if (uIsStream > 0.5) {
          hC = streamWaveHeight(vStreamUv, t);
          hX = streamWaveHeight(vStreamUv + vec2(eps, 0.0), t);
          hZ = streamWaveHeight(vStreamUv + vec2(0.0, eps * 0.18), t);
        } else {
          hC = waveHeight(vWorldPos.xz, t);
          hX = waveHeight(vWorldPos.xz + vec2(eps, 0.0), t);
          hZ = waveHeight(vWorldPos.xz + vec2(0.0, eps), t);
        }

        vec3 N = normalize(vec3(
          ((hC - hX) / eps) * uWaveAmp * 0.45,
          1.0,
          ((hC - hZ) / eps) * uWaveAmp * 0.45
        ));
        vec3 V = normalize(cameraPosition - vWorldPos);
        vec3 L = normalize(uSunDir);

        // Estimate optical water depth for Beer-Lambert absorption
        float distFromCenter = length(vWorldPos.xz);
        float streamEdge = uIsStream > 0.5 ? clamp(min(vStreamUv.y, 1.0 - vStreamUv.y) * 2.0, 0.0, 1.0) : 1.0;
        float depth = uIsOcean > 0.5
          ? clamp((distFromCenter - 26.0) * 0.14, 0.35, 9.5)
          : uIsStream > 0.5
            ? clamp(mix(0.14, 1.65, smoothstep(0.0, 0.85, streamEdge)) + (hC - 0.5) * 0.28, 0.12, 2.0)
            : clamp(0.65 + hC * 0.75, 0.35, 2.4);

        // Beer-Lambert transmittance (red absorbs first, teal/blue survives)
        vec3 absorb = vec3(0.46, 0.14, 0.08);
        vec3 transmittance = exp(-absorb * depth);

        // Shimmering riverbed / shallow cove caustics (curved along stream when uIsStream > 0.5)
        vec2 caustCoord = uIsStream > 0.5
          ? vec2(vStreamUv.x * 0.65 - t * uFlowSpeed * 0.75, vStreamUv.y * 4.2) + N.xz * 0.35
          : vWorldPos.xz + N.xz * 0.65;
        float caust = causticPattern(caustCoord, t) * uCausticStrength;
        vec3 refractedBed = (uBedColor * (0.7 + 0.3 * max(dot(vec3(0.0, 1.0, 0.0), L), 0.15))) + uSunColor * caust * 0.65;
        vec3 waterBody = mix(uDeepColor, uShallowColor, clamp(transmittance.g, 0.0, 1.0));
        vec3 underwater = mix(waterBody, refractedBed * waterBody * 1.45, clamp(transmittance.r * 0.72, 0.0, 0.75));

        // Schlick Fresnel sky reflection (inland creeks/ponds sit under canopy, so soften reflection)
        float ndotv = clamp(dot(N, V), 0.0, 1.0);
        float fresBase = clamp(1.0 - ndotv, 0.0, 1.0);
        float fresnel = 0.03 + 0.62 * (fresBase > 1e-4 ? pow(fresBase, 4.2) : 0.0);
        vec3 R = reflect(-V, N);
        float skyT = clamp(R.y * 0.8 + 0.18, 0.0, 1.0);
        vec3 skyRefl = mix(uSkyHorizon, uSkyZenith, skyT > 1e-4 ? pow(skyT, 0.65) : 0.0);
        skyRefl *= mix(0.54, 0.92, uIsOcean);

        // Crisp sun specular glitter (attenuated under canopy / overcast skies so ponds never blow out)
        vec3 hSum = L + V;
        vec3 H = dot(hSum, hSum) > 1e-6 ? normalize(hSum) : vec3(0.0, 1.0, 0.0);
        float ndoth = clamp(dot(N, H), 0.0, 1.0);
        float specTight = (ndoth > 1e-4 ? pow(ndoth, 380.0) : 0.0) * mix(0.45, 0.95, uIsOcean);
        float specBroad = (ndoth > 1e-4 ? pow(ndoth, 56.0) : 0.0) * mix(0.06, 0.14, uIsOcean);
        vec3 sunGlint = uSunColor * (specTight + specBroad) * uSunGlintStrength;

        // Subtle animated foam crests, downstream riffles, & organic bank-edge shoreline foam
        vec2 foamCoord = uIsStream > 0.5
          ? vec2(vStreamUv.x * 1.15 - t * uFlowSpeed * 1.35, vStreamUv.y * 7.5)
          : vWorldPos.xz * (uIsOcean > 0.5 ? 0.55 : 2.6) + uFlowDir * t * uFlowSpeed * 1.2;
        float foamNoise = vnoise(foamCoord);
        float crestFoam = smoothstep(0.60, 0.86, hC * 0.75 + vWaveCrest * 0.4 + foamNoise * 0.25) * uFoamAmount;
        float bankEdgeFoam = 0.0;
        float alpha = uOpacity;
        if (uIsStream > 0.5) {
          float edgeWave = (vnoise(vec2(vStreamUv.x * 1.8 - t * 0.45, vStreamUv.y * 3.0)) - 0.5) * 0.12;
          float eDist = streamEdge + edgeWave;
          // Soft organic shoreline feather into the wet pebble bank skirt
          alpha = uOpacity * smoothstep(0.0, 0.18, eDist) * mix(0.68, 1.0, smoothstep(0.08, 0.55, streamEdge));
          // Delicate frothy edge ripple where shallow water laps mossy bank stones
          float lapBand = smoothstep(0.03, 0.13, eDist) * (1.0 - smoothstep(0.15, 0.36, eDist));
          float lapNoise = vnoise(vec2(vStreamUv.x * 2.4 - t * uFlowSpeed * 0.9, vStreamUv.y * 9.0));
          bankEdgeFoam = lapBand * smoothstep(0.36, 0.74, lapNoise) * 0.52;
        }
        vec3 foamColor = mix(uSkyHorizon, vec3(0.95, 0.97, 0.98), 0.65);

        float maxFresnel = mix(0.36, 0.66, uIsOcean);
        vec3 color = mix(underwater, skyRefl, clamp(fresnel, 0.05, maxFresnel)) + sunGlint;
        color = mix(color, foamColor, clamp((crestFoam + bankEdgeFoam) * 0.60, 0.0, 0.65));

        // Exponential distance fog matching Three.js FogExp2
        float camDist = length(cameraPosition - vWorldPos);
        float fogFactor = 1.0 - exp(-uFogDensity * uFogDensity * camDist * camDist);
        color = mix(color, uFogColor, clamp(fogFactor, 0.0, 1.0));

        gl_FragColor = vec4(color, alpha);
      }
    `,
  });

  return {
    material,
    update: (elapsed: number) => {
      uniforms.uTime.value = elapsed;
    },
  };
}
