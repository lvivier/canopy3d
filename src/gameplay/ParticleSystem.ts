import * as THREE from 'three';
import { GraphicsQuality, SiteId, WeatherId } from '../types';

interface DynamicParticle {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  rotVel: THREE.Vector3;
  age: number;
  life: number;
  gravity: number;
  drag: number;
  startScale: number;
  endScale: number;
}

interface DustPuff {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  age: number;
  life: number;
  startSize: number;
  endSize: number;
  rot: number;
  rotSpeed: number;
  seed: number;
  color: THREE.Color;
  opacity: number;
  drag: number;
  buoyancy: number;
}

interface ImpactMote {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  age: number;
  life: number;
  size: number;
  color: THREE.Color;
}

const MAX_DUST_PUFFS = 220;
const MAX_IMPACT_MOTES = 240;

interface FallingBranch {
  group: THREE.Object3D;
  velY: number;
  restY: number;
  settled: boolean;
}

interface RollingLogSegment {
  group: THREE.Object3D;
  vel: THREE.Vector3;
  rollAxis: THREE.Vector3; // world longitudinal axis of the cylinder
  lateralAxis: THREE.Vector3; // world horizontal perpendicular roll direction
  restY: number;
  rollSign: number;
  yawSpin: number;
  settled: boolean;
}

interface FallingTopSection {
  pivot: THREE.Group;
  vel: THREE.Vector3;
  tipAxis: THREE.Vector3;
  tipSpeed: number;
  age: number;
  foliageColors: string[];
  woodColor: string;
}

export class ParticleSystem {
  private scene: THREE.Scene;
  private particles: DynamicParticle[] = [];
  private dustPuffs: DustPuff[] = [];
  private impactMotes: ImpactMote[] = [];
  private fallingBranches: FallingBranch[] = [];
  private rollingLogs: RollingLogSegment[] = [];
  private fallingTopSections: FallingTopSection[] = [];
  private ambientMotes: THREE.Points;
  private ambientMoteMat!: THREE.ShaderMaterial;
  private rainLines: THREE.LineSegments;
  private rainDrops: Array<{ x: number; y: number; z: number; speed: number; len: number }> = [];
  private weather: WeatherId = 'sunny_morning';
  private site: SiteId = 'coastal_homestead';
  private quality: GraphicsQuality = 'high';
  private chipGeo = new THREE.BoxGeometry(0.11, 0.05, 0.08);
  private leafGeo = new THREE.ConeGeometry(0.16, 0.28, 4);

  // GPU-instanced procedural FBM shader dust plumes (single draw call!)
  private dustCloudMesh: THREE.Mesh;
  private dustCloudGeo: THREE.InstancedBufferGeometry;
  private dustCloudMat: THREE.ShaderMaterial;
  private dustCenterBuf = new Float32Array(MAX_DUST_PUFFS * 3);
  private dustParamsBuf = new Float32Array(MAX_DUST_PUFFS * 4);
  private dustColorBuf = new Float32Array(MAX_DUST_PUFFS * 3);
  private dustOpacityBuf = new Float32Array(MAX_DUST_PUFFS);

  // Soft radial-gradient hovering impact dust motes (single Points draw call!)
  private impactMotePoints: THREE.Points;
  private impactMoteMat: THREE.ShaderMaterial;
  private motePosBuf = new Float32Array(MAX_IMPACT_MOTES * 3);
  private moteColorBuf = new Float32Array(MAX_IMPACT_MOTES * 3);
  private moteParamBuf = new Float32Array(MAX_IMPACT_MOTES * 2); // [size, alpha]

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.ambientMotes = this.createAmbientMotes();
    this.scene.add(this.ambientMotes);
    this.rainLines = this.createRainLines();
    this.rainLines.visible = false;
    this.scene.add(this.rainLines);

    const { mesh, geo, mat } = this.createDustCloudSystem();
    this.dustCloudMesh = mesh;
    this.dustCloudGeo = geo;
    this.dustCloudMat = mat;
    this.scene.add(this.dustCloudMesh);

