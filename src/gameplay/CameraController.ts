import * as THREE from 'three';

export interface CameraKeyframe {
  target: THREE.Vector3;
  distance: number;
  polar: number;
  azimuth: number;
}

function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}

/**
 * Smooth mouse & keyboard orbital camera controller with smart contextual focus,
 * cinematic mission intro fly-ins, and impact camera shake.
 * - Right-click drag, Middle-click drag, or Arrow keys orbit around current target
 * - Scroll wheel or `-` / `=` (`+`) keys zoom smoothly
 * - Smooth lerp transitions when selecting trees or switching tools
 */
export class CameraController {
  public camera: THREE.PerspectiveCamera;
  private domElement: HTMLElement;

  private target = new THREE.Vector3(0, 5, 0);
  private desiredTarget = new THREE.Vector3(0, 5, 0);

  private azimuth = 0.72;
  private desiredAzimuth = 0.72;

  private polar = 1.18; // radians from +Y down (0.28..1.48)
  private desiredPolar = 1.18;

  private distance = 22;
  private desiredDistance = 22;

  private isOrbiting = false;
  private lastX = 0;
  private lastY = 0;

  private shakeMagnitude = 0;
  private autoRotateSpeed = 0;

  private intro: {
    keyframes: CameraKeyframe[];
    elapsed: number;
    duration: number;
    onComplete?: () => void;
  } | null = null;

  private keyboardEnabled = false;
  private heldKeys = new Set<'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'ZoomIn' | 'ZoomOut'>();

  constructor(camera: THREE.PerspectiveCamera, domElement: HTMLElement) {
    this.camera = camera;
    this.domElement = domElement;
    this.bindEvents();
    this.applyImmediate();
  }

