import * as THREE from 'three';

/**
 * Smooth mouse & keyboard orbital camera controller with smart contextual focus
 * and impact camera shake.
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
  }

  public focusOn(
    point: THREE.Vector3,
    distance?: number,
    polar?: number,
    azimuth?: number
  ): void {
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