    const motes = this.createImpactMoteSystem();
    this.impactMotePoints = motes.points;
    this.impactMoteMat = motes.mat;
    this.scene.add(this.impactMotePoints);
  }

  public setEnvironmentContext(opts: {
    site: SiteId;
    weather: WeatherId;
    quality: GraphicsQuality;
    sunDir: THREE.Vector3;
    sunColor: THREE.Color;
    ambientColor: THREE.Color;
    fogColor: THREE.Color;
    fogDensity: number;
  }): void {
    this.site = opts.site;
    this.quality = opts.quality;
    this.setWeather(opts.weather);
    (this.dustCloudMat.uniforms.uSunDir.value as THREE.Vector3).copy(opts.sunDir).normalize();
    (this.dustCloudMat.uniforms.uSunColor.value as THREE.Color).copy(opts.sunColor);
    (this.dustCloudMat.uniforms.uAmbientColor.value as THREE.Color).copy(opts.ambientColor);
    (this.dustCloudMat.uniforms.uFogColor.value as THREE.Color).copy(opts.fogColor);
    this.dustCloudMat.uniforms.uFogDensity.value = opts.fogDensity;
    this.dustCloudMat.uniforms.uHighDetail.value = opts.quality === 'high' ? 1.0 : 0.0;

    (this.impactMoteMat.uniforms.uFogColor.value as THREE.Color).copy(opts.fogColor);
    this.impactMoteMat.uniforms.uFogDensity.value = opts.fogDensity;

    (this.ambientMoteMat.uniforms.uFogColor.value as THREE.Color).copy(opts.fogColor);
    this.ambientMoteMat.uniforms.uFogDensity.value = opts.fogDensity;
    (this.ambientMoteMat.uniforms.uSunColor.value as THREE.Color).copy(opts.sunColor);
  }

  private createDustCloudSystem(): {
    mesh: THREE.Mesh;
    geo: THREE.InstancedBufferGeometry;
    mat: THREE.ShaderMaterial;
  } {
    const baseQuad = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = baseQuad.index;
    geo.attributes.position = baseQuad.attributes.position;
    geo.attributes.uv = baseQuad.attributes.uv;
    baseQuad.dispose();

    const centerAttr = new THREE.InstancedBufferAttribute(this.dustCenterBuf, 3);
    centerAttr.setUsage(THREE.DynamicDrawUsage);
    const paramsAttr = new THREE.InstancedBufferAttribute(this.dustParamsBuf, 4);
    paramsAttr.setUsage(THREE.DynamicDrawUsage);
    const colorAttr = new THREE.InstancedBufferAttribute(this.dustColorBuf, 3);
    colorAttr.setUsage(THREE.DynamicDrawUsage);
    const opacityAttr = new THREE.InstancedBufferAttribute(this.dustOpacityBuf, 1);
    opacityAttr.setUsage(THREE.DynamicDrawUsage);

    geo.setAttribute('aCenter', centerAttr);
    geo.setAttribute('aParams', paramsAttr);
    geo.setAttribute('aColor', colorAttr);
    geo.setAttribute('aOpacity', opacityAttr);
    geo.instanceCount = 0;

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uSunDir: { value: new THREE.Vector3(0.55, 0.5, -0.55).normalize() },
        uSunColor: { value: new THREE.Color('#fff2cc') },
        uAmbientColor: { value: new THREE.Color('#7a8e84') },
        uFogColor: { value: new THREE.Color('#bfcfcc') },
        uFogDensity: { value: 0.008 },
        uHighDetail: { value: 1.0 },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      vertexShader: /* glsl */ `
        attribute vec3 aCenter;
        attribute vec4 aParams; // x: size, y: rotRad, z: lifeT [0..1], w: seed
        attribute vec3 aColor;
        attribute float aOpacity;

        varying vec2 vQuadUv;
        varying vec2 vBillowUv;
        varying vec3 vWorldPos;
        varying vec3 vColor;
        varying float vLifeT;
        varying float vSeed;
        varying float vOpacity;
        varying vec3 vCamRight;
        varying vec3 vCamUp;
        varying vec3 vCamForward;

        void main() {
          float size = aParams.x;
          float rot = aParams.y;
          float c = cos(rot);
          float s = sin(rot);
          vec2 local = vec2(
            position.x * c - position.y * s,
            position.x * s + position.y * c
          );

          // Camera-aligned billboard basis in world space
          vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
          vec3 camUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
          vec3 camForward = -vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);

          vec3 worldPos = aCenter + (camRight * local.x + camUp * local.y) * size;

          vQuadUv = position.xy * 2.0; // [-1..1] rotates with puff swirl
          vBillowUv = local * 2.0; // [-1..1] stays world-up aligned for true top/bottom lighting
          vWorldPos = worldPos;
          vColor = aColor;
          vLifeT = aParams.z;
          vSeed = aParams.w;
          vOpacity = aOpacity;
          vCamRight = camRight;
          vCamUp = camUp;
          vCamForward = camForward;

          gl_Position = projectionMatrix * viewMatrix * vec4(worldPos, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform vec3 uSunDir;
        uniform vec3 uSunColor;
        uniform vec3 uAmbientColor;
        uniform vec3 uFogColor;
        uniform float uFogDensity;
        uniform float uHighDetail;

        varying vec2 vQuadUv;
        varying vec2 vBillowUv;
        varying vec3 vWorldPos;
        varying vec3 vColor;
        varying float vLifeT;
        varying float vSeed;
        varying float vOpacity;
        varying vec3 vCamRight;
        varying vec3 vCamUp;
        varying vec3 vCamForward;

        float dHash(vec2 p) {
          p = fract(p * vec2(127.1, 311.7));
          p += dot(p, p + 34.5);
          return fract(p.x * p.y);
        }

        float dNoise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(
            mix(dHash(i), dHash(i + vec2(1.0, 0.0)), u.x),
            mix(dHash(i + vec2(0.0, 1.0)), dHash(i + vec2(1.0, 1.0)), u.x),
            u.y
          );
        }

        float fbmDust(vec2 p) {
          float v = 0.0;
          float a = 0.52;
          mat2 m = mat2(0.8, 0.6, -0.6, 0.8);
          v += a * dNoise(p); p = m * p * 2.05; a *= 0.5;
          v += a * dNoise(p); p = m * p * 2.05; a *= 0.5;
          v += a * dNoise(p);
          if (uHighDetail > 0.5) {
            p = m * p * 2.05; a *= 0.5;
            v += a * dNoise(p);
          }
          return v;
        }

        void main() {
          float r = length(vQuadUv);
          if (r >= 1.0) discard;

          // Swirling domain-warped FBM dust density that internally rises & erodes over life
          vec2 seedOff = vec2(vSeed * 13.7, vSeed * 29.3);
          vec2 flow = vec2(sin(vSeed * 6.283) * 0.25, -0.55) * vLifeT;
          vec2 p = vQuadUv * 1.65 + seedOff + flow;

          vec2 warp = vec2(
            fbmDust(p + vec2(1.7, 9.2) + uTime * 0.14),
            fbmDust(p + vec2(8.3, 2.8) - uTime * 0.11)
          );
          float n = fbmDust(p + (warp - 0.5) * 1.15);

          // Organic wispy radial mask + lifetime erosion so clouds dissolve into fine tendrils
          float radial = smoothstep(1.0, 0.12, r);
          float radialSoft = radial * radial;
          float erode = smoothstep(0.24, 1.0, vLifeT) * 0.44;
          float density = smoothstep(0.24 + erode, 0.86, n * 0.78 + radial * 0.52) * radialSoft;

          // Smooth fade-in right at impact and gentle lingering dissipation
          float fadeIn = smoothstep(0.0, 0.11, vLifeT);
          float fadeOut = 1.0 - smoothstep(0.36, 1.0, vLifeT);
          // Soft ground-plane feather prevents harsh flat clipping where billboards touch soil
          float groundFade = smoothstep(-0.22, 0.38, vWorldPos.y);

          float alpha = density * fadeIn * fadeOut * groundFade * vOpacity;
          if (alpha < 0.008) discard;

          // Hemispherical billow shading perturbed by FBM gradients for volumetric puff depth
          float nRight = fbmDust(p + vec2(0.18, 0.0) + (warp - 0.5) * 1.15);
          float nUp = fbmDust(p + vec2(0.0, 0.18) + (warp - 0.5) * 1.15);
          float billowZ = sqrt(max(0.04, 1.0 - r * r));
          vec3 billowLocal = normalize(vec3(
            vBillowUv.x * 0.55 + (n - nRight) * 1.4,
            vBillowUv.y * 0.55 + 0.22 + (n - nUp) * 1.4,
            billowZ
          ));
          vec3 rawWorldN =
            vCamRight * billowLocal.x +
            vCamUp * billowLocal.y -
            vCamForward * billowLocal.z;
          vec3 worldN = dot(rawWorldN, rawWorldN) > 1e-6 ? normalize(rawWorldN) : vec3(0.0, 1.0, 0.0);

          vec3 sunD = dot(uSunDir, uSunDir) > 1e-6 ? normalize(uSunDir) : vec3(0.0, 1.0, 0.0);
          // Soft wrap lighting + warm upward sky bounce + subtle backlit dust silver lining
          float ndl = clamp(dot(worldN, sunD) * 0.55 + 0.45, 0.0, 1.0);
          float topGrad = clamp(vBillowUv.y * 0.45 + 0.55, 0.0, 1.0);
          vec3 toCam = cameraPosition - vWorldPos;
          vec3 viewDir = dot(toCam, toCam) > 1e-6 ? normalize(toCam) : vec3(0.0, 0.0, 1.0);
          float backLit = clamp(dot(-viewDir, sunD), 0.0, 1.0);
          float silver = (backLit * backLit * backLit) * (1.0 - density * 0.55) * 0.42;

          vec3 shadowTint = vColor * (uAmbientColor * 0.72 + vec3(0.16));
          vec3 litTint = vColor * (uSunColor * 0.92 + uAmbientColor * 0.42);
          vec3 dustCol = mix(shadowTint, litTint, clamp(ndl * 0.7 + topGrad * 0.3, 0.0, 1.0));
          dustCol += uSunColor * silver * 0.48;

          // Match scene FogExp2
          float camDist = length(cameraPosition - vWorldPos);
          float fogFactor = 1.0 - exp(-uFogDensity * uFogDensity * camDist * camDist);
          dustCol = mix(dustCol, uFogColor, clamp(fogFactor, 0.0, 1.0));

          gl_FragColor = vec4(clamp(dustCol, vec3(0.0), vec3(4.0)), clamp(alpha, 0.0, 0.86));
        }
      `,
    });

    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 3;
    return { mesh, geo, mat };
  }

  private createImpactMoteSystem(): {
    points: THREE.Points;
    mat: THREE.ShaderMaterial;
  } {
    const geo = new THREE.BufferGeometry();
    const posAttr = new THREE.BufferAttribute(this.motePosBuf, 3);
    posAttr.setUsage(THREE.DynamicDrawUsage);
    const colAttr = new THREE.BufferAttribute(this.moteColorBuf, 3);
    colAttr.setUsage(THREE.DynamicDrawUsage);
    const paramAttr = new THREE.BufferAttribute(this.moteParamBuf, 2);
    paramAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', posAttr);
    geo.setAttribute('aColor', colAttr);
    geo.setAttribute('aParam', paramAttr);
    geo.setDrawRange(0, 0);

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uFogColor: { value: new THREE.Color('#bfcfcc') },
        uFogDensity: { value: 0.008 },
      },
      transparent: true,
      depthWrite: false,
      vertexShader: /* glsl */ `
        attribute vec3 aColor;
        attribute vec2 aParam; // x: size, y: alpha
        varying vec3 vColor;
        varying float vAlpha;
        varying float vCamDist;

        void main() {
          vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
          vCamDist = max(0.5, -mvPos.z);
          vColor = aColor;
          vAlpha = aParam.y;
          gl_PointSize = clamp((aParam.x * 260.0) / vCamDist, 1.5, 22.0);
          gl_Position = projectionMatrix * mvPos;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uFogColor;
        uniform float uFogDensity;
        varying vec3 vColor;
        varying float vAlpha;
        varying float vCamDist;

        void main() {
          vec2 c = gl_PointCoord * 2.0 - 1.0;
          float r2 = dot(c, c);
          if (r2 >= 1.0) discard;
          float soft = pow(max(1e-4, 1.0 - r2), 2.1);
          float fogFactor = 1.0 - exp(-uFogDensity * uFogDensity * vCamDist * vCamDist);
          vec3 col = mix(vColor, uFogColor, clamp(fogFactor, 0.0, 1.0));
          gl_FragColor = vec4(col, soft * vAlpha);
        }
      `,
    });

    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    points.renderOrder = 4;
    return { points, mat };
  }

  private getSiteDustPalette(): { core: string; haze: string; mote: string; dryMult: number } {
    const isRain = this.weather === 'light_rain';
    const isMist = this.weather === 'misty_fog';
    if (this.site === 'kootenay_rockies') {
      return {
        core: isRain ? '#8c7e6a' : '#bfa884',
        haze: isRain ? '#a99e8d' : '#d8c5a3',
        mote: '#eadab8',
        dryMult: isRain ? 0.72 : 1.18,
      };
    }
    if (this.site === 'misty_creek') {
      return {
        core: isRain || isMist ? '#7a7b6f' : '#8f836c',
        haze: isRain || isMist ? '#b4c2bc' : '#b2aa96',
        mote: '#cfd8ce',
        dryMult: isRain ? 0.68 : 0.92,
      };
    }
    if (this.site === 'pacific_headland' || this.site === 'storm_bluff') {
      return {
        core: isRain ? '#7f786c' : '#a8977b',
        haze: isRain ? '#aeb8b6' : '#c7baa0',
        mote: '#ded3ba',
        dryMult: isRain ? 0.72 : 1.05,
      };
    }
    if (this.site === 'coastal_town') {
      return {
        core: '#8d836d',
        haze: '#b6ae99',
        mote: '#d7cfb8',
        dryMult: isRain ? 0.7 : 0.9,
      };
    }
    // coastal_homestead & timber_ridge
    return {
      core: isRain ? '#786e5e' : '#9b886c',
      haze: isRain ? '#a8b2ac' : '#c0b195',
      mote: '#d9ccb0',
      dryMult: isRain ? 0.74 : 1.04,
    };
  }

  private addDustPuff(puff: DustPuff): void {
    if (this.dustPuffs.length >= MAX_DUST_PUFFS) {
      this.dustPuffs.shift();
    }
    this.dustPuffs.push(puff);
  }

  private addImpactMote(mote: ImpactMote): void {
    if (this.impactMotes.length >= MAX_IMPACT_MOTES) {
      this.impactMotes.shift();
    }
    this.impactMotes.push(mote);
  }

  public setWeather(weather: WeatherId): void {
    this.weather = weather;
    const isRain = weather === 'light_rain';
    this.rainLines.visible = isRain;

    const u = this.ambientMoteMat.uniforms;
    if (isRain) {
      (u.uColor.value as THREE.Color).set('#cfe2e8');
      u.uOpacity.value = 0.22;
      u.uSizeScale.value = 0.24;
    } else if (weather === 'misty_fog') {
      (u.uColor.value as THREE.Color).set('#e4f0ee');
      u.uOpacity.value = 0.34;
      u.uSizeScale.value = 0.28;
    } else if (weather === 'golden_hour') {
      (u.uColor.value as THREE.Color).set('#ffebb8');
      u.uOpacity.value = 0.56;
      u.uSizeScale.value = 0.30;
    } else {
      (u.uColor.value as THREE.Color).set('#fff6dc');
      u.uOpacity.value = 0.44;
      u.uSizeScale.value = 0.27;
    }
  }

  private createRainLines(): THREE.LineSegments {
    const count = 680;
    const positions = new Float32Array(count * 2 * 3);
    this.rainDrops = [];

    for (let i = 0; i < count; i++) {
      const x = (Math.random() - 0.5) * 56;
      const y = Math.random() * 28;
      const z = (Math.random() - 0.5) * 56;
      const speed = 17.5 + Math.random() * 6.5;
      const len = 0.52 + Math.random() * 0.42;
      this.rainDrops.push({ x, y, z, speed, len });

      const idx = i * 6;
      positions[idx] = x;
      positions[idx + 1] = y;
      positions[idx + 2] = z;
      positions[idx + 3] = x;
      positions[idx + 4] = y - len;
      positions[idx + 5] = z;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.LineBasicMaterial({
      color: '#cfe3ec',
      transparent: true,
      opacity: 0.34,
      depthWrite: false,
    });
    const lines = new THREE.LineSegments(geo, mat);
    lines.frustumCulled = false;
    return lines;
  }

  private createAmbientMotes(): THREE.Points {
    const count = 190;
    const positions = new Float32Array(count * 3);
    // Per-mote attributes: [phase, sizeMult, shapeSeed, warmTint]
    const seeds = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 44;
      positions[i * 3 + 1] = 0.6 + Math.random() * 18;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 44;

      const isFluff = Math.random() < 0.24;
      seeds[i * 4] = Math.random(); // shimmer & drift phase
      seeds[i * 4 + 1] = isFluff ? 1.05 + Math.random() * 0.55 : 0.45 + Math.random() * 0.52;
      seeds[i * 4 + 2] = isFluff ? 0.55 + Math.random() * 0.45 : Math.random() * 0.35; // organic fluffiness
      seeds[i * 4 + 3] = Math.random(); // tint mix between warm sunlit pollen & pale misty dust
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uColor: { value: new THREE.Color('#fff6dc') },
        uSunColor: { value: new THREE.Color('#fff1cc') },
        uOpacity: { value: 0.44 },
        uSizeScale: { value: 0.27 },
        uFogColor: { value: new THREE.Color('#bfcfcc') },
        uFogDensity: { value: 0.008 },
      },
      transparent: true,
      depthWrite: false,
      vertexShader: /* glsl */ `
        attribute vec4 aSeed;
        uniform float uSizeScale;
        varying vec4 vSeed;
        varying float vCamDist;
        varying float vWorldY;

        void main() {
          vec4 wPos = modelMatrix * vec4(position, 1.0);
          vec4 mvPos = viewMatrix * wPos;
          vCamDist = max(0.5, -mvPos.z);
          vWorldY = wPos.y;
          vSeed = aSeed;
          float px = (uSizeScale * aSeed.y * 235.0) / vCamDist;
          gl_PointSize = clamp(px, 1.6, 13.5);
          gl_Position = projectionMatrix * mvPos;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform vec3 uColor;
        uniform vec3 uSunColor;
        uniform float uOpacity;
        uniform vec3 uFogColor;
        uniform float uFogDensity;
        varying vec4 vSeed;
        varying float vCamDist;
        varying float vWorldY;

        void main() {
          vec2 c = gl_PointCoord * 2.0 - 1.0;
          float angle = atan(c.y, c.x) + uTime * (0.35 + vSeed.x * 0.45) + vSeed.x * 6.2831;
          float r = length(c);

          // Subtle organic asymmetry so pollen clumps & cottonwood fluff look airy, never geometric squares
          float fluff = vSeed.z;
          float organicWarp = 1.0 + fluff * (0.18 * sin(angle * 3.0 + vSeed.x * 11.0) + 0.10 * cos(angle * 5.0 - vSeed.w * 7.0));
          float rr = r * organicWarp;
          if (rr >= 1.0) discard;

          // Bright pinpoint sunlit dust core + whisper-soft bokeh halo
          float core = exp(-rr * rr * 6.5);
          float halo = pow(max(0.0, 1.0 - rr * rr), 2.3) * (0.42 + fluff * 0.28);
          float shape = clamp(core * 0.78 + halo * 0.58, 0.0, 1.0);

          // Gentle sunbeam twinkle as motes tumble through shafts of forest light
          float shimmer = 0.46 + 0.54 * (0.5 + 0.5 * sin(uTime * (0.95 + vSeed.x * 1.35) + vSeed.x * 6.2831));

          // Soft fade near camera lens & very close to soil so motes never pop
          float nearFade = smoothstep(1.3, 4.4, vCamDist);
          float groundFade = smoothstep(0.3, 1.3, vWorldY);
          float fogFactor = 1.0 - exp(-uFogDensity * uFogDensity * vCamDist * vCamDist);
          float farFade = 1.0 - smoothstep(0.68, 0.98, fogFactor);

          vec3 warmCol = mix(uColor, uSunColor * 1.12, vSeed.w * 0.65);
          vec3 col = mix(warmCol, uFogColor, clamp(fogFactor * 0.72, 0.0, 0.85));
          float alpha = shape * shimmer * uOpacity * nearFade * groundFade * farFade;
          if (alpha < 0.006) discard;
          gl_FragColor = vec4(col, alpha);
        }
      `,
    });

    this.ambientMoteMat = mat;
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    pts.renderOrder = 3;
    return pts;
  }

  public spawnSawdust(
    pos: THREE.Vector3,
    normalDir: THREE.Vector3,
    woodColor: string,
    count = 6
  ): void {
    const mat = new THREE.MeshStandardMaterial({
      color: woodColor,
      roughness: 0.9,
    });

    for (let i = 0; i < count; i++) {
      const m = new THREE.Mesh(this.chipGeo, mat);
      m.position.copy(pos);
      const spread = new THREE.Vector3(
        (Math.random() - 0.5) * 2.2,
        0.7 + Math.random() * 1.8,
        (Math.random() - 0.5) * 2.2
      );
      const vel = normalDir.clone().multiplyScalar(1.8 + Math.random() * 2.4).add(spread);
      const s = 0.55 + Math.random() * 0.95;
      m.scale.setScalar(s);
      this.scene.add(m);
      this.particles.push({
        mesh: m,
        vel,
        rotVel: new THREE.Vector3(Math.random() * 12, Math.random() * 12, Math.random() * 12),
        age: 0,
        life: 0.55 + Math.random() * 0.5,
        gravity: 9.2,
        drag: 0.96,
        startScale: s,
        endScale: 0.1,
      });
    }
  }

  public spawnFoliageBurst(pos: THREE.Vector3, colors: string[], count = 14): void {
    for (let i = 0; i < count; i++) {
      const c = colors[Math.floor(Math.random() * colors.length)];
      const m = new THREE.Mesh(
        this.leafGeo,
        new THREE.MeshStandardMaterial({ color: c, roughness: 0.85, flatShading: true })
      );
      m.position.copy(pos).add(
        new THREE.Vector3(
          (Math.random() - 0.5) * 1.8,
          (Math.random() - 0.5) * 1.2,
          (Math.random() - 0.5) * 1.8
        )
      );
      const s = 0.8 + Math.random() * 1.1;
      m.scale.setScalar(s);
      this.scene.add(m);
      this.particles.push({
        mesh: m,
        vel: new THREE.Vector3(
          (Math.random() - 0.5) * 4.5,
          1.2 + Math.random() * 3.0,
          (Math.random() - 0.5) * 4.5
        ),
        rotVel: new THREE.Vector3(Math.random() * 7, Math.random() * 7, Math.random() * 7),
        age: 0,
        life: 1.4 + Math.random() * 1.2,
        gravity: 3.1,
        drag: 0.94,
        startScale: s,
        endScale: 0.25,
      });
    }
  }

  public spawnTimberImpact(
    basePos: THREE.Vector3,
    fallAngle: number,
    treeHeight: number,
    foliageColors: string[]
  ): void {
    const dx = Math.cos(fallAngle);
    const dz = Math.sin(fallAngle);
    // Horizontal normal perpendicular to the fallen trunk for ground-hugging lateral shockwave billows
    const perpX = -dz;
    const perpZ = dx;

    const palette = this.getSiteDustPalette();
    const coreColor = new THREE.Color(palette.core);
    const hazeColor = new THREE.Color(palette.haze);
    const moteColor = new THREE.Color(palette.mote);
    const isHigh = this.quality === 'high';
    const scaleFactor = THREE.MathUtils.clamp(treeHeight / 18, 0.72, 1.55);

    // Layer 1: Ground-level lateral shockwave dust billows rolling outward along both sides of the trunk
    const samples = isHigh ? 18 : 13;
    for (let i = 1; i <= samples; i++) {
      const frac = i / samples;
      const dist = (0.12 + frac * 0.92) * treeHeight;
      const isCrownZone = frac > 0.48;
      const p = new THREE.Vector3(basePos.x + dx * dist, 0.25, basePos.z + dz * dist);

      for (const side of [-1, 1]) {
        const lateralSpeed = (2.2 + Math.random() * 2.8) * (isCrownZone ? 1.25 : 0.95) * scaleFactor;
        const startSize = (1.6 + Math.random() * 1.1) * (isCrownZone ? 1.3 : 1.0) * scaleFactor;
        const puffColor = coreColor.clone().lerp(hazeColor, 0.2 + Math.random() * 0.35);
        puffColor.offsetHSL((Math.random() - 0.5) * 0.02, 0, (Math.random() - 0.5) * 0.06);

        this.addDustPuff({
          pos: p.clone().add(
            new THREE.Vector3(
              perpX * side * (0.45 + Math.random() * 0.9) + (Math.random() - 0.5) * 0.8,
              0.25 + Math.random() * 0.45,
              perpZ * side * (0.45 + Math.random() * 0.9) + (Math.random() - 0.5) * 0.8
            )
          ),
          vel: new THREE.Vector3(
            perpX * side * lateralSpeed + dx * (Math.random() - 0.25) * 1.4,
            0.85 + Math.random() * 1.35 + (isCrownZone ? 0.55 : 0),
            perpZ * side * lateralSpeed + dz * (Math.random() - 0.25) * 1.4
          ),
          age: 0,
          life: (1.75 + Math.random() * 1.15) * palette.dryMult,
          startSize,
          endSize: startSize * (2.6 + Math.random() * 1.1),
          rot: Math.random() * Math.PI * 2,
          rotSpeed: (Math.random() > 0.5 ? 1 : -1) * (0.35 + Math.random() * 0.65),
          seed: Math.random() * 100,
          color: puffColor,
          opacity: (isCrownZone ? 0.58 : 0.50) * palette.dryMult,
          drag: 0.925,
          buoyancy: 0.38 + Math.random() * 0.32,
        });
      }

      // Layer 2: Taller lingering wispy thermal haze rising slowly over the crash corridor
      if (i % 2 === 0 || isCrownZone) {
        const hazeSize = (2.5 + Math.random() * 1.6) * (isCrownZone ? 1.35 : 1.0) * scaleFactor;
        const veilColor = hazeColor.clone();
        veilColor.offsetHSL((Math.random() - 0.5) * 0.02, -0.04, (Math.random() - 0.5) * 0.05);
        this.addDustPuff({
          pos: p.clone().add(
            new THREE.Vector3(
              (Math.random() - 0.5) * 2.6,
              0.7 + Math.random() * 1.0,
              (Math.random() - 0.5) * 2.6
            )
          ),
          vel: new THREE.Vector3(
            (Math.random() - 0.5) * 1.6,
            1.15 + Math.random() * 1.4,
            (Math.random() - 0.5) * 1.6
          ),
          age: 0,
          life: (2.5 + Math.random() * 1.55) * palette.dryMult,
          startSize: hazeSize,
          endSize: hazeSize * (2.3 + Math.random() * 0.9),
          rot: Math.random() * Math.PI * 2,
          rotSpeed: (Math.random() - 0.5) * 0.45,
          seed: Math.random() * 100,
          color: veilColor,
          opacity: 0.32 * palette.dryMult,
          drag: 0.955,
          buoyancy: 0.52 + Math.random() * 0.25,
        });
      }

      if (isCrownZone) {
        this.spawnFoliageBurst(p.clone().add(new THREE.Vector3(0, 1.0, 0)), foliageColors, 4);
      }
    }

    // Layer 3: Fine airborne sunlit dust motes suspended & drifting in the impact air
    const moteCount = isHigh ? 135 : 75;
    for (let m = 0; m < moteCount; m++) {
      const dist = (0.1 + Math.random() * 0.98) * treeHeight;
      const side = Math.random() > 0.5 ? 1 : -1;
      const spread = (Math.random() * 2.4 + 0.3) * scaleFactor;
      const col = moteColor.clone();
      col.offsetHSL((Math.random() - 0.5) * 0.03, 0, (Math.random() - 0.5) * 0.12);
      this.addImpactMote({
        pos: new THREE.Vector3(
          basePos.x + dx * dist + perpX * side * spread * 0.6 + (Math.random() - 0.5) * 1.4,
          0.18 + Math.random() * 1.35,
          basePos.z + dz * dist + perpZ * side * spread * 0.6 + (Math.random() - 0.5) * 1.4
        ),
        vel: new THREE.Vector3(
          perpX * side * (1.2 + Math.random() * 3.4) + (Math.random() - 0.5) * 1.6,
          1.0 + Math.random() * 3.2,
          perpZ * side * (1.2 + Math.random() * 3.4) + (Math.random() - 0.5) * 1.6
        ),
        age: 0,
        life: 1.9 + Math.random() * 2.1,
        size: 0.06 + Math.random() * 0.12,
        color: col,
      });
    }
  }

  /** Spawns a compact localized billowing shader dust puff (e.g. when a pieced top hits the ground). */
  public spawnSmallDustPuff(pos: THREE.Vector3, radius = 1.6): void {
    const palette = this.getSiteDustPalette();
    const baseCol = new THREE.Color(palette.core).lerp(new THREE.Color(palette.haze), 0.35);
    const count = this.quality === 'high' ? 7 : 4;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + Math.random() * 0.5;
      const spd = 1.2 + Math.random() * 1.8;
      this.addDustPuff({
        pos: new THREE.Vector3(
          pos.x + Math.cos(a) * radius * 0.35,
          Math.max(0.2, pos.y * 0.35),
          pos.z + Math.sin(a) * radius * 0.35
        ),
        vel: new THREE.Vector3(Math.cos(a) * spd, 0.75 + Math.random() * 1.1, Math.sin(a) * spd),
        age: 0,
        life: 1.4 + Math.random() * 0.9,
        startSize: radius * (0.9 + Math.random() * 0.5),
        endSize: radius * (2.5 + Math.random() * 0.8),
        rot: Math.random() * Math.PI * 2,
        rotSpeed: (Math.random() - 0.5) * 0.7,
        seed: Math.random() * 100,
        color: baseCol.clone(),
        opacity: 0.44 * palette.dryMult,
        drag: 0.93,
        buoyancy: 0.35,
      });
    }
  }

  /**
   * Remove a cut limb from the world and replace it with a short burst of
   * leaves and chips so forestry scenes don't fill up with leftover sticks.
   */
  public dissolveLimb(branchGroup: THREE.Object3D, foliageColors: string[], woodColor: string): void {
    branchGroup.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(branchGroup);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const span = Math.max(0.8, size.length());

    if (branchGroup.parent) branchGroup.parent.remove(branchGroup);
    this.scene.remove(branchGroup);

    const leafCount = Math.min(26, 8 + Math.round(span * 2.4));
    this.spawnFoliageBurst(center, foliageColors, leafCount);
    this.spawnSawdust(center, new THREE.Vector3(0, 1, 0), woodColor, Math.min(14, 5 + Math.round(span)));

    const puff = Math.max(3, Math.min(6, Math.round(span)));
    for (let i = 0; i < puff; i++) {
      const p = new THREE.Vector3(
        THREE.MathUtils.lerp(box.min.x, box.max.x, Math.random()),
        THREE.MathUtils.lerp(box.min.y, box.max.y, Math.random()),
        THREE.MathUtils.lerp(box.min.z, box.max.z, Math.random())
      );
      this.spawnFoliageBurst(p, foliageColors, 3);
      this.spawnSawdust(p, new THREE.Vector3((Math.random() - 0.5), 1, (Math.random() - 0.5)), woodColor, 2);
    }
  }

  /**
   * Detaches a pieced-down standing upper section, tips it cleanly away from hazards
   * as it falls toward the pocket, then bursts it into chips & foliage so the landing stays clear.
   */
  public addFallingTopSection(
    segmentGroups: THREE.Object3D[],
    cutWorldPos: THREE.Vector3,
    tipDir: THREE.Vector3,
    foliageColors: string[],
    woodColor: string
  ): void {
    if (segmentGroups.length === 0) return;

    const pivot = new THREE.Group();
    pivot.position.copy(cutWorldPos);
    this.scene.add(pivot);
    pivot.updateWorldMatrix(true, false);

    for (const seg of segmentGroups) {
      seg.updateWorldMatrix(true, true);
      pivot.attach(seg);
    }

    const dir = tipDir.clone();
    dir.y = 0;
    if (dir.lengthSq() < 0.01) dir.set(1, 0, 0);
    dir.normalize();
    // Horizontal axis perpendicular to tipDir so positive rotation tips +Y toward dir
    const tipAxis = new THREE.Vector3(0, 1, 0).cross(dir).normalize();

    this.fallingTopSections.push({
      pivot,
      vel: dir.clone().multiplyScalar(2.6).add(new THREE.Vector3(0, 0.9, 0)),
      tipAxis,
      tipSpeed: 1.55,
      age: 0,
      foliageColors,
      woodColor,
    });
  }

  public addFallingBranch(branchGroup: THREE.Object3D, outDir: THREE.Vector3): void {
    // Reparent to world space preserving exact transform
    const worldPos = new THREE.Vector3();
    const worldQuat = new THREE.Quaternion();
    const worldScale = new THREE.Vector3();
    branchGroup.getWorldPosition(worldPos);
    branchGroup.getWorldQuaternion(worldQuat);
    branchGroup.getWorldScale(worldScale);

    if (branchGroup.parent) {
      branchGroup.parent.remove(branchGroup);
    }
    branchGroup.position.copy(worldPos);
    branchGroup.quaternion.copy(worldQuat);
    branchGroup.scale.copy(worldScale);
    this.scene.add(branchGroup);

    // Lay the limb flat immediately (local +X is the stick). No tumbling that leaves it upright in the crown.
    const kick = outDir.clone();
    kick.y = 0;
    if (kick.lengthSq() < 0.04) kick.set(Math.random() - 0.5, 0, Math.random() - 0.5);
    kick.normalize();

    const localAxis = new THREE.Vector3(1, 0, 0);
    const worldAxis = localAxis.clone().applyQuaternion(worldQuat);
    let flatDir = new THREE.Vector3(worldAxis.x, 0, worldAxis.z);
    if (flatDir.lengthSq() < 0.04) flatDir.copy(kick);
    flatDir.normalize();
    const layFlatQuat = new THREE.Quaternion().setFromUnitVectors(localAxis, flatDir);
    layFlatQuat.premultiply(
      new THREE.Quaternion().setFromAxisAngle(flatDir, Math.random() * Math.PI * 2)
    );
    branchGroup.quaternion.copy(layFlatQuat);

    // Move it clear of the trunk/crown before it drops, so it cannot stay hung in the foliage.
    const clearDist = 3.4 + Math.random() * 2.2;
    branchGroup.position.x += kick.x * clearDist;
    branchGroup.position.z += kick.z * clearDist;
    branchGroup.position.y = Math.max(branchGroup.position.y, 1.1) + 0.35;

    branchGroup.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(branchGroup);
    const restY = branchGroup.position.y - (box.min.y - 0.08);

    this.fallingBranches.push({
      group: branchGroup,
      velY: 0,
      restY,
      settled: false,
    });
  }

  public addBuckedLogSegment(
    segGroup: THREE.Object3D,
    axialDir: THREE.Vector3,
    avgRadius: number,
    axialKick: number,
    isCrownTip: boolean
  ): void {
    // Reparent segment into world space preserving exact fallen transform
    const worldPos = new THREE.Vector3();
    const worldQuat = new THREE.Quaternion();
    const worldScale = new THREE.Vector3();
    segGroup.getWorldPosition(worldPos);
    segGroup.getWorldQuaternion(worldQuat);
    segGroup.getWorldScale(worldScale);

    if (segGroup.parent) {
      segGroup.parent.remove(segGroup);
    }
    segGroup.position.copy(worldPos);
    segGroup.quaternion.copy(worldQuat);
    segGroup.scale.copy(worldScale);
    this.scene.add(segGroup);

    const axis = axialDir.clone().setY(0).normalize();
    if (axis.lengthSq() < 0.01) axis.set(1, 0, 0);
    const lateral = new THREE.Vector3(-axis.z, 0, axis.x).normalize();

    const rollDir = Math.random() > 0.5 ? 1 : -1;
    const lateralSpeed = isCrownTip
      ? (0.35 + Math.random() * 0.35) * rollDir
      : (1.05 + Math.random() * 0.85) * rollDir;
    const hopVel = isCrownTip ? 0.55 : 1.15 + Math.random() * 0.4;

    const vel = axis
      .clone()
      .multiplyScalar(axialKick)
      .addScaledVector(lateral, lateralSpeed);
    vel.y = hopVel;

    this.rollingLogs.push({
      group: segGroup,
      vel,
      rollAxis: axis,
      lateralAxis: lateral,
      restY: Math.max(0.22, avgRadius * 1.02),
      rollSign: 1, // right-hand rule around +axis aligns with +lateral rolling
      yawSpin: (Math.random() - 0.5) * (isCrownTip ? 0.25 : 0.65),
      settled: false,
    });
  }

  public update(dt: number, elapsed: number, windSpeed: number, windAngle: number): void {
    // Ambient drifting forest dust & pollen motes (soft sunlit bokeh with swirling thermal eddies)
    this.ambientMoteMat.uniforms.uTime.value = elapsed;
    const pos = this.ambientMotes.geometry.attributes.position as THREE.BufferAttribute;
    const wx = Math.cos(windAngle) * (0.18 + windSpeed * 1.25);
    const wz = Math.sin(windAngle) * (0.18 + windSpeed * 1.25);
    for (let i = 0; i < pos.count; i++) {
      const fi = i * 1.37;
      let x = pos.getX(i) + (wx + Math.sin(elapsed * 0.45 + fi) * 0.24) * dt;
      let y = pos.getY(i) + (Math.cos(elapsed * 0.55 + fi * 1.3) * 0.16 + 0.03) * dt;
      let z = pos.getZ(i) + (wz + Math.cos(elapsed * 0.41 + fi * 0.85) * 0.24) * dt;
      if (x > 22) x -= 44;
      else if (x < -22) x += 44;
      if (z > 22) z -= 44;
      else if (z < -22) z += 44;
      if (y > 19.5) y = 0.8 + (i % 7) * 0.35;
      else if (y < 0.5) y = 16.5;
      pos.setXYZ(i, x, y, z);
    }
    pos.needsUpdate = true;

    // Fine slanted light-rain streaks reacting to wind speed & direction
    if (this.weather === 'light_rain' && this.rainLines.visible) {
      const rPos = this.rainLines.geometry.attributes.position as THREE.BufferAttribute;
      const windDriftX = Math.cos(windAngle) * (0.75 + windSpeed * 6.5);
      const windDriftZ = Math.sin(windAngle) * (0.75 + windSpeed * 6.5);

      for (let i = 0; i < this.rainDrops.length; i++) {
        const drop = this.rainDrops[i];
        drop.x += windDriftX * dt;
        drop.y -= drop.speed * dt;
        drop.z += windDriftZ * dt;

        if (drop.y < 0.05) {
          drop.y = 24 + Math.random() * 6;
          drop.x = (Math.random() - 0.5) * 56;
          drop.z = (Math.random() - 0.5) * 56;
        }
        if (drop.x > 28) drop.x -= 56;
        else if (drop.x < -28) drop.x += 56;
        if (drop.z > 28) drop.z -= 56;
        else if (drop.z < -28) drop.z += 56;

        // Streak tail trails opposite to instantaneous velocity
        const streakScale = drop.len / drop.speed;
        const dx = windDriftX * streakScale;
        const dz = windDriftZ * streakScale;

        const idx = i * 2;
        rPos.setXYZ(idx, drop.x - dx, drop.y + drop.len, drop.z - dz);
        rPos.setXYZ(idx + 1, drop.x, drop.y, drop.z);
      }
      rPos.needsUpdate = true;
    }

    // Update GPU-instanced volumetric shader dust plumes (billowing expansion + wind drift + thermal rise)
    this.dustCloudMat.uniforms.uTime.value = elapsed;
    const windPushX = Math.cos(windAngle) * (0.45 + windSpeed * 3.6);
    const windPushZ = Math.sin(windAngle) * (0.45 + windSpeed * 3.6);
    for (let i = this.dustPuffs.length - 1; i >= 0; i--) {
      const puff = this.dustPuffs[i];
      puff.age += dt;
      if (puff.age >= puff.life) {
        this.dustPuffs.splice(i, 1);
        continue;
      }
      const dragPow = Math.pow(puff.drag, dt * 60);
      puff.vel.x = puff.vel.x * dragPow + windPushX * (1 - dragPow) * 0.55;
      puff.vel.z = puff.vel.z * dragPow + windPushZ * (1 - dragPow) * 0.55;
      puff.vel.y = puff.vel.y * dragPow + puff.buoyancy * dt;
      puff.pos.addScaledVector(puff.vel, dt);
      if (puff.pos.y < 0.16) puff.pos.y = 0.16;
      puff.rot += puff.rotSpeed * dt;
    }

    const puffCount = this.dustPuffs.length;
    if (puffCount > 0) {
      for (let i = 0; i < puffCount; i++) {
        const puff = this.dustPuffs[i];
        const t = THREE.MathUtils.clamp(puff.age / puff.life, 0, 1);
        // Fast initial billow expansion tapering smoothly as dust lingers
        const expandT = 1 - Math.pow(1 - t, 2.2);
        const size = THREE.MathUtils.lerp(puff.startSize, puff.endSize, expandT);
        const i3 = i * 3;
        const i4 = i * 4;
        this.dustCenterBuf[i3] = puff.pos.x;
        this.dustCenterBuf[i3 + 1] = puff.pos.y;
        this.dustCenterBuf[i3 + 2] = puff.pos.z;
        this.dustParamsBuf[i4] = size;
        this.dustParamsBuf[i4 + 1] = puff.rot;
        this.dustParamsBuf[i4 + 2] = t;
        this.dustParamsBuf[i4 + 3] = puff.seed;
        this.dustColorBuf[i3] = puff.color.r;
        this.dustColorBuf[i3 + 1] = puff.color.g;
        this.dustColorBuf[i3 + 2] = puff.color.b;
        this.dustOpacityBuf[i] = puff.opacity;
      }
      (this.dustCloudGeo.attributes.aCenter as THREE.InstancedBufferAttribute).needsUpdate = true;
      (this.dustCloudGeo.attributes.aParams as THREE.InstancedBufferAttribute).needsUpdate = true;
      (this.dustCloudGeo.attributes.aColor as THREE.InstancedBufferAttribute).needsUpdate = true;
      (this.dustCloudGeo.attributes.aOpacity as THREE.InstancedBufferAttribute).needsUpdate = true;
    }
    this.dustCloudGeo.instanceCount = puffCount;

    // Update fine airborne hovering impact dust motes
    for (let i = this.impactMotes.length - 1; i >= 0; i--) {
      const m = this.impactMotes[i];
      m.age += dt;
      if (m.age >= m.life) {
        this.impactMotes.splice(i, 1);
        continue;
      }
      const damp = Math.pow(0.935, dt * 60);
      m.vel.x = m.vel.x * damp + windPushX * (1 - damp) * 0.7;
      m.vel.z = m.vel.z * damp + windPushZ * (1 - damp) * 0.7;
      m.vel.y = m.vel.y * damp - 0.55 * dt;
      m.pos.addScaledVector(m.vel, dt);
      if (m.pos.y < 0.08) {
        m.pos.y = 0.08;
        m.vel.y = Math.abs(m.vel.y) * 0.2;
      }
    }
    const moteCount = this.impactMotes.length;
    if (moteCount > 0) {
      for (let i = 0; i < moteCount; i++) {
        const m = this.impactMotes[i];
        const t = THREE.MathUtils.clamp(m.age / m.life, 0, 1);
        const alpha = THREE.MathUtils.smoothstep(t, 0, 0.08) * (1 - THREE.MathUtils.smoothstep(t, 0.35, 1)) * 0.78;
        const i3 = i * 3;
        const i2 = i * 2;
        this.motePosBuf[i3] = m.pos.x;
        this.motePosBuf[i3 + 1] = m.pos.y;
        this.motePosBuf[i3 + 2] = m.pos.z;
        this.moteColorBuf[i3] = m.color.r;
        this.moteColorBuf[i3 + 1] = m.color.g;
        this.moteColorBuf[i3 + 2] = m.color.b;
        this.moteParamBuf[i2] = m.size;
        this.moteParamBuf[i2 + 1] = alpha;
      }
      (this.impactMotePoints.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      (this.impactMotePoints.geometry.attributes.aColor as THREE.BufferAttribute).needsUpdate = true;
      (this.impactMotePoints.geometry.attributes.aParam as THREE.BufferAttribute).needsUpdate = true;
    }
    this.impactMotePoints.geometry.setDrawRange(0, moteCount);

    // Dynamic chips, sawdust, leaves
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.age += dt;
      if (p.age >= p.life) {
        this.scene.remove(p.mesh);
        this.particles.splice(i, 1);
        continue;
      }
      p.vel.y -= p.gravity * dt;
      p.vel.multiplyScalar(Math.pow(p.drag, dt * 60));
      p.mesh.position.addScaledVector(p.vel, dt);
      if (p.mesh.position.y < 0.08) {
        p.mesh.position.y = 0.08;
        p.vel.y *= -0.25;
        p.vel.x *= 0.6;
        p.vel.z *= 0.6;
      }
      p.mesh.rotation.x += p.rotVel.x * dt;
      p.mesh.rotation.y += p.rotVel.y * dt;
      p.mesh.rotation.z += p.rotVel.z * dt;
      const t = p.age / p.life;
      const sc = THREE.MathUtils.lerp(p.startScale, p.endScale, t);
      p.mesh.scale.setScalar(Math.max(0.01, sc));
    }

    // Cut limbs drop straight down onto open ground and stay flat
    for (let i = this.fallingBranches.length - 1; i >= 0; i--) {
      const fb = this.fallingBranches[i];
      if (fb.settled) continue;

      fb.velY -= 22 * dt;
      fb.group.position.y += fb.velY * dt;

      if (fb.group.position.y <= fb.restY) {
        fb.group.position.y = fb.restY;
        fb.group.updateWorldMatrix(true, true);
        const box = new THREE.Box3().setFromObject(fb.group);
        fb.group.position.y += 0.08 - box.min.y;
        fb.velY = 0;
        fb.settled = true;
      }
    }

    // Detached bucked sawlog segments physically separating, hopping, and rolling to rest!
    const tmpQuat = new THREE.Quaternion();
    const upVec = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < this.rollingLogs.length; i++) {
      const rl = this.rollingLogs[i];
      if (rl.settled) continue;

      rl.vel.y -= 9.8 * dt;
      rl.group.position.addScaledVector(rl.vel, dt);

      // Ground contact & rolling friction
      if (rl.group.position.y <= rl.restY) {
        rl.group.position.y = rl.restY;
        if (Math.abs(rl.vel.y) > 0.75) {
          rl.vel.y *= -0.24;
        } else {
          rl.vel.y = 0;
        }
        // Damping on mossy forest floor
        const damp = Math.exp(-3.1 * dt);
        rl.vel.x *= damp;
        rl.vel.z *= damp;
        rl.yawSpin *= Math.exp(-4.0 * dt);
      }

      // True rolling rotation around the log's own longitudinal axis proportional to lateral motion!
      const lateralSpeed = rl.vel.dot(rl.lateralAxis);
      const omega = (lateralSpeed / Math.max(0.22, rl.restY)) * rl.rollSign;
      if (Math.abs(omega) > 0.005) {
        tmpQuat.setFromAxisAngle(rl.rollAxis, omega * dt);
        rl.group.quaternion.premultiply(tmpQuat);
      }
      if (Math.abs(rl.yawSpin) > 0.004) {
        tmpQuat.setFromAxisAngle(upVec, rl.yawSpin * dt);
        rl.group.quaternion.premultiply(tmpQuat);
        rl.rollAxis.applyQuaternion(tmpQuat).normalize();
        rl.lateralAxis.set(-rl.rollAxis.z, 0, rl.rollAxis.x).normalize();
      }

      const horizSpeed = Math.hypot(rl.vel.x, rl.vel.z);
      if (rl.group.position.y <= rl.restY + 0.005 && Math.abs(rl.vel.y) < 0.05 && horizSpeed < 0.04) {
        rl.vel.set(0, 0, 0);
        rl.settled = true;
      }
    }

    // Pieced-down standing top rounds tip clear and burst into chips/foliage on impact
    for (let i = this.fallingTopSections.length - 1; i >= 0; i--) {
      const fts = this.fallingTopSections[i];
      fts.age += dt;
      fts.vel.y -= 14.5 * dt;
      fts.pivot.position.addScaledVector(fts.vel, dt);
      tmpQuat.setFromAxisAngle(fts.tipAxis, fts.tipSpeed * dt);
      fts.pivot.quaternion.premultiply(tmpQuat);
      fts.tipSpeed = Math.min(2.8, fts.tipSpeed + 1.4 * dt);

      if (fts.pivot.position.y <= 1.6 || fts.age >= 0.95) {
        this.spawnSmallDustPuff(fts.pivot.position, 2.1);
        this.dissolveLimb(fts.pivot, fts.foliageColors, fts.woodColor);
        this.fallingTopSections.splice(i, 1);
      }
    }
  }

  public clearAll(): void {
    for (const p of this.particles) {
      this.scene.remove(p.mesh);
    }
    this.particles = [];
    this.dustPuffs = [];
    this.dustCloudGeo.instanceCount = 0;
    this.impactMotes = [];
    this.impactMotePoints.geometry.setDrawRange(0, 0);
    for (const fb of this.fallingBranches) {
      this.scene.remove(fb.group);
    }
    this.fallingBranches = [];
    for (const rl of this.rollingLogs) {
      this.scene.remove(rl.group);
    }
    this.rollingLogs = [];
    for (const fts of this.fallingTopSections) {
      this.scene.remove(fts.pivot);
    }
    this.fallingTopSections = [];
  }
}
