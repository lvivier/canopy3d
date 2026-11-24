import * as THREE from 'three';
import { WeatherId } from '../types';

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
  private fallingBranches: FallingBranch[] = [];
  private rollingLogs: RollingLogSegment[] = [];
  private fallingTopSections: FallingTopSection[] = [];
  private ambientMotes: THREE.Points;
  private rainLines: THREE.LineSegments;
  private rainDrops: Array<{ x: number; y: number; z: number; speed: number; len: number }> = [];
  private weather: WeatherId = 'sunny_morning';
  private chipGeo = new THREE.BoxGeometry(0.11, 0.05, 0.08);
  private dustGeo = new THREE.DodecahedronGeometry(0.32, 0);
  private leafGeo = new THREE.ConeGeometry(0.16, 0.28, 4);

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.ambientMotes = this.createAmbientMotes();
    this.scene.add(this.ambientMotes);
    this.rainLines = this.createRainLines();
    this.rainLines.visible = false;
    this.scene.add(this.rainLines);
  }

  public setWeather(weather: WeatherId): void {
    this.weather = weather;
    const isRain = weather === 'light_rain';
    this.rainLines.visible = isRain;

    const moteMat = this.ambientMotes.material as THREE.PointsMaterial;
    if (isRain) {
      moteMat.color.set('#cfe2e8');
      moteMat.opacity = 0.22;
      moteMat.size = 0.16;
    } else if (weather === 'misty_fog') {
      moteMat.color.set('#e2efee');
      moteMat.opacity = 0.34;
      moteMat.size = 0.16;
    } else {
      moteMat.color.set('#fff6d6');
      moteMat.opacity = 0.42;
      moteMat.size = 0.14;
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
    const count = 160;
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 44;
      positions[i * 3 + 1] = 0.8 + Math.random() * 18;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 44;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      color: '#fff6d6',
      size: 0.14,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
    });
    return new THREE.Points(geo, mat);
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
    const dustMat = new THREE.MeshStandardMaterial({
      color: '#9c8c72',
      transparent: true,
      opacity: 0.55,
      roughness: 1,
      flatShading: true,
    });

    // Billowing dust clouds along the full length of the fallen tree!
    const samples = 14;
    for (let i = 2; i < samples; i++) {
      const dist = (i / samples) * treeHeight;
      const p = new THREE.Vector3(basePos.x + dx * dist, 0.35, basePos.z + dz * dist);
      for (let k = 0; k < 2; k++) {
        const m = new THREE.Mesh(this.dustGeo, dustMat);
        m.position.copy(p).add(
          new THREE.Vector3((Math.random() - 0.5) * 2.2, Math.random() * 0.5, (Math.random() - 0.5) * 2.2)
        );
        const s = 0.8 + Math.random() * 1.2;
        m.scale.setScalar(s);
        this.scene.add(m);
        this.particles.push({
          mesh: m,
          vel: new THREE.Vector3(
            (Math.random() - 0.5) * 3.8,
            1.4 + Math.random() * 2.6,
            (Math.random() - 0.5) * 3.8
          ),
          rotVel: new THREE.Vector3(1, 2, 1),
          age: 0,
          life: 1.3 + Math.random() * 0.9,
          gravity: 0.4,
          drag: 0.93,
          startScale: s,
          endScale: s * 2.4,
        });
      }

      if (i > samples * 0.45) {
        this.spawnFoliageBurst(p.clone().add(new THREE.Vector3(0, 1.0, 0)), foliageColors, 4);
      }
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
    // Ambient drifting coastal motes
    const pos = this.ambientMotes.geometry.attributes.position as THREE.BufferAttribute;
    const wx = Math.cos(windAngle) * (0.25 + windSpeed * 1.4);
    const wz = Math.sin(windAngle) * (0.25 + windSpeed * 1.4);
    for (let i = 0; i < pos.count; i++) {
      let x = pos.getX(i) + wx * dt + Math.sin(elapsed * 0.6 + i) * 0.008;
      let y = pos.getY(i) + Math.cos(elapsed * 0.8 + i * 1.7) * 0.006;
      let z = pos.getZ(i) + wz * dt;
      if (x > 22) x = -22;
      if (x < -22) x = 22;
      if (z > 22) z = -22;
      if (z < -22) z = 22;
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

    // Dynamic chips, sawdust, leaves, dust
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
