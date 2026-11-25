import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { FullScreenQuad, Pass } from 'three/examples/jsm/postprocessing/Pass.js';
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

const FULLSCREEN_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SANITIZE_GLSL = /* glsl */ `
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
`;

/**
 * God rays march at half resolution. The grade (sanitize, warmth, vignette) stays full-res
 * so bloom still receives clean linear HDR. Shafts are a soft effect and do not need
 * a per-pixel 18-tap walk of the full framebuffer.
 */
class CanopyAtmospherePass extends Pass {
  readonly uniforms = {
    uSunScreenPos: { value: new THREE.Vector2(0.5, 0.7) },
    uSunVisible: { value: 0.0 },
    uSunAlign: { value: 0.0 },
    uGodRayStrength: { value: 0.26 },
    uGodRayDecay: { value: 0.94 },
    uGodRayColor: { value: new THREE.Color('#ffd18a') },
    uVignette: { value: 0.16 },
    uWarmth: { value: 0.02 },
    uResolution: { value: new THREE.Vector2(640, 360) },
  };

  private halfTarget: THREE.WebGLRenderTarget;
  private shaftsTarget: THREE.WebGLRenderTarget;
  private downsampleMaterial: THREE.ShaderMaterial;
  private shaftsMaterial: THREE.ShaderMaterial;
  private compositeMaterial: THREE.ShaderMaterial;
  private fsQuad: FullScreenQuad;

