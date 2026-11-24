import * as THREE from 'three';

/**
 * Smooth mouse-driven orbital camera controller with smart contextual focus
 * and impact camera shake.
 * - Right-click drag or Middle-click drag orbits around current target
 * - Scroll wheel zooms smoothly
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

  public applyImmediate(): void {
    this.target.copy(this.desiredTarget);
    this.azimuth = this.desiredAzimuth;
    this.polar = this.desiredPolar;
    this.distance = this.desiredDistance;
    this.updateCameraTransform();
  }

  public update(dt: number): void {
    if (this.autoRotateSpeed !== 0 && !this.isOrbiting) {
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
