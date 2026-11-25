import * as THREE from 'three';
import type { SawHand } from '../types';

export type SawCursorKind = 'prune' | 'chainsaw';

/** A limb, trunk, or cut ring under the cursor. `grain` runs along the wood. */
export interface SawCursorTarget {
  id: string;
  point: THREE.Vector3;
  grain: THREE.Vector3;
  /** Bar lies in the cut plane, perpendicular to the grain. Used on buck and felling rings. */
  across?: boolean;
}

const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _camRight = new THREE.Vector3();
const _camUp = new THREE.Vector3();
const _camForward = new THREE.Vector3();
const _outward = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _pos = new THREE.Vector3();

/** Nose of each saw, in the model's unshifted local space. The group origin is this tip. */
const PRUNE_TIP = new THREE.Vector3(0.64, 0.01, 0);
const CHAIN_TIP = new THREE.Vector3(0.525, 0.04, 0);
const CARRY_ELEVATION = Math.PI / 4;

function basisQuat(xDir: THREE.Vector3, yHint: THREE.Vector3, out: THREE.Quaternion): void {
  _x.copy(xDir).normalize();
  _y.copy(yHint);
  _y.addScaledVector(_x, -_y.dot(_x));
  if (_y.lengthSq() < 1e-6) {
    _y.set(0, 1, 0);
    _y.addScaledVector(_x, -_y.dot(_x));
  }
  _y.normalize();
  _z.crossVectors(_x, _y).normalize();
  _m.makeBasis(_x, _y, _z);
  out.setFromRotationMatrix(_m);
}

function cameraBasis(camera: THREE.Camera): void {
  _camRight.setFromMatrixColumn(camera.matrixWorld, 0);
  _camUp.setFromMatrixColumn(camera.matrixWorld, 1);
  _camForward.setFromMatrixColumn(camera.matrixWorld, 2).negate();
}

/**
 * Ghostly golden saw that rides the cursor. The tip is the pointer.
 * While carried, the blade sits about 45° up and yaws so the tip keeps
 * aiming at the tree as the cursor crosses the view. On a limb or the trunk
 * it swings so the teeth meet the wood and the handle stays in the chosen hand.
 */
export class SawCursor {
  readonly group: THREE.Group;
  private readonly pivot: THREE.Group;
  private readonly prune: THREE.Group;
  private readonly chainsaw: THREE.Group;
  private readonly bodyMat: THREE.MeshStandardMaterial;
  private readonly edgeMat: THREE.MeshStandardMaterial;

  private latchedId: string | null = null;
  private swing = 1;
  /** 0–1 bite into the kerf. A chainsaw plunges; it does not stroke. */
  private plunge = 0;
  private chainRun = 0;
  private readonly chainTeeth: THREE.Object3D[] = [];
  private readonly chainHomeX: number[] = [];
  private readonly latchPos = new THREE.Vector3();
  private readonly latchQuat = new THREE.Quaternion();
  private readonly latchScale = new THREE.Vector3(1, 1, 1);