  constructor() {
    super();
    const rtOpts: THREE.RenderTargetOptions = {
      type: THREE.HalfFloatType,
      depthBuffer: false,
      stencilBuffer: false,
    };
    this.halfTarget = new THREE.WebGLRenderTarget(1, 1, rtOpts);
    this.shaftsTarget = new THREE.WebGLRenderTarget(1, 1, rtOpts);

    this.downsampleMaterial = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null } },
      depthTest: false,
      depthWrite: false,
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse;
        varying vec2 vUv;
        ${SANITIZE_GLSL}
        void main() {
          gl_FragColor = vec4(sanitizeHdr(texture2D(tDiffuse, vUv).rgb), 1.0);
        }
      `,
    });

    this.shaftsMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        uSunScreenPos: this.uniforms.uSunScreenPos,
        uSunVisible: this.uniforms.uSunVisible,
        uSunAlign: this.uniforms.uSunAlign,
        uGodRayStrength: this.uniforms.uGodRayStrength,
        uGodRayDecay: this.uniforms.uGodRayDecay,
        uGodRayColor: this.uniforms.uGodRayColor,
        uResolution: this.uniforms.uResolution,
      },
      depthTest: false,
      depthWrite: false,
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse;
        uniform vec2 uSunScreenPos;
        uniform float uSunVisible;
        uniform float uSunAlign;
        uniform float uGodRayStrength;
        uniform float uGodRayDecay;
        uniform vec3 uGodRayColor;
        uniform vec2 uResolution;
        varying vec2 vUv;

        float ign(vec2 fragCoord) {
          vec3 magic = vec3(0.06711056, 0.00583715, 52.9829189);
          return fract(magic.z * fract(dot(fragCoord, magic.xy)));
        }

        float hgPhase(float cosTheta, float g) {
          float g2 = g * g;
          return (1.0 - g2) / (12.56637 * pow(max(0.05, 1.0 + g2 - 2.0 * g * cosTheta), 1.5));
        }

        void main() {
          const int SAMPLES = 10;
          vec2 deltaUv = (vUv - uSunScreenPos) * (0.86 / float(SAMPLES));
          float jitter = ign(vUv * uResolution);
          vec2 sampleUv = vUv - deltaUv * jitter;

          float illumDecay = 1.0;
          float shafts = 0.0;
          for (int i = 0; i < SAMPLES; i++) {
            sampleUv -= deltaUv;
            vec2 clamped = clamp(sampleUv, vec2(0.001), vec2(0.999));
            float luma = dot(texture2D(tDiffuse, clamped).rgb, vec3(0.2126, 0.7152, 0.0722));
            float skyMask = smoothstep(0.58, 1.32, luma);
            shafts += skyMask * illumDecay;
            illumDecay *= uGodRayDecay;
          }
          shafts /= float(SAMPLES);

          vec2 aspectDiff = (vUv - uSunScreenPos) * vec2(uResolution.x / max(1.0, uResolution.y), 1.0);
          float radial = exp(-length(aspectDiff) * 1.45);
          float mie = clamp(hgPhase(uSunAlign, 0.72) * 0.55, 0.2, 1.85);
          vec3 col = uGodRayColor * shafts * (0.55 + radial * 1.15) * uGodRayStrength * uSunVisible * mie;
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });

    this.compositeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        tShafts: { value: null },
        uSunVisible: this.uniforms.uSunVisible,
        uGodRayStrength: this.uniforms.uGodRayStrength,
        uVignette: this.uniforms.uVignette,
        uWarmth: this.uniforms.uWarmth,
      },
      depthTest: false,
      depthWrite: false,
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse;
        uniform sampler2D tShafts;
        uniform float uSunVisible;
        uniform float uGodRayStrength;
        uniform float uVignette;
        uniform float uWarmth;
        varying vec2 vUv;
        ${SANITIZE_GLSL}
        void main() {
          vec4 base = texture2D(tDiffuse, vUv);
          vec3 col = sanitizeHdr(base.rgb);
          if (uSunVisible > 0.01 && uGodRayStrength > 0.01) {
            col += texture2D(tShafts, vUv).rgb;
          }
          col.r *= (1.0 + uWarmth * 0.6);
          col.b *= (1.0 - uWarmth * 0.55);
          vec2 centered = vUv * 2.0 - 1.0;
          float vig = 1.0 - dot(centered, centered) * uVignette * 0.42;
          col *= clamp(vig, 0.76, 1.0);
          gl_FragColor = vec4(col, base.a);
        }
      `,
    });

    this.fsQuad = new FullScreenQuad(this.compositeMaterial);
  }

  public override setSize(width: number, height: number): void {
    const w = Math.max(1, Math.floor(width / 2));
    const h = Math.max(1, Math.floor(height / 2));
    this.halfTarget.setSize(w, h);
    this.shaftsTarget.setSize(w, h);
    this.uniforms.uResolution.value.set(w, h);
  }

  public override render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget
  ): void {
    const sunOn = this.uniforms.uSunVisible.value > 0.01 && this.uniforms.uGodRayStrength.value > 0.01;
    if (sunOn) {
      this.downsampleMaterial.uniforms.tDiffuse.value = readBuffer.texture;
      this.fsQuad.material = this.downsampleMaterial;
      renderer.setRenderTarget(this.halfTarget);
      this.fsQuad.render(renderer);

      this.shaftsMaterial.uniforms.tDiffuse.value = this.halfTarget.texture;
      this.fsQuad.material = this.shaftsMaterial;
      renderer.setRenderTarget(this.shaftsTarget);
      this.fsQuad.render(renderer);
    }

    this.compositeMaterial.uniforms.tDiffuse.value = readBuffer.texture;
    this.compositeMaterial.uniforms.tShafts.value = this.shaftsTarget.texture;
    this.fsQuad.material = this.compositeMaterial;
    if (this.renderToScreen) {
      renderer.setRenderTarget(null);
    } else {
      renderer.setRenderTarget(writeBuffer);
      if (this.clear) renderer.clear(renderer.autoClearColor, renderer.autoClearDepth, renderer.autoClearStencil);
    }
    this.fsQuad.render(renderer);
  }

  public override dispose(): void {
    this.downsampleMaterial.dispose();
    this.shaftsMaterial.dispose();
    this.compositeMaterial.dispose();
    this.halfTarget.dispose();
    this.shaftsTarget.dispose();
    this.fsQuad.dispose();
  }
}