  private bindEvents(): void {
    this.domElement.addEventListener('contextmenu', (e) => e.preventDefault());

    this.domElement.addEventListener('pointerdown', (e) => {
      if (e.button === 2 || e.button === 1 || (e.button === 0 && e.shiftKey)) {
        if (this.intro) this.cancelIntro(false);
        this.isOrbiting = true;
        this.lastX = e.clientX;
        this.lastY = e.clientY;
        this.domElement.style.cursor = 'grabbing';
      }
    });

    window.addEventListener('pointermove', (e) => {
      if (!this.isOrbiting) return;
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;

      this.desiredAzimuth -= dx * 0.0068;
      this.desiredPolar = THREE.MathUtils.clamp(this.desiredPolar - dy * 0.0052, 0.28, 1.46);
    });

    window.addEventListener('pointerup', () => {
      if (this.isOrbiting) {
        this.isOrbiting = false;
        this.domElement.style.cursor = '';
      }
    });

    this.domElement.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        if (this.intro) this.cancelIntro(false);
        const factor = 1 + Math.sign(e.deltaY) * 0.11;
        this.desiredDistance = THREE.MathUtils.clamp(this.desiredDistance * factor, 6.5, 52);
      },
      { passive: false }
    );

    const resolveCameraKey = (
      e: KeyboardEvent
    ): 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'ZoomIn' | 'ZoomOut' | null => {
      if (e.key === 'ArrowLeft') return 'ArrowLeft';
      if (e.key === 'ArrowRight') return 'ArrowRight';
      if (e.key === 'ArrowUp') return 'ArrowUp';
      if (e.key === 'ArrowDown') return 'ArrowDown';
      if (e.code === 'Equal' || e.code === 'NumpadAdd' || e.key === '=' || e.key === '+') {
        return 'ZoomIn';
      }
      if (e.code === 'Minus' || e.code === 'NumpadSubtract' || e.key === '-' || e.key === '_') {
        return 'ZoomOut';
      }
      return null;
    };

    window.addEventListener('keydown', (e) => {
      if (!this.keyboardEnabled || e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      const camKey = resolveCameraKey(e);
      if (!camKey) return;

      e.preventDefault();
      if (this.intro) this.cancelIntro(false);
      if (!e.repeat && !this.heldKeys.has(camKey)) {
        // Immediate subtle nudge so quick single taps feel crisp & responsive
        if (camKey === 'ArrowLeft') this.desiredAzimuth += 0.06;
        else if (camKey === 'ArrowRight') this.desiredAzimuth -= 0.06;
        else if (camKey === 'ArrowUp') {
          this.desiredPolar = THREE.MathUtils.clamp(this.desiredPolar - 0.04, 0.28, 1.46);
        } else if (camKey === 'ArrowDown') {
          this.desiredPolar = THREE.MathUtils.clamp(this.desiredPolar + 0.04, 0.28, 1.46);
        } else if (camKey === 'ZoomIn') {
          this.desiredDistance = THREE.MathUtils.clamp(this.desiredDistance * 0.93, 6.5, 52);
        } else if (camKey === 'ZoomOut') {
          this.desiredDistance = THREE.MathUtils.clamp(this.desiredDistance * 1.075, 6.5, 52);
        }
      }
      this.heldKeys.add(camKey);
    });

    window.addEventListener('keyup', (e) => {
      const camKey = resolveCameraKey(e);
      if (camKey) {
        this.heldKeys.delete(camKey);
      }
    });

    window.addEventListener('blur', () => {
      this.heldKeys.clear();
    });
  }

  public setKeyboardEnabled(enabled: boolean): void {
    this.keyboardEnabled = enabled;
    if (!enabled) {
      this.heldKeys.clear();
    }
  }

  public isUserOrbiting(): boolean {
    return this.isOrbiting;
  }

  public setAutoRotate(speed: number): void {
    this.autoRotateSpeed = speed;
    if (speed !== 0 && this.intro) {
      this.intro = null;
    }
  }

  public isIntroPlaying(): boolean {
    return this.intro !== null;
  }

  public playIntro(
    keyframes: CameraKeyframe[],
    durationSeconds: number,
    onComplete?: () => void
  ): void {
    if (keyframes.length < 2 || durationSeconds <= 0) {
      const end = keyframes[keyframes.length - 1];
      if (end) {
        this.focusOn(end.target, end.distance, end.polar, end.azimuth);
        this.applyImmediate();
      }
      onComplete?.();
      return;
    }

    const cloned = keyframes.map((k) => ({
      target: k.target.clone(),
      distance: k.distance,
      polar: THREE.MathUtils.clamp(k.polar, 0.3, 1.46),
      azimuth: k.azimuth,
    }));

    this.intro = {
      keyframes: cloned,
      elapsed: 0,
      duration: durationSeconds,
      onComplete,
    };

    // Place camera immediately at the opening keyframe
    const start = cloned[0];
    this.target.copy(start.target);
    this.desiredTarget.copy(start.target);
    this.distance = start.distance;
    this.desiredDistance = THREE.MathUtils.clamp(start.distance, 6.5, 52);
    this.polar = start.polar;
    this.desiredPolar = start.polar;
    this.azimuth = start.azimuth;
    this.desiredAzimuth = start.azimuth;
    this.updateCameraTransform();
  }

  public cancelIntro(glideToEnd: boolean): void {
    if (!this.intro) return;
    const { keyframes, onComplete } = this.intro;
    this.intro = null;
    if (glideToEnd) {
      const end = keyframes[keyframes.length - 1];
      this.desiredTarget.copy(end.target);
      this.desiredDistance = THREE.MathUtils.clamp(end.distance, 6.5, 52);
      this.desiredPolar = THREE.MathUtils.clamp(end.polar, 0.28, 1.46);
      const diff = Math.atan2(
        Math.sin(end.azimuth - this.azimuth),
        Math.cos(end.azimuth - this.azimuth)
      );
      this.desiredAzimuth = this.azimuth + diff;
    } else {
      this.desiredTarget.copy(this.target);
      this.desiredDistance = THREE.MathUtils.clamp(this.distance, 6.5, 52);
      this.desiredPolar = THREE.MathUtils.clamp(this.polar, 0.28, 1.46);
      this.desiredAzimuth = this.azimuth;
    }
    onComplete?.();
  }

  public focusOn(
    point: THREE.Vector3,
    distance?: number,
    polar?: number,
    azimuth?: number
  ): void {
    if (this.intro) {
      const cb = this.intro.onComplete;
      this.intro = null;
      cb?.();
    }
    this.desiredTarget.copy(point);
    if (distance !== undefined) this.desiredDistance = THREE.MathUtils.clamp(distance, 6.5, 52);
    if (polar !== undefined) this.desiredPolar = THREE.MathUtils.clamp(polar, 0.28, 1.46);
    if (azimuth !== undefined) {
      // Shortest angular path
      const diff = Math.atan2(
        Math.sin(azimuth - this.desiredAzimuth),
        Math.cos(azimuth - this.desiredAzimuth)
      );
      this.desiredAzimuth += diff;
    }
  }

  public orbitStep(deltaAzimuth: number): void {
    if (this.intro) this.cancelIntro(false);
    this.desiredAzimuth += deltaAzimuth;
  }

  public triggerShake(amount: number): void {
    this.shakeMagnitude = Math.max(this.shakeMagnitude, amount);
  }

  public getAzimuthDeg(): number {
    return ((this.azimuth * 180) / Math.PI) % 360;
  }

  public getTarget(): THREE.Vector3 {
    return this.target;
  }

  public applyImmediate(): void {
    this.target.copy(this.desiredTarget);
    this.azimuth = this.desiredAzimuth;
    this.polar = this.desiredPolar;
    this.distance = this.desiredDistance;
    this.updateCameraTransform();
  }

  public update(dt: number): void {
    if (this.intro) {
      this.intro.elapsed += dt;
      const u = THREE.MathUtils.clamp(this.intro.elapsed / this.intro.duration, 0, 1);
      // Immediate gentle glide-in with a soft, cinematic ease-out landing
      const smooth = u * u * (3 - 2 * u);
      const easeOut = 1 - Math.pow(1 - u, 2.2);
      const t = smooth * 0.65 + easeOut * 0.35;

      const ks = this.intro.keyframes;
      const segCount = ks.length - 1;
      const scaled = t * segCount;
      const idx = Math.min(segCount - 1, Math.floor(scaled));
      const localT = scaled - idx;

      const k0 = ks[Math.max(0, idx - 1)];
      const k1 = ks[idx];
      const k2 = ks[Math.min(segCount, idx + 1)];
      const k3 = ks[Math.min(segCount, idx + 2)];

      this.target.set(
        catmullRom(k0.target.x, k1.target.x, k2.target.x, k3.target.x, localT),
        catmullRom(k0.target.y, k1.target.y, k2.target.y, k3.target.y, localT),
        catmullRom(k0.target.z, k1.target.z, k2.target.z, k3.target.z, localT)
      );
      this.distance = THREE.MathUtils.clamp(
        catmullRom(k0.distance, k1.distance, k2.distance, k3.distance, localT),
        6.5,
        62
      );
      this.polar = THREE.MathUtils.clamp(
        catmullRom(k0.polar, k1.polar, k2.polar, k3.polar, localT),
        0.3,
        1.46
      );
      this.azimuth = catmullRom(k0.azimuth, k1.azimuth, k2.azimuth, k3.azimuth, localT);

      this.desiredTarget.copy(this.target);
      this.desiredDistance = THREE.MathUtils.clamp(this.distance, 6.5, 52);
      this.desiredPolar = this.polar;
      this.desiredAzimuth = this.azimuth;

      if (u >= 1) {
        const end = ks[ks.length - 1];
        const cb = this.intro.onComplete;
        this.intro = null;
        this.target.copy(end.target);
        this.desiredTarget.copy(end.target);
        this.distance = THREE.MathUtils.clamp(end.distance, 6.5, 52);
        this.desiredDistance = this.distance;
        this.polar = THREE.MathUtils.clamp(end.polar, 0.28, 1.46);
        this.desiredPolar = this.polar;
        this.azimuth = end.azimuth;
        this.desiredAzimuth = end.azimuth;
        cb?.();
      }

      this.updateCameraTransform();
      return;
    }

    if (this.keyboardEnabled && this.heldKeys.size > 0) {
      const orbitSpeed = 1.65; // rad/sec
      const pitchSpeed = 1.15; // rad/sec
      const zoomSpeed = 1.45;  // log-distance/sec

      if (this.heldKeys.has('ArrowLeft')) this.desiredAzimuth += orbitSpeed * dt;
      if (this.heldKeys.has('ArrowRight')) this.desiredAzimuth -= orbitSpeed * dt;
      if (this.heldKeys.has('ArrowUp')) {
        this.desiredPolar = THREE.MathUtils.clamp(this.desiredPolar - pitchSpeed * dt, 0.28, 1.46);
      }
      if (this.heldKeys.has('ArrowDown')) {
        this.desiredPolar = THREE.MathUtils.clamp(this.desiredPolar + pitchSpeed * dt, 0.28, 1.46);
      }
      if (this.heldKeys.has('ZoomIn')) {
        this.desiredDistance = THREE.MathUtils.clamp(
          this.desiredDistance * Math.exp(-zoomSpeed * dt),
          6.5,
          52
        );
      }
      if (this.heldKeys.has('ZoomOut')) {
        this.desiredDistance = THREE.MathUtils.clamp(
          this.desiredDistance * Math.exp(zoomSpeed * dt),
          6.5,
          52
        );
      }
    } else if (this.autoRotateSpeed !== 0 && !this.isOrbiting) {
      this.desiredAzimuth += this.autoRotateSpeed * dt;
    }

    const damp = 1 - Math.exp(-7.5 * dt);
    this.target.lerp(this.desiredTarget, damp);
    this.azimuth = THREE.MathUtils.lerp(this.azimuth, this.desiredAzimuth, damp);
    this.polar = THREE.MathUtils.lerp(this.polar, this.desiredPolar, damp);
    this.distance = THREE.MathUtils.lerp(this.distance, this.desiredDistance, damp);

    if (this.shakeMagnitude > 0.001) {
      this.shakeMagnitude *= Math.exp(-5.5 * dt);
    } else {
      this.shakeMagnitude = 0;
    }

    this.updateCameraTransform();
  }

  private updateCameraTransform(): void {
    const sinP = Math.sin(this.polar);
    const cosP = Math.cos(this.polar);

    const camX = this.target.x + this.distance * sinP * Math.cos(this.azimuth);
    const camY = Math.max(1.2, this.target.y + this.distance * cosP);
    const camZ = this.target.z + this.distance * sinP * Math.sin(this.azimuth);

    const sx = (Math.random() - 0.5) * this.shakeMagnitude;
    const sy = (Math.random() - 0.5) * this.shakeMagnitude;
    const sz = (Math.random() - 0.5) * this.shakeMagnitude;

    this.camera.position.set(camX + sx, camY + sy, camZ + sz);
    this.camera.lookAt(this.target.x, this.target.y, this.target.z);
  }
}