  constructor() {
    this.bodyMat = new THREE.MeshStandardMaterial({
      color: '#ffe08a',
      emissive: '#e39b14',
      emissiveIntensity: 1.05,
      metalness: 0.42,
      roughness: 0.28,
      transparent: true,
      opacity: 0.74,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    this.edgeMat = new THREE.MeshStandardMaterial({
      color: '#fff4c8',
      emissive: '#ffd56a',
      emissiveIntensity: 1.25,
      metalness: 0.2,
      roughness: 0.35,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
      fog: false,
    });

    this.group = new THREE.Group();
    this.group.name = 'saw-cursor';
    this.group.visible = false;
    this.group.renderOrder = 12;

    this.pivot = new THREE.Group();
    this.prune = buildPruningSaw(this.bodyMat, this.edgeMat);
    this.chainsaw = buildChainsaw(this.bodyMat, this.edgeMat);
    this.prune.position.copy(PRUNE_TIP).multiplyScalar(-1);
    this.chainsaw.position.copy(CHAIN_TIP).multiplyScalar(-1);
    this.pivot.add(this.prune, this.chainsaw);
    this.group.add(this.pivot);
    this.chainsaw.traverse((obj) => {
      if (obj.name === 'chain-tooth') {
        this.chainTeeth.push(obj);
        this.chainHomeX.push(obj.position.x);
      }
    });
  }

  hide(): void {
    this.group.visible = false;
    this.latchedId = null;
    this.swing = 1;
    this.plunge = 0;
    this.pivot.rotation.set(0, 0, 0);
    this.pivot.position.set(0, 0, 0);
  }

  update(opts: {
    dt: number;
    time: number;
    camera: THREE.Camera;
    ray: THREE.Ray;
    kind: SawCursorKind;
    hand: SawHand;
    target: SawCursorTarget | null;
    /** Point on the work the carried tip aims at, usually the active tree. */
    aimAt: THREE.Vector3 | null;
    /** Chainsaw lying beside the bole while the fall direction is still being chosen. */
    rest: { id: string; point: THREE.Vector3; dir: THREE.Vector3 } | null;
    cutting: boolean;
    floatDistance: number;
  }): void {
    const { dt, time, camera, ray, kind, hand, target, aimAt, rest, cutting } = opts;
    this.prune.visible = kind === 'prune';
    this.chainsaw.visible = kind === 'chainsaw';
    // Right hand: tip reaches to the viewer's left. Left hand is the mirror.
    const tipSign = hand === 'left' ? 1 : -1;
    const planted = kind === 'chainsaw' && rest !== null;

    cameraBasis(camera);
    let id: string | null = null;

    if (planted && rest) {
      id = `rest:${rest.id}`;
      _pos.copy(rest.point);
      _x.copy(rest.dir);
      _x.y = 0;
      if (_x.lengthSq() < 1e-6) _x.set(1, 0, 0);
      _x.normalize();
      // Flat on the ground: the bar's broad face is horizontal, handles up.
      _fwd.set(0, 1, 0).cross(_x);
      basisQuat(_x, _fwd, _quat);
    } else if (target) {
      id = `${kind}:${target.id}`;
      const dist = Math.max(1.4, camera.position.distanceTo(target.point));
      const lift = dist * 0.105 * 0.22;
      _pos.copy(target.point);
      _outward.copy(camera.position).sub(target.point);
      if (_outward.lengthSq() < 1e-4) _outward.copy(_camForward);
      _outward.normalize();
      _pos.addScaledVector(_outward, lift);

      const grain = target.grain;
      if (target.across) {
        this.poseAcrossGrain(camera, grain, tipSign);
      } else {
        // Tip crosses the grain toward the free side, so the handle stays in the chosen hand.
        _x.copy(_camRight).multiplyScalar(tipSign);
        _x.addScaledVector(grain, -_x.dot(grain));
        if (_x.lengthSq() < 0.06) _x.copy(_camRight).multiplyScalar(tipSign);
        _x.normalize();
        if (_x.dot(_camRight) * tipSign < 0) _x.negate();
        _y.copy(_camUp).addScaledVector(_outward, 0.5);
        basisQuat(_x, _y, _quat);
      }
    } else {
      const dist = THREE.MathUtils.clamp(opts.floatDistance, 2.1, 9);
      _pos.copy(ray.origin).addScaledVector(ray.direction, dist);
      // Tip up at 45°, yawed so it keeps pointing at the tree as the cursor slides sideways.
      _fwd.copy(_camForward);
      _fwd.y = 0;
      if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, -1);
      _fwd.normalize();
      if (aimAt) {
        _x.set(aimAt.x - _pos.x, 0, aimAt.z - _pos.z);
        const horiz = _x.length();
        if (horiz < 0.45) {
          _x.copy(_fwd);
        } else {
          _x.multiplyScalar(1 / horiz);
          if (horiz < 2.4) _x.lerp(_fwd, 1 - (horiz - 0.45) / 1.95).normalize();
        }
      } else {
        _x.copy(_fwd);
      }
      const rise = Math.sin(CARRY_ELEVATION);
      const run = Math.cos(CARRY_ELEVATION);
      _x.multiplyScalar(run);
      _x.y = rise;
      _outward.copy(camera.position).sub(_pos);
      if (_outward.lengthSq() < 1e-4) _outward.copy(_camForward).negate();
      _outward.normalize();
      _y.copy(_camUp).addScaledVector(_outward, 0.6).addScaledVector(_camRight, -0.28 * tipSign);
      basisQuat(_x, _y, _quat);
    }

    if (kind === 'chainsaw' && cutting) this.plunge = Math.min(1, this.plunge + dt * 0.9);
    else this.plunge = Math.max(0, this.plunge - dt * 3.2);
    if (this.plunge > 0 && !planted) {
      // The chain pulls the bar deeper into the kerf. It never strokes back out.
      _outward.set(1, 0, 0).applyQuaternion(_quat);
      _pos.addScaledVector(_outward, this.plunge * 0.05);
    }

    const dist = Math.max(1.4, _pos.distanceTo(camera.position));
    const scale = planted ? 0.95 : dist * 0.11;
    this.bodyMat.depthTest = planted;
    this.edgeMat.depthTest = planted;

    const appear = !this.group.visible;
    this.group.visible = true;
    if (appear) {
      this.group.position.copy(_pos);
      this.group.quaternion.copy(_quat);
      this.group.scale.setScalar(scale);
      this.latchedId = id;
      this.swing = 1;
      this.pivot.rotation.set(0, 0, 0);
    } else if (id !== this.latchedId) {
      this.latchPos.copy(this.group.position);
      this.latchQuat.copy(this.group.quaternion);
      this.latchScale.copy(this.group.scale);
      this.latchedId = id;
      this.swing = 0;
    }

    if (this.swing < 1) {
      this.swing = Math.min(1, this.swing + dt * 5.2);
      const t = this.swing * this.swing * (3 - 2 * this.swing);
      this.group.position.lerpVectors(this.latchPos, _pos, t);
      this.group.quaternion.slerpQuaternions(this.latchQuat, _quat, t);
      this.group.scale.lerpVectors(this.latchScale, _z.set(scale, scale, scale), t);
      // Arc through the alignment so the saw visibly swings onto the cut.
      this.pivot.rotation.z = Math.sin(t * Math.PI) * 0.95;
      this.pivot.rotation.x = Math.sin(t * Math.PI) * -0.28;
    } else {
      const k = 1 - Math.exp(-dt * (target || planted ? 16 : 9));
      // Carried, the tip stays on the pointer. A saw at rest eases onto the ground.
      if (planted || target) this.group.position.lerp(_pos, k);
      else this.group.position.copy(_pos);
      this.group.quaternion.slerp(_quat, k);
      this.group.scale.lerp(_z.set(scale, scale, scale), k);
      this.pivot.rotation.z += (0 - this.pivot.rotation.z) * k;
      this.pivot.rotation.x += (0 - this.pivot.rotation.x) * k;
    }

    const stroke = cutting && kind === 'prune' ? Math.sin(time * 16) * 0.05 : 0;
    this.pivot.position.x = stroke;
    this.pivot.position.y = cutting && kind === 'chainsaw' ? Math.sin(time * 92) * 0.003 : 0;
    if (cutting && kind === 'chainsaw') this.scrollChain(dt);
    const breathe = 0.7 + Math.sin(time * 3.1) * 0.08;
    this.bodyMat.opacity = breathe;
    this.edgeMat.opacity = Math.min(1, breathe + 0.16);
  }

  /**
   * Bar in the plane of the cut ring: the tip crosses the grain and noses
   * down into the kerf, with the powerhead on the chosen-hand side.
   */
  private poseAcrossGrain(camera: THREE.Camera, grain: THREE.Vector3, tipSign: number): void {
    _fwd.copy(grain).normalize();
    _x.copy(_pos).sub(camera.position);
    _x.addScaledVector(_fwd, -_x.dot(_fwd));
    _outward.set(0, -1, 0);
    _outward.addScaledVector(_fwd, -_outward.dot(_fwd));
    if (_outward.lengthSq() > 1e-4) _x.addScaledVector(_outward, 0.9);
    _outward.copy(_camRight).multiplyScalar(tipSign);
    _outward.addScaledVector(_fwd, -_outward.dot(_fwd));
    if (_outward.lengthSq() > 1e-4) _x.addScaledVector(_outward, 0.55);
    if (_x.lengthSq() < 1e-4) {
      _x.copy(_camUp);
      _x.addScaledVector(_fwd, -_x.dot(_fwd));
    }
    _x.normalize();
    _y.set(0, 1, 0);
    _y.addScaledVector(_fwd, -_y.dot(_fwd));
    _y.addScaledVector(_x, -_y.dot(_x));
    if (_y.lengthSq() < 1e-4) {
      _y.copy(_camUp);
      _y.addScaledVector(_fwd, -_y.dot(_fwd));
      _y.addScaledVector(_x, -_y.dot(_x));
    }
    if (_y.y < 0) _y.negate();
    basisQuat(_x, _y, _quat);
  }

  /** Bottom chain runs toward the powerhead, the way a cutting chain pulls. */
  private scrollChain(dt: number): void {
    this.chainRun += dt * 1.15;
    const span = 0.74;
    const heel = -0.26;
    for (let i = 0; i < this.chainTeeth.length; i++) {
      let x = this.chainHomeX[i] - this.chainRun;
      while (x < heel) x += span;
      this.chainTeeth[i].position.x = x;
    }
  }
}

function tag(mesh: THREE.Mesh): THREE.Mesh {
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.renderOrder = 12;
  mesh.frustumCulled = false;
  return mesh;
}

function buildPruningSaw(body: THREE.Material, edge: THREE.Material): THREE.Group {
  const group = new THREE.Group();
  const shape = new THREE.Shape();
  const heel = -0.04;
  const tip = 0.64;
  shape.moveTo(heel, 0.07);
  shape.quadraticCurveTo(0.3, 0.105, tip - 0.03, 0.038);
  shape.lineTo(tip, 0.01);
  const teeth = 15;
  for (let i = 0; i <= teeth; i++) {
    const t = i / teeth;
    const x = tip - t * (tip - heel);
    shape.lineTo(x, i % 2 === 0 ? -0.02 : 0.006);
  }
  shape.closePath();
  const bladeGeo = new THREE.ExtrudeGeometry(shape, {
    depth: 0.04,
    bevelEnabled: true,
    bevelThickness: 0.004,
    bevelSize: 0.004,
    bevelSegments: 1,
  });
  bladeGeo.translate(0, 0, -0.02);
  group.add(tag(new THREE.Mesh(bladeGeo, edge)));

  const grip = tag(
    new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.03, 0.18, 10), body)
  );
  grip.position.set(-0.2, 0.02, 0);
  group.add(grip);

  const bow = tag(new THREE.Mesh(new THREE.TorusGeometry(0.085, 0.016, 8, 16, Math.PI * 1.35), body));
  bow.position.set(-0.2, 0.02, 0);
  bow.rotation.z = Math.PI * 0.85;
  group.add(bow);

  const horn = tag(new THREE.Mesh(new THREE.SphereGeometry(0.028, 8, 8), body));
  horn.position.set(-0.2, 0.115, 0);
  group.add(horn);
  return group;
}

