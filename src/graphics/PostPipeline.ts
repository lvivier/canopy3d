import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { SiteId, WeatherId } from '../types';

interface AtmosphereProfile {
  godRayStrength: number;
  godRayDecay: number;
  godRayColor: string;
  bloomStrength: number;
  bloomThreshold: number;
  bloomRadius: number;
  vignetteStrength: number;
  warmth: number;
}

function getAtmosphereProfile(site: SiteId, weather: WeatherId): AtmosphereProfile {
  const isDryAlpine = site === 'kootenay_rockies';
  const isMistyForest = site === 'misty_creek' || site === 'timber_ridge';
  const isCoastalOpen = site === 'storm_bluff' || site === 'pacific_headland';

  if (weather === 'golden_hour') {
    return {
      godRayStrength: isMistyForest ? 0.46 : isDryAlpine ? 0.3 : 0.4,
      godRayDecay: 0.945,
      godRayColor: '#ffd18a',
      bloomStrength: 0.24,
      bloomThreshold: 1.06,
      bloomRadius: 0.55,
      vignetteStrength: 0.18,
      warmth: 0.045,
    };
  }
  if (weather === 'sunny_morning') {
    return {
      godRayStrength: isMistyForest ? 0.36 : isDryAlpine ? 0.22 : 0.28,
      godRayDecay: 0.935,
      godRayColor: '#fff2cc',
      bloomStrength: 0.18,
      bloomThreshold: 1.12,
      bloomRadius: 0.46,
      vignetteStrength: 0.14,
      warmth: isDryAlpine ? 0.02 : 0.01,
    };
  }
  if (weather === 'misty_fog') {
    return {
      godRayStrength: isMistyForest ? 0.38 : 0.28,
      godRayDecay: 0.95,
      godRayColor: '#e4efe9',
      bloomStrength: 0.2,
      bloomThreshold: 1.06,
      bloomRadius: 0.62,
      vignetteStrength: 0.18,
      warmth: -0.015,
    };
  }
  if (weather === 'light_rain') {
    return {
      godRayStrength: 0.12,
      godRayDecay: 0.92,
      godRayColor: '#c9dce0',
      bloomStrength: 0.16,
      bloomThreshold: 1.08,
      bloomRadius: 0.52,
      vignetteStrength: 0.22,
      warmth: -0.03,
    };
  }
  // coastal_gale
  return {
    godRayStrength: isCoastalOpen ? 0.22 : 0.16,
    godRayDecay: 0.93,
    godRayColor: '#d7e6ea',
    bloomStrength: 0.17,
    bloomThreshold: 1.08,
    bloomRadius: 0.52,
    vignetteStrength: 0.22,
    warmth: -0.02,
  };
}

/**
 * Canopy Volumetric God Rays + Henyey-Greenstein Mie Scattering + Filmic Grade pass.
 * Runs in linear HDR before OutputPass (ACES Filmic tone mapping + sRGB encoding).
 */
const CanopyAtmosphereShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uSunScreenPos: { value: new THREE.Vector2(0.5, 0.7) },
    uSunVisible: { value: 0.0 },
    uSunAlign: { value: 0.0 },
    uGodRayStrength: { value: 0.26 },
    uGodRayDecay: { value: 0.94 },
    uGodRayColor: { value: new THREE.Color('#ffd18a') },
    uVignette: { value: 0.16 },
    uWarmth: { value: 0.02 },
    uResolution: { value: new THREE.Vector2(1280, 720) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 uSunScreenPos;
    uniform float uSunVisible;
    uniform float uSunAlign;
    uniform float uGodRayStrength;
    uniform float uGodRayDecay;
    uniform vec3 uGodRayColor;
    uniform float uVignette;
    uniform float uWarmth;
    uniform vec2 uResolution;

    varying vec2 vUv;

    // Interleaved gradient noise for banding-free ray jitter
    float ign(vec2 fragCoord) {
      vec3 magic = vec3(0.06711056, 0.00583715, 52.9829189);
      return fract(magic.z * fract(dot(fragCoord, magic.xy)));
    }

    // Henyey-Greenstein Mie forward-scattering phase (g = 0.72)
    float hgPhase(float cosTheta, float g) {
      float g2 = g * g;
      return (1.0 - g2) / (12.56637 * pow(max(0.05, 1.0 + g2 - 2.0 * g * cosTheta), 1.5));
    }

    // Sanitize HalfFloat HDR pixels before UnrealBloomPass so any single NaN/Inf pixel
    // can never propagate across bloom mipmaps into a flashing black tile!
    vec3 sanitizeHdr(vec3 c) {
      #if __VERSION__ >= 300
        bvec3 bad = bvec3(
          isnan(c.r) || isinf(c.r),
          isnan(c.g) || isinf(c.g),
          isnan(c.b) || isinf(c.b)
        );
        c = mix(c, vec3(0.0), bad);
      #else
        c = vec3(
          (c.r >= 0.0 && c.r < 65000.0) ? c.r : 0.0,
          (c.g >= 0.0 && c.g < 65000.0) ? c.g : 0.0,
          (c.b >= 0.0 && c.b < 65000.0) ? c.b : 0.0
        );
      #endif
      return clamp(c, vec3(0.0), vec3(16.0));
    }

    void main() {
      vec4 base = texture2D(tDiffuse, vUv);
      vec3 col = sanitizeHdr(base.rgb);

      if (uSunVisible > 0.01 && uGodRayStrength > 0.01) {
        const int SAMPLES = 18;
        vec2 deltaUv = (vUv - uSunScreenPos) * (0.86 / float(SAMPLES));
        float jitter = ign(vUv * uResolution);
        vec2 sampleUv = vUv - deltaUv * jitter;

        float illumDecay = 1.0;
        float shafts = 0.0;

        for (int i = 0; i < SAMPLES; i++) {
          sampleUv -= deltaUv;
          vec2 clamped = clamp(sampleUv, vec2(0.001), vec2(0.999));
          vec3 s = sanitizeHdr(texture2D(tDiffuse, clamped).rgb);
          float luma = dot(s, vec3(0.2126, 0.7152, 0.0722));
          // Only bright sky gaps peeking through canopy silhouettes cast shafts
          float skyMask = smoothstep(0.58, 1.32, luma);
          shafts += skyMask * illumDecay;
          illumDecay *= uGodRayDecay;
        }

        shafts /= float(SAMPLES);

        // Radial falloff around projected sun + Henyey-Greenstein forward scattering weight
        vec2 aspectDiff = (vUv - uSunScreenPos) * vec2(uResolution.x / max(1.0, uResolution.y), 1.0);
        float radial = exp(-length(aspectDiff) * 1.45);
        float mie = clamp(hgPhase(uSunAlign, 0.72) * 0.55, 0.2, 1.85);

        col += uGodRayColor * shafts * (0.55 + radial * 1.15) * uGodRayStrength * uSunVisible * mie;
      }

      // Subtle atmospheric temperature balance in linear HDR
      col.r *= (1.0 + uWarmth * 0.6);
      col.b *= (1.0 - uWarmth * 0.55);

      // Gentle photographic edge vignette
      vec2 centered = vUv * 2.0 - 1.0;
      float vig = 1.0 - dot(centered, centered) * uVignette * 0.42;
      col *= clamp(vig, 0.76, 1.0);

      gl_FragColor = vec4(col, base.a);
    }
  `,
};

export class PostPipeline {
  private composer: EffectComposer;
  private renderPass: RenderPass;
  private atmospherePass: ShaderPass;
  private bloomPass: UnrealBloomPass;
  private outputPass: OutputPass;
  private sunWorldDir = new THREE.Vector3(0.5, 0.5, -0.5).normalize();
  private _sunWorldPos = new THREE.Vector3();
  private _sunNdc = new THREE.Vector3();
  private _camForward = new THREE.Vector3();

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
    const size = new THREE.Vector2();
    renderer.getDrawingBufferSize(size);
    const rt = new THREE.WebGLRenderTarget(Math.max(1, size.x), Math.max(1, size.y), {
      type: THREE.HalfFloatType,
      samples: renderer.capabilities.isWebGL2 ? 4 : 0,
    });

    this.composer = new EffectComposer(renderer, rt);
    this.renderPass = new RenderPass(scene, camera);
    this.atmospherePass = new ShaderPass(CanopyAtmosphereShader);
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      0.22,
      0.55,
      0.92
    );
    this.outputPass = new OutputPass();

    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.atmospherePass);
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(this.outputPass);
  }

  public configureEnvironment(site: SiteId, weather: WeatherId, sunDir: THREE.Vector3): void {
    this.sunWorldDir.copy(sunDir).normalize();
    const prof = getAtmosphereProfile(site, weather);
    this.atmospherePass.uniforms.uGodRayStrength.value = prof.godRayStrength;
    this.atmospherePass.uniforms.uGodRayDecay.value = prof.godRayDecay;
    (this.atmospherePass.uniforms.uGodRayColor.value as THREE.Color).set(prof.godRayColor);
    this.atmospherePass.uniforms.uVignette.value = prof.vignetteStrength;
    this.atmospherePass.uniforms.uWarmth.value = prof.warmth;

    this.bloomPass.strength = prof.bloomStrength;
    this.bloomPass.threshold = prof.bloomThreshold;
    this.bloomPass.radius = prof.bloomRadius;
  }

  public setSize(width: number, height: number, pixelRatio: number): void {
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(width, height);
    this.bloomPass.resolution.set(width, height);
    (this.atmospherePass.uniforms.uResolution.value as THREE.Vector2).set(
      width * pixelRatio,
      height * pixelRatio
    );
  }

  public render(camera: THREE.Camera): void {
    // Project distant sun position into screen space for volumetric light shafts
    this._sunWorldPos.copy(camera.position).addScaledVector(this.sunWorldDir, 180);
    this._sunNdc.copy(this._sunWorldPos).project(camera);

    camera.getWorldDirection(this._camForward);
    const sunDot = this._camForward.dot(this.sunWorldDir);

    // Smoothly fade god rays in when looking within ~105° of sun direction
    const visible = THREE.MathUtils.smoothstep(sunDot, -0.15, 0.55);
    const sx = this._sunNdc.x * 0.5 + 0.5;
    const sy = this._sunNdc.y * 0.5 + 0.5;

    (this.atmospherePass.uniforms.uSunScreenPos.value as THREE.Vector2).set(
      THREE.MathUtils.clamp(sx, -0.35, 1.35),
      THREE.MathUtils.clamp(sy, -0.25, 1.35)
    );
    this.atmospherePass.uniforms.uSunVisible.value = visible;
    this.atmospherePass.uniforms.uSunAlign.value = THREE.MathUtils.clamp(sunDot, -1, 1);

    this.composer.render();
  }

  public dispose(): void {
    this.bloomPass.dispose();
    this.composer.renderTarget1.dispose();
    this.composer.renderTarget2.dispose();
    this.composer.dispose();
  }
}
