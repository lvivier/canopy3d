import * as THREE from 'three';

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
  vel: THREE.Vector3;
  rotVel: THREE.Vector3;
  age: number;
  settled: boolean;
}

export class ParticleSystem {
  private scene: THREE.Scene;
  private particles: DynamicParticle[] = [];
  private fallingBranches: FallingBranch[] = [];
  private ambientMotes: THREE.Points;
  private chipGeo = new THREE.BoxGeometry(0.11, 0.05, 0.08);
  private dustGeo = new THREE.DodecahedronGeometry(0.32, 0);
  private leafGeo = new THREE.ConeGeometry(0.16, 0.28, 4);

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.ambientMotes = this.createAmbientMotes();
    this.scene.add(this.ambientMotes);
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

    this.fallingBranches.push({
      group: branchGroup,
      vel: outDir.clone().multiplyScalar(1.9).add(new THREE.Vector3(0, 0.8, 0)),
      rotVel: new THREE.Vector3(
        (Math.random() - 0.5) * 2.5,
        (Math.random() - 0.5) * 1.4,
        (Math.random() - 0.5) * 2.5
      ),
      age: 0,
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

    // Detached pruned branches tumbling to the forest floor
    for (let i = this.fallingBranches.length - 1; i >= 0; i--) {
      const fb = this.fallingBranches[i];
      fb.age += dt;
      if (!fb.settled) {
        fb.vel.y -= 11.5 * dt;
        fb.group.position.addScaledVector(fb.vel, dt);
        fb.group.rotation.x += fb.rotVel.x * dt;
        fb.group.rotation.y += fb.rotVel.y * dt;
        fb.group.rotation.z += fb.rotVel.z * dt;
        if (fb.group.position.y <= 0.45) {
          fb.group.position.y = 0.45;
          if (Math.abs(fb.vel.y) > 1.8) {
            fb.vel.y *= -0.22;
            fb.vel.x *= 0.45;
            fb.vel.z *= 0.45;
            fb.rotVel.multiplyScalar(0.35);
          } else {
            fb.settled = true;
          }
        }
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
  }
}
