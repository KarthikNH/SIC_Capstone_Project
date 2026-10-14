import React, { useRef, useMemo } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import * as THREE from 'three';

interface HeroSceneProps {
  buses: Array<{ x: number; y: number; z: number }>;
  branches: Array<{ from: number; to: number }>;
}

const RotatingGrid: React.FC<HeroSceneProps> = ({ buses, branches }) => {
  const groupRef = useRef<THREE.Group>(null);

  // Line segments geometry
  const lineGeometry = useMemo(() => {
    if (buses.length === 0 || branches.length === 0) return null;
    const positions: number[] = [];
    branches.forEach((b) => {
      const p1 = buses[b.from];
      const p2 = buses[b.to];
      if (p1 && p2) {
        positions.push(p1.x, p1.y, p1.z);
        positions.push(p2.x, p2.y, p2.z);
      }
    });
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    return geom;
  }, [buses, branches]);

  // Node points geometry
  const pointsGeometry = useMemo(() => {
    if (buses.length === 0) return null;
    const positions: number[] = [];
    buses.forEach((p) => {
      positions.push(p.x, p.y, p.z);
    });
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    return geom;
  }, [buses]);

  // Slow, serene rotation
  useFrame((_, delta) => {
    if (groupRef.current) {
      groupRef.current.rotation.y += delta * 0.08;
    }
  });

  return (
    <group ref={groupRef}>
      {lineGeometry && (
        <lineSegments geometry={lineGeometry}>
          <lineBasicMaterial color="#ffffff" opacity={0.35} transparent depthWrite={false} />
        </lineSegments>
      )}

      {pointsGeometry && (
        <points geometry={pointsGeometry}>
          <pointsMaterial color="#ffffff" size={0.08} sizeAttenuation opacity={0.85} transparent />
        </points>
      )}
    </group>
  );
};

export const HeroScene: React.FC = () => {
  // Synthetic harmonious grid nodes for full-bleed hero rotation
  const { buses, branches } = useMemo(() => {
    const nodes: Array<{ x: number; y: number; z: number }> = [];
    let sd = 11;
    const rnd = () => (sd = (sd * 16807) % 2147483647) / 2147483647;

    for (let i = 0; i < 28; i++) {
      const a = rnd() * 6.283;
      const r = 0.4 + rnd() * 1.6;
      nodes.push({
        x: Math.cos(a) * r * 1.8,
        y: (rnd() - 0.5) * 1.1,
        z: Math.sin(a) * r * 1.4
      });
    }

    const edges: Array<{ from: number; to: number }> = [];
    nodes.forEach((_, i) => {
      let count = 0;
      nodes
        .map((_, j) => j)
        .filter((j) => j !== i)
        .sort((p, q) => {
          const d1 = Math.hypot(nodes[i].x - nodes[p].x, nodes[i].y - nodes[p].y, nodes[i].z - nodes[p].z);
          const d2 = Math.hypot(nodes[i].x - nodes[q].x, nodes[i].y - nodes[q].y, nodes[i].z - nodes[q].z);
          return d1 - d2;
        })
        .forEach((j) => {
          if (count < 2 && !edges.some((e) => (e.from === i && e.to === j) || (e.from === j && e.to === i))) {
            edges.push({ from: i, to: j });
            count++;
          }
        });
    });

    return { buses: nodes, branches: edges };
  }, []);

  return (
    <div className="absolute inset-0 w-full h-full pointer-events-none">
      <Canvas
        camera={{ position: [0, 0.8, 4.2], fov: 48 }}
        gl={{ alpha: true, antialias: true }}
        style={{ background: 'transparent' }}
      >
        <ambientLight intensity={0.8} />
        <RotatingGrid buses={buses} branches={branches} />
      </Canvas>
    </div>
  );
};