const COC_GLSL = /* glsl */ `
  uniform sampler2D tDepth;
  uniform float uFocus;
  uniform float uSharp;
  uniform float uFalloff;
  uniform float uNear;
  uniform float uFar;

  float cocAt(vec2 uv) {
    float depth = texture2D(tDepth, uv).x;
    float viewZ = (uNear * uFar) / ((uFar - uNear) * depth - uFar);
    float dist = -viewZ;
    return smoothstep(uSharp, uSharp + uFalloff, dist - uFocus);
  }
`;

/**
 * A quiet background soften for the close trunk cut. The kerf stays sharp.
 * Farther scenery only loses a little detail, enough to narrow attention
 * without reading as a lens or a sparkle.
 */
class CutFocusPass extends Pass {
  strength = 0;
  focusDistance = 8;

  private readonly scene: THREE.Scene;
  private readonly camera: THREE.Camera;
  private readonly shared = {
    tDepth: { value: null as THREE.Texture | null },
    uFocus: { value: 8 },
    uSharp: { value: 0.9 },
    uFalloff: { value: 9 },
    uNear: { value: 0.25 },
    uFar: { value: 400 },
    uStrength: { value: 0 },
  };

  private readonly halfA: THREE.WebGLRenderTarget;
  private readonly halfB: THREE.WebGLRenderTarget;
  private readonly downsampleMaterial: THREE.ShaderMaterial;
  private readonly gaussianMaterial: THREE.ShaderMaterial;
  private readonly compositeMaterial: THREE.ShaderMaterial;
  private readonly copyMaterial: THREE.ShaderMaterial;
  private readonly fsQuad: FullScreenQuad;