function buildChainsaw(body: THREE.Material, edge: THREE.Material): THREE.Group {
  const group = new THREE.Group();

  const bar = tag(new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.07, 0.045), body));
  bar.position.set(0.1, 0.04, 0);
  group.add(bar);

  const tip = tag(new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.046, 12), body));
  tip.rotation.x = Math.PI / 2;
  tip.position.set(0.49, 0.04, 0);
  group.add(tip);

  const chain = tag(new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.012, 0.05), edge));
  chain.position.set(0.1, 0.004, 0);
  group.add(chain);
  const chainTop = tag(new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.012, 0.05), edge));
  chainTop.position.set(0.1, 0.076, 0);
  group.add(chainTop);

  const powerhead = tag(new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.2, 0.15), body));
  powerhead.position.set(-0.4, 0.07, 0);
  group.add(powerhead);

  const rear = tag(new THREE.Mesh(new THREE.TorusGeometry(0.09, 0.018, 8, 14, Math.PI * 1.65), body));
  rear.position.set(-0.6, 0.04, 0);
  rear.rotation.z = Math.PI * 0.15;
  group.add(rear);

  const front = tag(new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.016, 8, 14, Math.PI * 1.2), body));
  front.rotation.y = Math.PI / 2;
  front.rotation.x = 0.35;
  front.position.set(-0.24, 0.14, 0);
  group.add(front);

  const toothCount = 8;
  for (let i = 0; i < toothCount; i++) {
    const tooth = tag(new THREE.Mesh(new THREE.BoxGeometry(0.034, 0.02, 0.058), edge));
    tooth.name = 'chain-tooth';
    tooth.position.set(-0.22 + (i / (toothCount - 1)) * 0.68, -0.006, 0);
    group.add(tooth);
  }

  return group;
}