  constructor(scene: THREE.Scene, camera: THREE.Camera) {
    super();
    this.scene = scene;
    this.camera = camera;
    this.enabled = false;
    this.needsSwap = true;

    const rtOpts: THREE.RenderTargetOptions = {
      type: THREE.HalfFloatType,
      depthBuffer: false,
      stencilBuffer: false,
      magFilter: THREE.LinearFilter,
      minFilter: THREE.LinearFilter,
    };
    this.halfA = new THREE.WebGLRenderTarget(1, 1, rtOpts);
    this.halfB = new THREE.WebGLRenderTarget(1, 1, rtOpts);

    const cocUniforms = {
      tDepth: this.shared.tDepth,
      uFocus: this.shared.uFocus,
      uSharp: this.shared.uSharp,
      uFalloff: this.shared.uFalloff,
      uNear: this.shared.uNear,
      uFar: this.shared.uFar,
      uStrength: this.shared.uStrength,
    };

    this.downsampleMaterial = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, ...cocUniforms },
      depthTest: false,
      depthWrite: false,
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse;
        uniform float uStrength;
        varying vec2 vUv;
        ${COC_GLSL}
        void main() {
          float coc = cocAt(vUv) * uStrength;
          vec3 color = texture2D(tDiffuse, vUv).rgb;
          gl_FragColor = vec4(color * coc, coc);
        }
      `,
    });

    // Separable gaussian. Equal weights on both axes, so bright gaps stay
    // soft smudges instead of four-point stars.
    this.gaussianMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tInput: { value: null },
        uDirection: { value: new THREE.Vector2(1, 0) },
      },
      depthTest: false,
      depthWrite: false,
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: /* glsl */ `
        uniform sampler2D tInput;
        uniform vec2 uDirection;
        varying vec2 vUv;
        void main() {
          vec4 c = texture2D(tInput, vUv) * 0.266346;
          c += texture2D(tInput, vUv + uDirection) * 0.213388;
          c += texture2D(tInput, vUv - uDirection) * 0.213388;
          c += texture2D(tInput, vUv + uDirection * 2.0) * 0.109428;
          c += texture2D(tInput, vUv - uDirection * 2.0) * 0.109428;
          c += texture2D(tInput, vUv + uDirection * 3.0) * 0.044098;
          c += texture2D(tInput, vUv - uDirection * 3.0) * 0.044098;
          gl_FragColor = c;
        }
      `,
    });

    this.compositeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tSharp: { value: null },
        tBlur: { value: null },
        ...cocUniforms,
      },
      depthTest: false,
      depthWrite: false,
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: /* glsl */ `
        uniform sampler2D tSharp;
        uniform sampler2D tBlur;
        uniform float uStrength;
        varying vec2 vUv;
        ${COC_GLSL}
        ${SANITIZE_GLSL}
        void main() {
          float coc = cocAt(vUv) * uStrength;
          vec3 sharp = texture2D(tSharp, vUv).rgb;
          vec4 blurred = texture2D(tBlur, vUv);
          vec3 soft = blurred.a > 0.02 ? blurred.rgb / blurred.a : sharp;
          float coverage = smoothstep(0.04, 0.3, blurred.a);
          // A partial mix: the yard stays readable, just no longer competing.
          float w = smoothstep(0.06, 0.8, coc) * coverage * 0.58;
          gl_FragColor = vec4(sanitizeHdr(mix(sharp, soft, w)), 1.0);
        }
      `,
    });

    this.copyMaterial = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null } },
      depthTest: false,
      depthWrite: false,
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse;
        varying vec2 vUv;
        void main() {
          gl_FragColor = texture2D(tDiffuse, vUv);
        }
      `,
    });

    this.fsQuad = new FullScreenQuad(this.compositeMaterial);
  }

  public override setSize(width: number, height: number): void {
    const w = Math.max(1, Math.floor(width / 2));
    const h = Math.max(1, Math.floor(height / 2));
    this.halfA.setSize(w, h);
    this.halfB.setSize(w, h);
  }

  public override render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget
  ): void {
    const output = this.renderToScreen ? null : writeBuffer;
    const depth = readBuffer.depthTexture;
    if (!depth) {
      this.copyMaterial.uniforms.tDiffuse.value = readBuffer.texture;
      this.blit(renderer, this.copyMaterial, output);
      this.drawOverlays(renderer, output);
      return;
    }

    const lens = this.camera as THREE.PerspectiveCamera;
    this.shared.tDepth.value = depth;
    this.shared.uFocus.value = this.focusDistance;
    this.shared.uNear.value = lens.near;
    this.shared.uFar.value = lens.far;
    this.shared.uStrength.value = this.strength;

    this.downsampleMaterial.uniforms.tDiffuse.value = readBuffer.texture;
    this.blit(renderer, this.downsampleMaterial, this.halfA);

    // A short pixel step. Far scenery softens; it does not melt.
    const step = 1.4 + 2.2 * this.strength;
    const dir = this.gaussianMaterial.uniforms.uDirection.value as THREE.Vector2;
    this.gaussianMaterial.uniforms.tInput.value = this.halfA.texture;
    dir.set(step / this.halfA.width, 0);
    this.blit(renderer, this.gaussianMaterial, this.halfB);
    this.gaussianMaterial.uniforms.tInput.value = this.halfB.texture;
    dir.set(0, step / this.halfB.height);
    this.blit(renderer, this.gaussianMaterial, this.halfA);

    this.compositeMaterial.uniforms.tSharp.value = readBuffer.texture;
    this.compositeMaterial.uniforms.tBlur.value = this.halfA.texture;
    this.blit(renderer, this.compositeMaterial, output);
    this.drawOverlays(renderer, output);
  }

  private blit(
    renderer: THREE.WebGLRenderer,
    material: THREE.ShaderMaterial,
    target: THREE.WebGLRenderTarget | null
  ): void {
    this.fsQuad.material = material;
    renderer.setRenderTarget(target);
    this.fsQuad.render(renderer);
  }

  /**
   * The saw, cut ring, and lean arrow live on layer 1 for this frame so the
   * beauty pass does not bake them into the blur. Draw them back on top,
   * still in linear HDR, before grade and bloom.
   */
  private drawOverlays(
    renderer: THREE.WebGLRenderer,
    target: THREE.WebGLRenderTarget | null
  ): void {
    const prevMask = this.camera.layers.mask;
    const prevBackground = this.scene.background;
    const prevAutoClear = renderer.autoClear;
    const prevShadows = renderer.shadowMap.autoUpdate;
    this.camera.layers.set(1);
    this.scene.background = null;
    renderer.autoClear = false;
    renderer.shadowMap.autoUpdate = false;
    try {
      renderer.setRenderTarget(target);
      renderer.clearDepth();
      renderer.render(this.scene, this.camera);
    } finally {
      this.camera.layers.mask = prevMask;
      this.scene.background = prevBackground;
      renderer.autoClear = prevAutoClear;
      renderer.shadowMap.autoUpdate = prevShadows;
    }
  }

  public override dispose(): void {
    this.downsampleMaterial.dispose();
    this.gaussianMaterial.dispose();
    this.compositeMaterial.dispose();
    this.copyMaterial.dispose();
    this.halfA.dispose();
    this.halfB.dispose();
    this.fsQuad.dispose();
  }
}

export class PostPipeline {
  private composer: EffectComposer;
  private renderPass: RenderPass;
  private cutFocusPass: CutFocusPass;
  private atmospherePass: CanopyAtmospherePass;
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
      // 2x MSAA on the HDR target. 4x at retina DPR was most of the scene bandwidth,
      // and alpha-tested foliage still gets a clean edge at 2x.
      samples: renderer.capabilities.isWebGL2 ? 2 : 0,
    });

    this.composer = new EffectComposer(renderer, rt);
    // Sampled only while a trunk cut is open. Unique textures so the two
    // ping-pong targets do not share one depth buffer.
    this.composer.renderTarget1.depthTexture = new THREE.DepthTexture(rt.width, rt.height);
    this.composer.renderTarget2.depthTexture = new THREE.DepthTexture(rt.width, rt.height);
    this.composer.renderTarget1.resolveDepthBuffer = false;
    this.composer.renderTarget2.resolveDepthBuffer = false;

    this.renderPass = new RenderPass(scene, camera);
    this.cutFocusPass = new CutFocusPass(scene, camera);
    this.atmospherePass = new CanopyAtmospherePass();
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      0.22,
      0.55,
      0.92
    );
    this.outputPass = new OutputPass();

    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.cutFocusPass);
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

  /**
   * `amount` is 0..1 and already easing. The pass shapes it again so the
   * aperture opens gently, then resolves scene depth only while it is open.
   */
  public setCutFocus(amount: number, focusDistance: number): void {
    const open = amount > 0.004;
    const shaped = amount * amount * (3 - 2 * amount);
    this.cutFocusPass.strength = shaped;
    this.cutFocusPass.focusDistance = focusDistance;
    this.cutFocusPass.enabled = open;
    this.composer.renderTarget1.resolveDepthBuffer = open;
    this.composer.renderTarget2.resolveDepthBuffer = open;
  }

  public setSize(width: number, height: number, pixelRatio: number): void {
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(width, height);
    // UnrealBloomPass.setSize halves again, so this starts the mip chain at quarter-res.
    // The glow is a soft 0.16–0.24 add and does not need a half-4K blur.
    const bloomW = Math.max(1, Math.floor(width * pixelRatio * 0.5));
    const bloomH = Math.max(1, Math.floor(height * pixelRatio * 0.5));
    this.bloomPass.setSize(bloomW, bloomH);
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
    this.cutFocusPass.dispose();
    this.composer.renderTarget1.depthTexture?.dispose();
    this.composer.renderTarget2.depthTexture?.dispose();
    this.atmospherePass.dispose();
    this.bloomPass.dispose();
    this.composer.renderTarget1.dispose();
    this.composer.renderTarget2.dispose();
    this.composer.dispose();
  }
}
