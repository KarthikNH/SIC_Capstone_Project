import React, { useRef, useMemo, useState, useEffect, useCallback } from 'react';
import { Canvas, useFrame, useLoader, useThree } from '@react-three/fiber';
import { OrbitControls, Html } from '@react-three/drei';
import * as THREE from 'three';
import { useGridStore } from '../store';
import type { Bus, Branch, BusLayout } from '../types';
import { Scissors, AlertTriangle, RotateCcw } from 'lucide-react';
import { CityScene } from './CityScene';
import { formatBranchName } from '../utils/probability';

// Color Palette for Estate theme
const COLOR_NORMAL = new THREE.Color('#9aa3ad');
const COLOR_STRESSED = new THREE.Color('#d98a1f');
const COLOR_OVERLOADED = new THREE.Color('#c8443b');
const COLOR_OUTAGED = new THREE.Color('#e02424');
const COLOR_ISOLATED = new THREE.Color('#4a5568');
const COLOR_BRIDGE = new THREE.Color('#eab308');

const COMMUNITY_COLORS = [
  '#2563eb', // Blue
  '#16a34a', // Green
  '#d97706', // Amber
  '#9333ea', // Purple
  '#db2777', // Pink
  '#0891b2', // Cyan
  '#ea580c', // Orange
  '#4f46e5'  // Indigo
];

const getLoadingColor = (loading: number, isOutaged: boolean, isIsolated: boolean = false): THREE.Color => {
  if (isOutaged) return COLOR_OUTAGED.clone();
  if (isIsolated) return COLOR_ISOLATED.clone();
  if (loading >= 100) return COLOR_OVERLOADED.clone();
  if (loading >= 65) return COLOR_STRESSED.clone();
  return COLOR_NORMAL.clone();
};

interface TooltipInfo {
  type: 'branch' | 'bus';
  x: number;
  y: number;
  title: string;
  details: string[];
  actionHint?: string;
}

// -----------------------------------------------------------------------------
// Camera Controller with Smooth 3D <-> Map Transition
// -----------------------------------------------------------------------------
const SceneCameraController: React.FC<{
  cameraResetTrigger: number;
  shakeIntensity: number;
  reducedMotion: boolean;
  viewMode: '3d' | 'map';
  gridRadius: number;
  gridCase?: string;
  framingCentroid?: [number, number, number] | null;
}> = ({ cameraResetTrigger, shakeIntensity, reducedMotion, viewMode, gridRadius, gridCase, framingCentroid }) => {
  const controlsRef = useRef<any>(null);
  const { camera } = useThree();
  const lastInteractionTime = useRef<number>(Date.now());
  const isUserInteracting = useRef<boolean>(false);

  // Track when viewMode actually changes to trigger a one-shot transition
  const prevViewMode = useRef<'3d' | 'map'>(viewMode);
  const transitionTarget = useRef<THREE.Vector3 | null>(null);
  const transitionStartTime = useRef<number>(0);
  const TRANSITION_DURATION = 0.55;

  // Gentle framing toward newly affected lines (cancelable by user interaction)
  const prevCentroidRef = useRef<[number, number, number] | null>(null);
  useEffect(() => {
    if (reducedMotion || !framingCentroid || isUserInteracting.current) return;
    if (
      prevCentroidRef.current &&
      prevCentroidRef.current[0] === framingCentroid[0] &&
      prevCentroidRef.current[1] === framingCentroid[1] &&
      prevCentroidRef.current[2] === framingCentroid[2]
    ) {
      return;
    }
    prevCentroidRef.current = framingCentroid;
    if (controlsRef.current) {
      const targetV = new THREE.Vector3(...framingCentroid);
      controlsRef.current.target.lerp(targetV, 0.45);
      controlsRef.current.update();
    }
  }, [framingCentroid, reducedMotion]);

  // Derive camera positions scaled to the grid bounding sphere radius with ~10% padding
  const r = Math.max(3.5, gridRadius);
  const pos3D = useMemo(() => new THREE.Vector3(0, r * 0.72, r * 2.05), [r]);
  const posMap = useMemo(() => new THREE.Vector3(0, r * 2.45, 0.001), [r]);

  // Explicit Reset Camera or Grid Switch – snap to full-grid view with ~10% padding
  useEffect(() => {
    if (!controlsRef.current) return;
    const targetPos = viewMode === 'map' ? posMap : pos3D;
    camera.position.copy(targetPos);
    controlsRef.current.target.set(0, 0, 0);
    controlsRef.current.update();
    transitionTarget.current = null;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraResetTrigger, r, gridCase]);

  // viewMode change – start one-shot transition (no controls.reset())
  useEffect(() => {
    if (prevViewMode.current === viewMode) return;
    prevViewMode.current = viewMode;
    transitionTarget.current = (viewMode === 'map' ? posMap : pos3D).clone();
    transitionStartTime.current = performance.now() / 1000;
  }, [viewMode, pos3D, posMap]);

  // Keep distance limits in sync whenever grid radius changes
  useEffect(() => {
    if (!controlsRef.current) return;
    controlsRef.current.minDistance = r * 0.15;
    controlsRef.current.maxDistance = r * 4.0;
    controlsRef.current.update();
  }, [r]);

  useFrame(({ clock }, delta) => {
    const controls = controlsRef.current;
    if (!controls) return;

    // One-shot view-mode transition – only while the user is not interacting
    if (transitionTarget.current && !isUserInteracting.current) {
      const elapsed = performance.now() / 1000 - transitionStartTime.current;
      const t = Math.min(1, elapsed / TRANSITION_DURATION);
      const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
      camera.position.lerp(transitionTarget.current, Math.min(0.18, eased * 0.18 + delta * 3.5));
      controls.target.lerp(new THREE.Vector3(0, 0, 0), Math.min(1, delta * 5.0));
      controls.update();
      if (t >= 1.0) transitionTarget.current = null;
    }

    // Per-mode constraints (no camera writes beyond transition above)
    if (viewMode === 'map') {
      controls.autoRotate = false;
      controls.maxPolarAngle = Math.PI / 2.1;
    } else {
      controls.maxPolarAngle = Math.PI;
    }

    // Idle drift – 3D mode only, paused immediately on any interaction
    if (!reducedMotion) {
      const idleSeconds = (Date.now() - lastInteractionTime.current) / 1000.0;
      if (viewMode === '3d' && !isUserInteracting.current && idleSeconds > 4.0) {
        controls.autoRotate = true;
        controls.autoRotateSpeed = 0.35;
      } else {
        controls.autoRotate = false;
      }
    } else {
      controls.autoRotate = false;
    }

    // Additive camera shake during cascade trips (never overrides zoom distance)
    if (shakeIntensity > 0) {
      const t = clock.getElapsedTime() * 35.0;
      const decay = Math.max(0, shakeIntensity);
      camera.position.x += Math.sin(t) * 0.04 * decay;
      camera.position.y += Math.cos(t * 1.3) * 0.04 * decay;
    }
  });

  return (
    <OrbitControls
      ref={controlsRef}
      makeDefault
      enableDamping
      dampingFactor={0.08}
      rotateSpeed={0.75}
      zoomSpeed={1.0}
      zoomToCursor
      panSpeed={0.9}
      minDistance={r * 0.15}
      maxDistance={r * 4.0}
      onStart={() => {
        isUserInteracting.current = true;
        lastInteractionTime.current = Date.now();
        // Cancel any in-flight view-mode transition so it doesn't fight the user
        transitionTarget.current = null;
      }}
      onEnd={() => {
        isUserInteracting.current = false;
        lastInteractionTime.current = Date.now();
      }}
      onChange={() => {
        lastInteractionTime.current = Date.now();
      }}
    />
  );
};
// Expanding Shockwave Ripple on Outage Occurrence
// -----------------------------------------------------------------------------
const ShockwaveRing: React.FC<{
  origin: [number, number, number] | null;
  triggerTime: number;
  reducedMotion: boolean;
}> = ({ origin, triggerTime, reducedMotion }) => {
  const meshRef = useRef<THREE.Mesh>(null);

  useFrame(() => {
    if (!meshRef.current || !origin || reducedMotion) return;
    const elapsed = (Date.now() - triggerTime) / 1000.0;
    if (elapsed < 1.0) {
      meshRef.current.visible = true;
      const scale = 0.2 + elapsed * 5.0;
      meshRef.current.scale.set(scale, scale, scale);
      const mat = meshRef.current.material as THREE.MeshBasicMaterial;
      mat.opacity = Math.max(0, 0.8 * (1.0 - elapsed));
    } else {
      meshRef.current.visible = false;
    }
  });

  if (!origin || reducedMotion) return null;

  return (
    <mesh ref={meshRef} position={origin} rotation={[-Math.PI / 2, 0, 0]} visible={false}>
      <ringGeometry args={[0.3, 0.4, 32]} />
      <meshBasicMaterial color="#c8443b" transparent opacity={0.8} side={THREE.DoubleSide} />
    </mesh>
  );
};

// -----------------------------------------------------------------------------
// Spark Burst Particles on Tripping
// -----------------------------------------------------------------------------
const TrippingSparks: React.FC<{
  sparks: Array<{ pos: [number, number, number]; time: number }>;
  reducedMotion: boolean;
}> = ({ sparks, reducedMotion }) => {
  const pointsRef = useRef<THREE.Points>(null);

  useFrame(() => {
    if (!pointsRef.current || reducedMotion) return;
    const mat = pointsRef.current.material as THREE.PointsMaterial;
    if (sparks.length > 0) {
      const latest = sparks[sparks.length - 1];
      const elapsed = (Date.now() - latest.time) / 1000.0;
      if (elapsed < 0.8) {
        mat.opacity = Math.max(0, 1.0 - elapsed / 0.8);
      } else {
        mat.opacity = 0;
      }
    }
  });

  const positions = useMemo(() => {
    const arr: number[] = [];
    sparks.forEach((s) => {
      for (let i = 0; i < 24; i++) {
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.random() * Math.PI;
        const r = 0.15 + Math.random() * 0.35;
        arr.push(
          s.pos[0] + r * Math.sin(phi) * Math.cos(theta),
          s.pos[1] + r * Math.sin(phi) * Math.sin(theta),
          s.pos[2] + r * Math.cos(phi)
        );
      }
    });
    return new Float32Array(arr);
  }, [sparks]);

  if (reducedMotion || sparks.length === 0) return null;

  return (
    <points ref={pointsRef}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <pointsMaterial size={0.08} color="#f59e0b" transparent opacity={0.9} />
    </points>
  );
};

// -----------------------------------------------------------------------------
// Interactive Raycast Hit Cylinders & Line Rendering
// -----------------------------------------------------------------------------
interface BranchNetworkProps {
  branches: Branch[];
  activeLayoutMap: Record<number, { x: number; y: number; z: number }>;
  outagedLines: number[];
  branchLoading: Record<string, number>;
  isolatedBranches: Set<number>;
  hoveredBranchId: number | null;
  onHoverBranch: (br: Branch | null, e?: any) => void;
  onClickBranch: (br: Branch, isShift: boolean) => void;
  reducedMotion: boolean;
  glowInfluentialBranchIds?: Set<number>;
  showCriticality?: boolean;
  branchCriticalityMap?: Record<number, number>;
  showMaintenanceOverlay?: boolean;
  maintenancePriorityMap?: Record<number, { priority: number; color: string; urgency: string }> | null;
  isBridgeMode?: boolean;
  bridgeBranchIds?: Set<number>;
  newlyTrippedBranchIds?: Set<number>;
  previouslyTrippedBranchIds?: Set<number>;
  overloadedBranchIds?: Set<number>;
}

const BranchNetwork: React.FC<BranchNetworkProps> = ({
  branches,
  activeLayoutMap,
  outagedLines,
  branchLoading,
  isolatedBranches,
  hoveredBranchId,
  onHoverBranch,
  onClickBranch,
  reducedMotion,
  glowInfluentialBranchIds,
  showCriticality,
  branchCriticalityMap,
  showMaintenanceOverlay,
  maintenancePriorityMap,
  isBridgeMode,
  bridgeBranchIds,
  newlyTrippedBranchIds,
  previouslyTrippedBranchIds,
  overloadedBranchIds,
}) => {
  const particlesRef = useRef<THREE.Points>(null);
  const linesRef = useRef<THREE.LineSegments>(null);

  // Build broken and continuous line geometries
  const { linePositions, lineColors, particleData, outagedMarkers, overloadedMarkers } = useMemo(() => {
    const pos: number[] = [];
    const cols: number[] = [];
    const pData: Array<{
      from: [number, number, number];
      to: [number, number, number];
      speed: number;
      phase: number;
      color: THREE.Color;
    }> = [];
    const markers: Array<{
      id: number;
      name: string;
      mid: [number, number, number];
      isNewlyTripped?: boolean;
      isPreviouslyTripped?: boolean;
    }> = [];
    const overMarkers: Array<{ id: number; name: string; mid: [number, number, number] }> = [];

    branches.forEach((br) => {
      const p1 = activeLayoutMap[br.from_bus];
      const p2 = activeLayoutMap[br.to_bus];
      if (!p1 || !p2) return;

      const isNewly = newlyTrippedBranchIds?.has(br.id) ?? false;
      const isPrev = previouslyTrippedBranchIds?.has(br.id) ?? false;
      const isOver = (overloadedBranchIds?.has(br.id) ?? false) && !isNewly && !isPrev;
      const isOut = outagedLines.includes(br.id) || isNewly || isPrev;
      const isIso = isolatedBranches.has(br.id);
      const isHovered = hoveredBranchId === br.id;
      const isBridge = bridgeBranchIds?.has(br.id);
      const load = branchLoading[String(br.id)] ?? 35.0;

      let c: THREE.Color;
      if (isNewly) {
        c = new THREE.Color('#ef4444');
      } else if (isPrev) {
        c = new THREE.Color('#64748b');
      } else if (isOver) {
        c = new THREE.Color('#f59e0b');
      } else if (isOut) {
        c = COLOR_OUTAGED.clone();
      } else if (isBridgeMode && isBridge) {
        c = COLOR_BRIDGE.clone();
      } else if (showMaintenanceOverlay && maintenancePriorityMap && maintenancePriorityMap[br.id] !== undefined) {
        c = new THREE.Color(maintenancePriorityMap[br.id].color);
      } else if (showCriticality && branchCriticalityMap && branchCriticalityMap[br.id] !== undefined) {
        const critRisk = branchCriticalityMap[br.id];
        if (critRisk >= 0.7) c = COLOR_OVERLOADED.clone();
        else if (critRisk >= 0.35) c = COLOR_STRESSED.clone();
        else c = new THREE.Color('#38bdf8');
      } else if (glowInfluentialBranchIds && glowInfluentialBranchIds.has(br.id)) {
        c = new THREE.Color('#0284c7');
      } else {
        c = getLoadingColor(load, isOut, isIso);
      }

      if (isHovered) {
        c = c.clone().offsetHSL(0, 0.2, 0.25);
      }

      const midX = (p1.x + p2.x) * 0.5;
      const midY = (p1.y + p2.y) * 0.5;
      const midZ = (p1.z + p2.z) * 0.5;

      if (isPrev) {
        // Dashed grey line for previously tripped lines
        const nDash = 4;
        for (let di = 0; di < nDash; di++) {
          const t1 = (di * 2) / (nDash * 2);
          const t2 = (di * 2 + 1) / (nDash * 2);
          pos.push(
            p1.x + (p2.x - p1.x) * t1, p1.y + (p2.y - p1.y) * t1, p1.z + (p2.z - p1.z) * t1,
            p1.x + (p2.x - p1.x) * t2, p1.y + (p2.y - p1.y) * t2, p1.z + (p2.z - p1.z) * t2
          );
          cols.push(c.r, c.g, c.b, c.r, c.g, c.b);
        }
        markers.push({
          id: br.id,
          name: br.name || formatBranchName(br.from_bus, br.to_bus, 1),
          mid: [midX, midY, midZ],
          isPreviouslyTripped: true,
        });
      } else if (isOut) {
        // BREAK IN THE MIDDLE: Two separate half-segments ending with visible gap
        const gap1X = p1.x + (midX - p1.x) * 0.75;
        const gap1Y = p1.y + (midY - p1.y) * 0.75;
        const gap1Z = p1.z + (midZ - p1.z) * 0.75;

        const gap2X = p2.x + (midX - p2.x) * 0.75;
        const gap2Y = p2.y + (midY - p2.y) * 0.75;
        const gap2Z = p2.z + (midZ - p2.z) * 0.75;

        // Half 1
        pos.push(p1.x, p1.y, p1.z);
        pos.push(gap1X, gap1Y, gap1Z);
        cols.push(c.r, c.g, c.b, c.r, c.g, c.b);

        // Half 2
        pos.push(gap2X, gap2Y, gap2Z);
        pos.push(p2.x, p2.y, p2.z);
        cols.push(c.r, c.g, c.b, c.r, c.g, c.b);

        markers.push({
          id: br.id,
          name: br.name || formatBranchName(br.from_bus, br.to_bus, 1),
          mid: [midX, midY, midZ],
          isNewlyTripped: isNewly,
        });
      } else {
        // Continuous line
        pos.push(p1.x, p1.y, p1.z);
        pos.push(p2.x, p2.y, p2.z);
        cols.push(c.r, c.g, c.b, c.r, c.g, c.b);

        if (isOver) {
          overMarkers.push({
            id: br.id,
            name: br.name || formatBranchName(br.from_bus, br.to_bus, 1),
            mid: [midX, midY, midZ],
          });
        }

        // Flow particles
        if (!reducedMotion && !isIso) {
          const speed = Math.max(0.1, Math.min(1.2, 0.15 + (load / 100.0) * 0.5));
          pData.push({
            from: [p1.x, p1.y, p1.z],
            to: [p2.x, p2.y, p2.z],
            speed,
            phase: (br.id * 0.23) % 1.0,
            color: c
          });
        }
      }
    });

    return {
      linePositions: new Float32Array(pos),
      lineColors: new Float32Array(cols),
      particleData: pData,
      outagedMarkers: markers,
      overloadedMarkers: overMarkers,
    };
  }, [
    branches,
    activeLayoutMap,
    outagedLines,
    branchLoading,
    isolatedBranches,
    hoveredBranchId,
    reducedMotion,
    showCriticality,
    branchCriticalityMap,
    glowInfluentialBranchIds,
    isBridgeMode,
    bridgeBranchIds,
    newlyTrippedBranchIds,
    previouslyTrippedBranchIds,
    overloadedBranchIds,
  ]);

  const particlePositions = useMemo(() => {
    return new Float32Array(particleData.length * 3);
  }, [particleData]);

  const particleColors = useMemo(() => {
    const colors = new Float32Array(particleData.length * 3);
    particleData.forEach((p, idx) => {
      colors[idx * 3] = p.color.r;
      colors[idx * 3 + 1] = p.color.g;
      colors[idx * 3 + 2] = p.color.b;
    });
    return colors;
  }, [particleData]);

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    if (particlesRef.current && !reducedMotion) {
      const posAttr = particlesRef.current.geometry.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < particleData.length; i++) {
        const p = particleData[i];
        const progress = (p.phase + t * p.speed) % 1.0;
        const x = p.from[0] + (p.to[0] - p.from[0]) * progress;
        const y = p.from[1] + (p.to[1] - p.from[1]) * progress;
        const z = p.from[2] + (p.to[2] - p.from[2]) * progress;
        posAttr.setXYZ(i, x, y, z);
      }
      posAttr.needsUpdate = true;
    }
  });

  return (
    <group>
      {/* Visual Line Segments */}
      <lineSegments ref={linesRef}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[linePositions, 3]} />
          <bufferAttribute attach="attributes-color" args={[lineColors, 3]} />
        </bufferGeometry>
        <lineBasicMaterial vertexColors linewidth={2.5} transparent opacity={0.9} />
      </lineSegments>

      {/* Flow Particles */}
      {!reducedMotion && particleData.length > 0 && (
        <points ref={particlesRef}>
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" args={[particlePositions, 3]} />
            <bufferAttribute attach="attributes-color" args={[particleColors, 3]} />
          </bufferGeometry>
          <pointsMaterial size={0.07} vertexColors sizeAttenuation transparent opacity={0.88} />
        </points>
      )}

      {/* Invisible wider hit areas for raycasting */}
      {branches.map((br) => {
        const p1 = activeLayoutMap[br.from_bus];
        const p2 = activeLayoutMap[br.to_bus];
        if (!p1 || !p2) return null;

        const v1 = new THREE.Vector3(p1.x, p1.y, p1.z);
        const v2 = new THREE.Vector3(p2.x, p2.y, p2.z);
        const mid = v1.clone().add(v2).multiplyScalar(0.5);
        const length = Math.max(0.01, v1.distanceTo(v2));

        const quat = new THREE.Quaternion();
        const dir = v2.clone().sub(v1).normalize();
        quat.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);

        return (
          <mesh
            key={`hit-${br.id}`}
            position={[mid.x, mid.y, mid.z]}
            quaternion={quat}
            onPointerOver={(e) => {
              e.stopPropagation();
              onHoverBranch(br, e);
            }}
            onPointerOut={(e) => {
              e.stopPropagation();
              onHoverBranch(null);
            }}
            onClick={(e) => {
              e.stopPropagation();
              onClickBranch(br, e.shiftKey);
            }}
          >
            <cylinderGeometry args={[0.22, 0.22, length, 8]} />
            <meshBasicMaterial transparent opacity={0.001} depthWrite={false} />
          </mesh>
        );
      })}

      {/* Outage & Cascade Tripping Markers - Compact Pill, midpoint of line, no distance scaling */}
      {outagedMarkers.map((m) => (
        <group key={`outage-label-${m.id}`} position={m.mid}>
          <Html center zIndexRange={[120, 0]}>
            {m.isNewlyTripped ? (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '2px 7px',
                  backgroundColor: '#ef4444',
                  color: '#ffffff',
                  fontSize: 11,
                  lineHeight: '14px',
                  fontWeight: 700,
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                  borderRadius: 9999,
                  boxShadow: '0 2px 6px rgba(0, 0, 0, 0.25)',
                  whiteSpace: 'nowrap',
                  pointerEvents: 'none',
                  border: '1px solid rgba(255, 255, 255, 0.75)',
                }}
              >
                <AlertTriangle style={{ width: 12, height: 12 }} />
                <span>TRIPPED: {m.name}</span>
              </div>
            ) : m.isPreviouslyTripped ? (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 3,
                  padding: '1px 6px',
                  backgroundColor: '#475569',
                  color: '#ffffff',
                  fontSize: 10,
                  lineHeight: '13px',
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                  borderRadius: 9999,
                  boxShadow: '0 1px 4px rgba(0, 0, 0, 0.2)',
                  whiteSpace: 'nowrap',
                  pointerEvents: 'none',
                  border: '1px solid rgba(255, 255, 255, 0.4)',
                }}
              >
                <span style={{ fontWeight: 700, color: '#fca5a5' }}>✕</span>
                <span>{m.name}</span>
              </div>
            ) : (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '2px 7px',
                  backgroundColor: '#c8443b',
                  color: '#ffffff',
                  fontSize: 11.5,
                  lineHeight: '14px',
                  fontWeight: 700,
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                  borderRadius: 9999,
                  boxShadow: '0 2px 6px rgba(0, 0, 0, 0.25)',
                  whiteSpace: 'nowrap',
                  pointerEvents: 'none',
                  border: '1px solid rgba(255, 255, 255, 0.7)',
                }}
              >
                <Scissors style={{ width: 12, height: 12 }} />
                <span>{m.name} OUT</span>
              </div>
            )}
          </Html>
        </group>
      ))}

      {/* Overloaded Lines Pulsing Indicator */}
      {overloadedMarkers.map((m) => (
        <group key={`overload-label-${m.id}`} position={m.mid}>
          <Html center zIndexRange={[110, 0]}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 3,
                padding: '1px 6px',
                backgroundColor: 'rgba(217, 119, 6, 0.95)',
                color: '#ffffff',
                fontSize: 10,
                lineHeight: '13px',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                borderRadius: 9999,
                boxShadow: '0 1px 4px rgba(0, 0, 0, 0.2)',
                whiteSpace: 'nowrap',
                pointerEvents: 'none',
                border: '1px solid #fde68a',
              }}
            >
              <span>⚡ AT RISK: {m.name}</span>
            </div>
          </Html>
        </group>
      ))}
    </group>
  );
};

// -----------------------------------------------------------------------------
// Voltage Level Color Helper & Compact Fixed-Screen Bus Label
// -----------------------------------------------------------------------------
function voltColour(kv: number): string {
  if (kv >= 345) return '#7c3aed';
  if (kv >= 230) return '#2563eb';
  if (kv >= 115) return '#f59e0b';
  if (kv >= 69)  return '#16a34a';
  return '#9aa3ad';
}

const StageBusLabel: React.FC<{
  bus: Bus;
  pos: { x: number; y: number; z: number };
  visible: boolean;
  isDetailed: boolean;
  isHighPriority?: boolean;
}> = ({ bus, pos, visible, isDetailed, isHighPriority }) => {
  const ieeeId = bus.id + 1;
  const labelText = isDetailed
    ? `BUS ${ieeeId} · ${bus.vn_kv || 132} kV${bus.gen_p_mw ? ` · ${Math.round(bus.gen_p_mw)} MW gen` : bus.base_p_mw ? ` · ${Math.round(bus.base_p_mw)} MW` : ''}`
    : `BUS ${ieeeId}`;

  return (
    <Html position={[pos.x, pos.y + 0.16, pos.z]} center zIndexRange={[250, 0]}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: isDetailed ? '2px 7px 2px 5px' : '1px 5px 1px 4px',
          background: isDetailed ? 'rgba(255, 255, 255, 0.98)' : 'rgba(255, 255, 255, 0.92)',
          backdropFilter: 'blur(4px)',
          border: isHighPriority ? '1px solid #c8443b' : '1px solid #cfd3d8',
          borderRadius: 3,
          boxShadow: '0 1px 3px rgba(0, 0, 0, 0.12)',
          whiteSpace: 'nowrap',
          fontSize: 10.5,
          lineHeight: '13px',
          fontWeight: 600,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
          color: isHighPriority ? '#c8443b' : '#1a2332',
          pointerEvents: 'none',
          userSelect: 'none',
          transition: 'opacity 0.18s ease, transform 0.18s ease',
          opacity: visible ? 1 : 0,
          transform: visible ? 'scale(1)' : 'scale(0.95)',
        }}
      >
        <span
          style={{
            width: 5,
            height: 5,
            borderRadius: '50%',
            background: isHighPriority ? '#c8443b' : voltColour(bus.vn_kv || 132),
            flexShrink: 0,
          }}
        />
        <span>{labelText}</span>
      </div>
    </Html>
  );
};

// -----------------------------------------------------------------------------
// Bus Nodes, Sprites, Labels & Topology Overlay Styling
// -----------------------------------------------------------------------------
interface BusNetworkProps {
  buses: Bus[];
  activeLayoutMap: Record<number, { x: number; y: number; z: number }>;
  outagedLines: number[];
  outagedGens: number[];
  branches: Branch[];
  isolatedBuses: Set<number>;
  showBusNumbers: boolean;
  onHoverBus: (bus: Bus | null, e?: any) => void;
  onClickBus: (bus: Bus, isShift: boolean) => void;
  reducedMotion: boolean;
  topologyOverlay: 'none' | 'degree' | 'betweenness' | 'community' | 'bridges';
  topologyData: any | null;
  labelMode: 'smart' | 'all' | 'off';
  hoveredBusId: number | null;
  hoveredBranchId: number | null;
  branchLoading: Record<string, number>;
  gridRadius: number;
}

const BusNetwork: React.FC<BusNetworkProps> = ({
  buses,
  activeLayoutMap,
  outagedLines,
  outagedGens,
  branches,
  isolatedBuses,
  showBusNumbers,
  onHoverBus,
  onClickBus,
  reducedMotion,
  topologyOverlay,
  topologyData,
  labelMode,
  hoveredBusId,
  hoveredBranchId,
  branchLoading,
  gridRadius,
}) => {
  const { camera, size } = useThree();
  const [camDist, setCamDist] = useState(10);
  useFrame(() => setCamDist(camera.position.length()));

  const [genTex, subTex, loadTex] = useLoader(THREE.TextureLoader, [
    `${import.meta.env.BASE_URL}assets/icons/generator.png`,
    `${import.meta.env.BASE_URL}assets/icons/substation.png`,
    `${import.meta.env.BASE_URL}assets/icons/load.png`
  ]);

  // Scaled icon size: ~60% of original, scaled by grid size so 118 buses is clean & readable
  const gridScale = Math.max(0.48, Math.min(1.0, 32 / Math.max(14, buses.length)));

  // Identify endpoint buses touching outaged lines
  const hotEndpointBuses = useMemo(() => {
    const set = new Set<number>();
    outagedLines.forEach((lid) => {
      const br = branches.find((b) => b.id === lid);
      if (br) {
        set.add(br.from_bus);
        set.add(br.to_bus);
      }
    });
    outagedGens.forEach((gid) => set.add(gid));
    return set;
  }, [outagedLines, outagedGens, branches]);

  const hoveredBusIds = useMemo(() => {
    const set = new Set<number>();
    if (hoveredBusId !== null) set.add(hoveredBusId);
    if (hoveredBranchId !== null) {
      const br = branches.find((b) => b.id === hoveredBranchId);
      if (br) {
        set.add(br.from_bus);
        set.add(br.to_bus);
      }
    }
    return set;
  }, [hoveredBusId, hoveredBranchId, branches]);

  const highRiskBusIds = useMemo(() => {
    const set = new Set<number>();
    isolatedBuses.forEach((id) => set.add(id));
    branches.forEach((br) => {
      const load = branchLoading[String(br.id)] ?? 0;
      if (load >= 100) {
        set.add(br.from_bus);
        set.add(br.to_bus);
      }
    });
    return set;
  }, [isolatedBuses, branches, branchLoading]);

  const importantBusIds = useMemo(() => {
    const scores = buses.map((b) => {
      const gen = b.gen_p_mw || 0;
      const load = b.base_p_mw || 0;
      return { id: b.id, score: gen * 1.5 + load };
    });
    scores.sort((a, b) => b.score - a.score);
    return new Set(scores.slice(0, 8).map((s) => s.id));
  }, [buses]);

  // Throttled screen-space collision avoidance & visibility calculation (100ms)
  const [visibleBusIds, setVisibleBusIds] = useState<Set<number>>(new Set());
  const lastUpdateRef = useRef(0);

  useFrame(() => {
    const now = performance.now();
    if (now - lastUpdateRef.current < 100) return;
    lastUpdateRef.current = now;

    const width = size.width || window.innerWidth;
    const height = size.height || window.innerHeight;

    const candidates: Array<{
      id: number;
      priority: number;
      distToCenter: number;
      screenX: number;
      screenY: number;
    }> = [];

    const tempVec = new THREE.Vector3();

    for (const bus of buses) {
      const pos = activeLayoutMap[bus.id];
      if (!pos) continue;

      const isHovered = hoveredBusIds.has(bus.id);
      const isOutaged = hotEndpointBuses.has(bus.id);
      const isHighRisk = highRiskBusIds.has(bus.id);
      const isImportant = importantBusIds.has(bus.id);

      let priority = -1;
      if (isOutaged) priority = 4;
      else if (isHovered) priority = 3;
      else if (isHighRisk) priority = 2;
      else if (isImportant) priority = 1;
      else if (labelMode === 'all') priority = 0;
      else if (labelMode === 'smart' && camDist < gridRadius * 2.5) priority = 0;

      if (labelMode === 'off' && priority < 3) continue;
      if (priority < 0) continue;

      tempVec.set(pos.x, pos.y + 0.16, pos.z);
      tempVec.project(camera);

      // Frustum clipping
      if (tempVec.z > 1.0 || tempVec.x < -1.1 || tempVec.x > 1.1 || tempVec.y < -1.1 || tempVec.y > 1.1) {
        continue;
      }

      const distToCenter = Math.sqrt(tempVec.x * tempVec.x + tempVec.y * tempVec.y);

      // Progressive zoom reveal in smart mode
      if (labelMode === 'smart' && priority === 0 && distToCenter > 0.72) {
        continue;
      }

      const screenX = ((tempVec.x + 1) / 2) * width;
      const screenY = ((-tempVec.y + 1) / 2) * height;

      candidates.push({
        id: bus.id,
        priority,
        distToCenter,
        screenX,
        screenY,
      });
    }

    // Sort by priority descending, then distance to center ascending
    candidates.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.distToCenter - b.distToCenter;
    });

    const acceptedIds = new Set<number>();
    const boxes: Array<{ left: number; right: number; top: number; bottom: number }> = [];
    const maxLabels = labelMode === 'smart' ? 15 : 60;

    for (const c of candidates) {
      if (acceptedIds.size >= maxLabels && c.priority < 3) break;

      const halfW = 34; // ~68px pill
      const halfH = 12; // ~24px pill
      const box = {
        left: c.screenX - halfW,
        right: c.screenX + halfW,
        top: c.screenY - halfH,
        bottom: c.screenY + halfH,
      };

      let collides = false;
      if (c.priority < 3) {
        for (const b of boxes) {
          if (
            box.left < b.right &&
            box.right > b.left &&
            box.top < b.bottom &&
            box.bottom > b.top
          ) {
            collides = true;
            break;
          }
        }
      }

      if (!collides) {
        acceptedIds.add(c.id);
        boxes.push(box);
      }
    }

    setVisibleBusIds((prev) => {
      if (prev.size === acceptedIds.size) {
        let same = true;
        for (const id of acceptedIds) {
          if (!prev.has(id)) { same = false; break; }
        }
        if (same) return prev;
      }
      return acceptedIds;
    });
  });

  return (
    <group>
      {buses.map((bus) => {
        const layout = activeLayoutMap[bus.id];
        if (!layout) return null;

        let texture = subTex;
        if (bus.type === 'generator') texture = genTex;
        else if (bus.type === 'load') texture = loadTex;

        const isHot = hotEndpointBuses.has(bus.id);
        const isIsolated = isolatedBuses.has(bus.id);
        const isGenOut = outagedGens.includes(bus.id);

        let color = '#ffffff';
        let baseScale = isHot ? 0.20 : bus.type === 'generator' ? 0.17 : 0.14;
        let scale = baseScale * gridScale;

        // Apply Topology Overlays if in Map Mode
        if (topologyOverlay === 'degree' && topologyData?.per_bus_degree) {
          const deg = topologyData.per_bus_degree[bus.id] ?? 2;
          const maxDeg = Math.max(...Object.values(topologyData.per_bus_degree as Record<string, number>), 4);
          const norm = Math.min(1, deg / maxDeg);
          scale = (0.13 + norm * 0.13) * gridScale;
          color = norm > 0.6 ? '#dc2626' : norm > 0.3 ? '#f59e0b' : '#38bdf8';
        } else if (topologyOverlay === 'betweenness' && topologyData?.per_bus_betweenness) {
          const bVal = topologyData.per_bus_betweenness[bus.id] ?? 0;
          const maxB = Math.max(...Object.values(topologyData.per_bus_betweenness as Record<string, number>), 0.05);
          const norm = Math.min(1, bVal / maxB);
          scale = (0.13 + norm * 0.14) * gridScale;
          color = norm > 0.5 ? '#ec4899' : norm > 0.2 ? '#c084fc' : '#818cf8';
        } else if (topologyOverlay === 'community' && topologyData?.per_bus_community) {
          const commId = topologyData.per_bus_community[bus.id] ?? 0;
          color = COMMUNITY_COLORS[commId % COMMUNITY_COLORS.length];
        } else {
          if (isHot || isGenOut) color = '#c8443b';
          else if (isIsolated) color = '#6b7280';
        }

        const opacity = isIsolated ? 0.22 : 0.95;
        const isVisible = visibleBusIds.has(bus.id) || (showBusNumbers && labelMode !== 'off');
        const isDetailed = hoveredBusIds.has(bus.id) || isHot;

        return (
          <group key={`bus-node-${bus.id}`} position={[layout.x, layout.y, layout.z]}>
            {/* Bus Sprite Icon - scaled to ~60% size, stable across zoom */}
            <sprite scale={[scale, scale, scale]}>
              <spriteMaterial
                map={texture}
                color={color}
                transparent
                opacity={opacity}
                depthWrite={false}
              />
            </sprite>

            {/* Pulsing red halo for outage endpoints */}
            {isHot && !reducedMotion && (
              <mesh scale={[scale * 1.5, scale * 1.5, scale * 1.5]}>
                <ringGeometry args={[0.3, 0.45, 24]} />
                <meshBasicMaterial color="#c8443b" transparent opacity={0.65} side={THREE.DoubleSide} />
              </mesh>
            )}

            {/* Hit sphere for raycasting */}
            <mesh
              onPointerOver={(e) => {
                e.stopPropagation();
                onHoverBus(bus, e);
              }}
              onPointerOut={(e) => {
                e.stopPropagation();
                onHoverBus(null);
              }}
              onClick={(e) => {
                e.stopPropagation();
                onClickBus(bus, e.shiftKey);
              }}
            >
              <sphereGeometry args={[Math.max(0.18, 0.26 * gridScale), 8, 8]} />
              <meshBasicMaterial transparent opacity={0.001} depthWrite={false} />
            </mesh>

            {/* Smart Bus Label */}
            <StageBusLabel
              bus={bus}
              pos={layout}
              visible={isVisible}
              isDetailed={isDetailed}
              isHighPriority={isHot || isGenOut}
            />
          </group>
        );
      })}
    </group>
  );
};

// -----------------------------------------------------------------------------
// Voltage Bands Underlay (Map Mode when Group by Voltage is enabled)
// -----------------------------------------------------------------------------
const VoltageBands: React.FC<{
  activeLayoutMap: Record<number, { x: number; y: number; z: number }>;
  buses: Bus[];
  visible: boolean;
}> = ({ activeLayoutMap, buses, visible }) => {
  const bands = useMemo(() => {
    if (!visible || buses.length === 0) return [];
    const voltGroups = new Map<number, Bus[]>();
    buses.forEach((b) => {
      const kv = b.vn_kv || 132;
      const arr = voltGroups.get(kv) || [];
      arr.push(b);
      voltGroups.set(kv, arr);
    });

    const result: Array<{
      kv: number;
      minX: number;
      maxX: number;
      minZ: number;
      maxZ: number;
      color: string;
    }> = [];

    voltGroups.forEach((groupBuses, kv) => {
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      let valid = 0;
      groupBuses.forEach((b) => {
        const p = activeLayoutMap[b.id];
        if (p) {
          minX = Math.min(minX, p.x);
          maxX = Math.max(maxX, p.x);
          minZ = Math.min(minZ, p.z);
          maxZ = Math.max(maxZ, p.z);
          valid++;
        }
      });
      if (valid > 0) {
        const padX = 0.45;
        const padZ = 0.45;
        result.push({
          kv,
          minX: minX - padX,
          maxX: maxX + padX,
          minZ: minZ - padZ,
          maxZ: maxZ + padZ,
          color: voltColour(kv),
        });
      }
    });

    return result;
  }, [activeLayoutMap, buses, visible]);

  if (!visible || bands.length === 0) return null;

  return (
    <group position={[0, -0.05, 0]}>
      {bands.map((band) => {
        const width = Math.max(0.8, band.maxX - band.minX);
        const depth = Math.max(0.8, band.maxZ - band.minZ);
        const cx = (band.minX + band.maxX) / 2;
        const cz = (band.minZ + band.maxZ) / 2;
        return (
          <group key={`volt-band-${band.kv}`}>
            <mesh position={[cx, 0, cz]} rotation={[-Math.PI / 2, 0, 0]}>
              <planeGeometry args={[width, depth]} />
              <meshBasicMaterial
                color={band.color}
                transparent
                opacity={0.08}
                depthWrite={false}
              />
            </mesh>
            <lineSegments position={[cx, 0.001, cz]} rotation={[-Math.PI / 2, 0, 0]}>
              <edgesGeometry args={[new THREE.PlaneGeometry(width, depth)]} />
              <lineBasicMaterial color={band.color} transparent opacity={0.25} />
            </lineSegments>
            <Html position={[band.minX + 0.1, 0.01, band.minZ + 0.1]} center={false} zIndexRange={[30, 0]}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 3,
                  padding: '1px 4px',
                  backgroundColor: 'rgba(255, 255, 255, 0.85)',
                  backdropFilter: 'blur(2px)',
                  border: `1px solid ${band.color}`,
                  borderRadius: 2,
                  fontSize: 9.5,
                  fontWeight: 600,
                  fontFamily: 'ui-monospace, monospace',
                  color: band.color,
                  pointerEvents: 'none',
                  whiteSpace: 'nowrap',
                }}
              >
                <span>{band.kv} kV</span>
              </div>
            </Html>
          </group>
        );
      })}
    </group>
  );
};

// -----------------------------------------------------------------------------
// Animated Scene Group that interpolates coordinates between 3D & Map Mode
// -----------------------------------------------------------------------------
const AnimatedSceneGroup: React.FC<{
  viewMode: '3d' | 'map';
  layoutMap: Record<number, BusLayout>;
  mapLayoutMap: Record<number, { x: number; y: number; z: number }>;
  buses: Bus[];
  branches: Branch[];
  outagedLines: number[];
  outagedGens: number[];
  activeBranchLoadings: Record<string, number>;
  activeIsolatedBuses: Set<number>;
  hoveredBranch: Branch | null;
  onHoverBranch: (br: Branch | null, e?: any) => void;
  onClickBranch: (br: Branch, isShift: boolean) => void;
  onHoverBus: (bus: Bus | null, e?: any) => void;
  onClickBus: (bus: Bus, isShift: boolean) => void;
  reducedMotion: boolean;
  glowInfluential: boolean;
  influentialBranchIds: Set<number>;
  showCriticality: boolean;
  branchCriticalityMap: Record<number, number>;
  showMaintenanceOverlay?: boolean;
  maintenancePriorityMap?: Record<number, { priority: number; color: string; urgency: string }> | null;
  topologyOverlay: 'none' | 'degree' | 'betweenness' | 'community' | 'bridges';
  topologyData: any | null;
  bridgeBranchIds: Set<number>;
  shockwaveOrigin: [number, number, number] | null;
  shockwaveTime: number;
  sparks: Array<{ pos: [number, number, number]; time: number }>;
  showBusNumbers: boolean;
  labelMode: 'smart' | 'all' | 'off';
  groupByVoltage: boolean;
  uniqueVoltages: number[];
  gridRadius: number;
  hoveredBusId: number | null;
  newlyTrippedBranchIds?: Set<number>;
  previouslyTrippedBranchIds?: Set<number>;
  overloadedBranchIds?: Set<number>;
}> = (props) => {
  const groupRef = useRef<THREE.Group>(null);
  const animProgressRef = useRef<number>(props.viewMode === 'map' ? 1 : 0);
  const [currentMap, setCurrentMap] = useState<Record<number, { x: number; y: number; z: number }>>(
    props.layoutMap
  );

  useFrame((_, delta) => {
    const target = props.viewMode === 'map' ? 1.0 : 0.0;
    const prev = animProgressRef.current;
    animProgressRef.current = THREE.MathUtils.lerp(prev, target, Math.min(1, delta * 4.5));

    const p = animProgressRef.current;

    // Smooth group rotation: 0.4 rad in 3D, perfectly 0 rad in top-down Map view
    if (groupRef.current) {
      groupRef.current.rotation.y = (1.0 - p) * 0.4;
    }

    // Only update position map when transition is active
    if (Math.abs(p - prev) > 0.0005 || p !== target) {
      const nextMap: Record<number, { x: number; y: number; z: number }> = {};
      props.buses.forEach((b) => {
        const p3d = props.layoutMap[b.id];
        const pMap = props.mapLayoutMap[b.id];
        if (p3d && pMap) {
          nextMap[b.id] = {
            x: THREE.MathUtils.lerp(p3d.x, pMap.x, p),
            y: THREE.MathUtils.lerp(p3d.y, pMap.y, p),
            z: THREE.MathUtils.lerp(p3d.z, pMap.z, p)
          };
        } else if (p3d) {
          nextMap[b.id] = p3d;
        }
      });
      setCurrentMap(nextMap);
    }
  });

  return (
    <group ref={groupRef} rotation={[0, props.viewMode === 'map' ? 0 : 0.4, 0]}>
      <VoltageBands
        activeLayoutMap={currentMap}
        buses={props.buses}
        visible={props.viewMode === 'map' && props.groupByVoltage && props.uniqueVoltages.length >= 2}
      />

      <BranchNetwork
        branches={props.branches}
        activeLayoutMap={currentMap}
        outagedLines={props.outagedLines}
        branchLoading={props.activeBranchLoadings}
        isolatedBranches={new Set()}
        hoveredBranchId={props.hoveredBranch?.id ?? null}
        onHoverBranch={props.onHoverBranch}
        onClickBranch={props.onClickBranch}
        reducedMotion={props.reducedMotion}
        glowInfluentialBranchIds={props.glowInfluential ? props.influentialBranchIds : undefined}
        showCriticality={props.showCriticality}
        branchCriticalityMap={props.branchCriticalityMap}
        showMaintenanceOverlay={props.showMaintenanceOverlay}
        maintenancePriorityMap={props.maintenancePriorityMap}
        isBridgeMode={props.topologyOverlay === 'bridges'}
        bridgeBranchIds={props.bridgeBranchIds}
        newlyTrippedBranchIds={props.newlyTrippedBranchIds}
        previouslyTrippedBranchIds={props.previouslyTrippedBranchIds}
        overloadedBranchIds={props.overloadedBranchIds}
      />

      <BusNetwork
        buses={props.buses}
        activeLayoutMap={currentMap}
        outagedLines={props.outagedLines}
        outagedGens={props.outagedGens}
        branches={props.branches}
        isolatedBuses={props.activeIsolatedBuses}
        showBusNumbers={props.showBusNumbers}
        onHoverBus={props.onHoverBus}
        onClickBus={props.onClickBus}
        reducedMotion={props.reducedMotion}
        topologyOverlay={props.topologyOverlay}
        topologyData={props.topologyData}
        labelMode={props.labelMode}
        hoveredBusId={props.hoveredBusId}
        hoveredBranchId={props.hoveredBranch?.id ?? null}
        branchLoading={props.activeBranchLoadings}
        gridRadius={props.gridRadius}
      />

      <ShockwaveRing
        origin={props.shockwaveOrigin}
        triggerTime={props.shockwaveTime}
        reducedMotion={props.reducedMotion}
      />

      <TrippingSparks sparks={props.sparks} reducedMotion={props.reducedMotion} />
    </group>
  );
};

// =============================================================================
// Main Interactive Stage Scene Component
// =============================================================================
export interface StageSceneProps {
  isFullscreen?: boolean;
}

export const StageScene: React.FC<StageSceneProps> = ({ isFullscreen = false }) => {
  const {
    buses,
    branches,
    layoutMap,
    layout2dMap,
    outagedElements,
    toggleOutagedElement,
    prediction,
    cameraResetTrigger,
    showBusNumbers,
    showCriticality,
    branchCriticalityMap,
    glowInfluential,
    replayData,
    replayStepIndex,
    isPlayingReplay,
    stopCascadeReplay,
    loadingGrid,
    gridError,
    failingUrl,
    fetchGridAndLayout,
    fetchGridList,
    viewMode,
    setViewMode,
    topologyOverlay,
    setTopologyOverlay,
    topologyData,
    fetchTopology,
    gridCase,
    groupByVoltage,
    setGroupByVoltage,
    labelMode,
    setLabelMode,
    showMaintenanceOverlay,
    maintenanceData,
  } = useGridStore();

  const [hoveredBranch, setHoveredBranch] = useState<Branch | null>(null);
  const [hoveredBus, setHoveredBus] = useState<Bus | null>(null);
  const [tooltip, setTooltip] = useState<TooltipInfo | null>(null);

  // Compute maintenance priority map for overlay
  const maintenancePriorityMap = useMemo(() => {
    if (!showMaintenanceOverlay || !maintenanceData?.priorities) return null;
    const map: Record<number, { priority: number; color: string; urgency: string }> = {};
    maintenanceData.priorities.forEach((p) => {
      if (p.asset_id.startsWith('line_') || p.asset_id.startsWith('branch_')) {
        const idNum = parseInt(p.asset_id.split('_')[1], 10);
        if (!isNaN(idNum)) {
          map[idNum] = { priority: p.priority_score, color: p.color, urgency: p.urgency };
        }
      }
    });
    return map;
  }, [showMaintenanceOverlay, maintenanceData]);

  // Fetch topology on mount or grid change
  useEffect(() => {
    fetchTopology();
  }, [fetchTopology, gridCase]);

  // Unique voltage levels
  const uniqueVoltages = useMemo(
    () => Array.from(new Set(buses.map((b) => b.vn_kv || 132))),
    [buses]
  );

  // Compute 2D Map layout: Kamada-Kawai layout from backend layout2dMap, never derived from voltage level
  const mapLayoutMap = useMemo(() => {
    const mapPos: Record<number, { x: number; y: number; z: number }> = {};
    if (buses.length === 0) return mapPos;

    if (layout2dMap && Object.keys(layout2dMap).length > 0) {
      buses.forEach((b) => {
        const p2d = layout2dMap[b.id];
        if (p2d) {
          mapPos[b.id] = { x: p2d.x, y: 0, z: p2d.z };
        } else if (layoutMap[b.id]) {
          mapPos[b.id] = { x: layoutMap[b.id].x, y: 0, z: layoutMap[b.id].z };
        }
      });
      return mapPos;
    }

    // Fallback: top-down projection of 3D layout (y=0)
    buses.forEach((b) => {
      const p3d = layoutMap[b.id];
      if (p3d) {
        mapPos[b.id] = { x: p3d.x, y: 0, z: p3d.z };
      }
    });
    return mapPos;
  }, [buses, layout2dMap, layoutMap]);

  // Bounding radius of the active layout – drives camera distance limits and framing
  const gridRadius = useMemo(() => {
    const activeMap = viewMode === 'map' ? mapLayoutMap : layoutMap;
    const vals = Object.values(activeMap);
    if (vals.length === 0) return 3.5;
    let maxR = 0;
    vals.forEach((p: any) => {
      const d = Math.sqrt(p.x * p.x + (p.y || 0) * (p.y || 0) + p.z * p.z);
      if (d > maxR) maxR = d;
    });
    return Math.max(3.5, maxR * 1.05);
  }, [viewMode, mapLayoutMap, layoutMap]);

  const bridgeBranchIds = useMemo(() => {
    return new Set(
      (topologyData?.bridge_branches || []).map(
        (br: any) => br.branch_id ?? br.id
      )
    );
  }, [topologyData]);

  const influentialBranchIds = useMemo(() => {
    return new Set((prediction?.top_influential_branches || []).map((b) => b.branch_id));
  }, [prediction]);

  // Derive newly tripped, previously tripped, overloaded branches and gentle framing centroid
  const {
    newlyTrippedBranchIds,
    previouslyTrippedBranchIds,
    overloadedBranchIds,
    framingCentroid,
  } = useMemo(() => {
    if (!replayData || replayStepIndex < 0 || !replayData.steps[replayStepIndex]) {
      return {
        newlyTrippedBranchIds: new Set<number>(),
        previouslyTrippedBranchIds: new Set<number>(),
        overloadedBranchIds: new Set<number>(),
        framingCentroid: null as [number, number, number] | null,
      };
    }
    const currentStep = replayData.steps[replayStepIndex];
    const newly = new Set<number>(currentStep.newly_tripped_branches || []);

    const prev = new Set<number>();
    for (let i = 0; i < replayStepIndex; i++) {
      (replayData.steps[i]?.newly_tripped_branches || []).forEach((id) => prev.add(id));
    }

    const overloaded = new Set<number>();
    const loadings = currentStep.branch_loadings || {};
    Object.entries(loadings).forEach(([bid, load]) => {
      const id = Number(bid);
      if (load >= 100 && !newly.has(id) && !prev.has(id)) {
        overloaded.add(id);
      }
    });

    let cx = 0, cy = 0, cz = 0, count = 0;
    newly.forEach((lid) => {
      const br = branches.find((b) => b.id === lid);
      if (br && layoutMap[br.from_bus] && layoutMap[br.to_bus]) {
        const p1 = layoutMap[br.from_bus];
        const p2 = layoutMap[br.to_bus];
        cx += (p1.x + p2.x) * 0.5;
        cy += (p1.y + p2.y) * 0.5;
        cz += (p1.z + p2.z) * 0.5;
        count++;
      }
    });

    const centroid: [number, number, number] | null = count > 0 ? [cx / count, cy / count, cz / count] : null;

    return {
      newlyTrippedBranchIds: newly,
      previouslyTrippedBranchIds: prev,
      overloadedBranchIds: overloaded,
      framingCentroid: centroid,
    };
  }, [replayData, replayStepIndex, branches, layoutMap]);

  // Shockwave state
  const [shockwaveOrigin, setShockwaveOrigin] = useState<[number, number, number] | null>(null);
  const [shockwaveTime, setShockwaveTime] = useState<number>(0);

  // Sparks state for cascade replay
  const [sparks, setSparks] = useState<Array<{ pos: [number, number, number]; time: number }>>([]);
  const [shakeIntensity, setShakeIntensity] = useState<number>(0);

  // Reduced motion query
  const [reducedMotion, setReducedMotion] = useState<boolean>(false);
  useEffect(() => {
    const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReducedMotion(mql.matches);
    const handler = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);

  // Keyboard shortcut: Esc to clear outages
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        useGridStore.getState().clearOutages();
        if (isPlayingReplay) stopCascadeReplay();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isPlayingReplay, stopCascadeReplay]);

  // Parse outaged IDs
  const { outagedLines, outagedGens } = useMemo(() => {
    const lines: number[] = [];
    const gens: number[] = [];
    outagedElements.forEach((el) => {
      const s = String(el).toLowerCase().trim();
      if (s.startsWith('gen_')) gens.push(parseInt(s.split('_')[1], 10));
      else if (s.startsWith('line_')) lines.push(parseInt(s.split('_')[1], 10));
      else {
        const n = parseInt(s, 10);
        if (!isNaN(n)) lines.push(n);
      }
    });
    return { outagedLines: lines, outagedGens: gens };
  }, [outagedElements]);

  // Active branch loadings
  const activeBranchLoadings = useMemo(() => {
    if (replayData && replayStepIndex >= 0 && replayData.steps[replayStepIndex]) {
      return replayData.steps[replayStepIndex].branch_loadings || {};
    }
    return prediction?.per_branch_loading || {};
  }, [prediction, replayData, replayStepIndex]);

  // Active isolated buses
  const activeIsolatedBuses = useMemo(() => {
    if (replayData && replayStepIndex >= 0 && replayData.steps[replayStepIndex]) {
      return new Set(replayData.steps[replayStepIndex].islanded_buses || []);
    }
    if (prediction?.before_after?.islanded_buses) {
      return new Set(prediction.before_after.islanded_buses);
    }
    return new Set<number>();
  }, [prediction, replayData, replayStepIndex]);

  // Trigger shockwave when outage changes
  const prevOutageRef = useRef<string[]>(outagedElements);
  useEffect(() => {
    if (outagedElements !== prevOutageRef.current) {
      prevOutageRef.current = outagedElements;
      if (outagedElements.length > 0) {
        const lastEl = outagedElements[outagedElements.length - 1];
        if (lastEl.startsWith('line_')) {
          const lid = parseInt(lastEl.split('_')[1], 10);
          const br = branches.find((b) => b.id === lid);
          if (br && layoutMap[br.from_bus] && layoutMap[br.to_bus]) {
            const p1 = layoutMap[br.from_bus];
            const p2 = layoutMap[br.to_bus];
            setShockwaveOrigin([(p1.x + p2.x) * 0.5, (p1.y + p2.y) * 0.5, (p1.z + p2.z) * 0.5]);
            setShockwaveTime(Date.now());
          }
        }
      }
    }
  }, [outagedElements, branches, layoutMap]);

  // Handle Cascade Replay step transitions (sparks & camera shake)
  useEffect(() => {
    if (replayData && replayStepIndex >= 0 && replayData.steps[replayStepIndex]) {
      const step = replayData.steps[replayStepIndex];
      const newlyTripped = step.newly_tripped_branches || [];
      if (newlyTripped.length > 0) {
        const newSparks: Array<{ pos: [number, number, number]; time: number }> = [];
        newlyTripped.forEach((lid) => {
          const br = branches.find((b) => b.id === lid);
          if (br && layoutMap[br.from_bus] && layoutMap[br.to_bus]) {
            const p1 = layoutMap[br.from_bus];
            const p2 = layoutMap[br.to_bus];
            newSparks.push({
              pos: [(p1.x + p2.x) * 0.5, (p1.y + p2.y) * 0.5, (p1.z + p2.z) * 0.5],
              time: Date.now()
            });
          }
        });
        setSparks((prev) => [...prev.slice(-10), ...newSparks]);
        setShakeIntensity(1.0);
        setTimeout(() => setShakeIntensity(0), 400);
      }
    }
  }, [replayData, replayStepIndex, branches, layoutMap]);

  // Branch interaction handlers
  const handleHoverBranch = useCallback(
    (br: Branch | null, e?: any) => {
      setHoveredBranch(br);
      if (!br) {
        setTooltip(null);
        document.body.style.cursor = 'default';
        return;
      }
      document.body.style.cursor = 'pointer';
      const load = activeBranchLoadings[String(br.id)] ?? 35.0;
      const isOut = outagedLines.includes(br.id);
      const isBridge = bridgeBranchIds.has(br.id);
      const mouseX = e?.clientX || window.innerWidth / 2;
      const mouseY = e?.clientY || window.innerHeight / 2;

      const critRisk = showCriticality && branchCriticalityMap ? branchCriticalityMap[br.id] : undefined;
      const isInfluential = glowInfluential && influentialBranchIds.has(br.id);

      setTooltip({
        type: 'branch',
        x: mouseX,
        y: mouseY,
        title: br.name || formatBranchName(br.from_bus, br.to_bus, 1),
        details: [
          isBridge ? '★ BRIDGE CUT-EDGE (Failure islands network component)' : null,
          critRisk !== undefined ? `N-1 Fragility Risk: ${(critRisk * 100).toFixed(1)}% if alone outaged` : null,
          isInfluential ? '★ Model Saliency: Top Influential Line' : null,
          `Loading: ${load.toFixed(1)}% of limit`,
          `Impedance: R=${br.r_ohm.toFixed(2)}Ω, X=${br.x_ohm.toFixed(2)}Ω`,
          isOut ? 'Status: OUTAGED (disconnected)' : 'Status: In-Service'
        ].filter(Boolean) as string[],
        actionHint: isOut ? 'Click to restore' : 'Click to take it out (Shift+click for 2nd outage)'
      });
    },
    [activeBranchLoadings, outagedLines, showCriticality, branchCriticalityMap, glowInfluential, influentialBranchIds, bridgeBranchIds]
  );

  const handleClickBranch = useCallback(
    (br: Branch, isShift: boolean) => {
      toggleOutagedElement(`line_${br.id}`, isShift);
    },
    [toggleOutagedElement]
  );

  // Bus interaction handlers
  const handleHoverBus = useCallback(
    (bus: Bus | null, e?: any) => {
      setHoveredBus(bus);
      if (!bus) {
        setTooltip(null);
        document.body.style.cursor = 'default';
        return;
      }
      document.body.style.cursor = 'pointer';
      const mouseX = e?.clientX || window.innerWidth / 2;
      const mouseY = e?.clientY || window.innerHeight / 2;
      const isGen = bus.type === 'generator';
      const isSlack = bus.type === 'slack';
      const isGenOut = outagedGens.includes(bus.id);

      const deg = topologyData?.per_bus_degree ? topologyData.per_bus_degree[bus.id] : undefined;
      const bet = topologyData?.per_bus_betweenness ? topologyData.per_bus_betweenness[bus.id] : undefined;
      const comm = topologyData?.per_bus_community ? topologyData.per_bus_community[bus.id] : undefined;

      const details = [
        `Voltage Level: ${bus.vn_kv} kV`,
        deg !== undefined ? `Topology Degree: ${deg} connections` : null,
        bet !== undefined ? `Betweenness Centrality: ${bet.toFixed(4)}` : null,
        comm !== undefined ? `Community Cluster: Group #${comm}` : null,
        isSlack ? 'Role: Reference Slack Bus' : null,
        bus.base_p_mw > 0 ? `Active Load: ${bus.base_p_mw.toFixed(1)} MW` : null,
        bus.gen_p_mw > 0 ? `Active Generation: ${bus.gen_p_mw.toFixed(1)} MW` : null,
        isGenOut ? 'Status: GENERATOR TRIPPED' : null
      ].filter(Boolean) as string[];

      setTooltip({
        type: 'bus',
        x: mouseX,
        y: mouseY,
        title: `Bus ${bus.id} (${bus.type.toUpperCase()})`,
        details,
        actionHint: isGen
          ? isGenOut
            ? 'Click to restore generator'
            : 'Click to take out generator unit'
          : undefined
      });
    },
    [outagedGens, topologyData]
  );

  const handleClickBus = useCallback(
    (bus: Bus, isShift: boolean) => {
      if (bus.type === 'generator') {
        toggleOutagedElement(`gen_${bus.id}`, isShift);
      }
    },
    [toggleOutagedElement]
  );

  // Non-passive wheel handler: prevents page scroll while cursor is over the 3D canvas
  const canvasWrapperRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = canvasWrapperRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => e.preventDefault();
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, []);

  return (
    <div ref={canvasWrapperRef} className={`relative w-full ${isFullscreen ? 'h-full flex-1' : 'h-[500px]'} bg-soft overflow-hidden select-none border border-[#e5e7eb]`}>
      {/* 1. 3D | Map View Switch & Controls (Top-Left of Scene) - hidden in full screen to avoid duplication */}
      {!isFullscreen && (
        <div className="absolute top-3 left-3 z-30 flex flex-wrap items-center gap-2 select-none">
          {/* View Mode Toggle */}
          <div className="flex items-center bg-white/95 backdrop-blur-md border border-[#cfd3d8] shadow-2xs p-0.5">
            <button
              onClick={() => setViewMode('3d')}
              className={`px-3 py-1 text-xs font-medium transition-all ${
                viewMode === '3d'
                  ? 'bg-charcoal text-white shadow-2xs'
                  : 'text-[#555] hover:text-ink'
              }`}
            >
              3D View
            </button>
            <button
              onClick={() => setViewMode('map')}
              className={`px-3 py-1 text-xs font-medium transition-all ${
                viewMode === 'map'
                  ? 'bg-charcoal text-white shadow-2xs'
                  : 'text-[#555] hover:text-ink'
              }`}
            >
              Map (2D)
            </button>
            <button
              onClick={() => setViewMode('city')}
              className={`px-3 py-1 text-xs font-medium transition-all ${
                viewMode === 'city'
                  ? 'bg-charcoal text-white shadow-2xs'
                  : 'text-[#555] hover:text-ink'
              }`}
            >
              City
            </button>
          </div>

          {/* Labels: Smart | All | Off */}
          <div className="flex items-center bg-white/95 backdrop-blur-md border border-[#cfd3d8] shadow-2xs p-0.5 text-xs">
            <span className="px-2 py-0.5 text-[10px] uppercase font-mono tracking-wider text-[#666]">Labels</span>
            {(['smart', 'all', 'off'] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => setLabelMode(mode)}
                className={`px-2 py-0.5 text-[11px] font-medium capitalize transition-all ${
                  labelMode === mode ? 'bg-charcoal text-white shadow-2xs' : 'text-[#555] hover:text-ink'
                }`}
              >
                {mode}
              </button>
            ))}
          </div>

          {/* Topology Overlay Menu in Map Mode */}
          {viewMode === 'map' && (
            <div className="flex items-center gap-1 bg-white/95 backdrop-blur-md border border-[#cfd3d8] shadow-2xs px-2 py-1 text-xs">
              <span className="eyebrow mr-1 text-charcoal">Topology:</span>
              {(['none', 'degree', 'betweenness', 'community', 'bridges'] as const).map((overlay) => (
                <button
                  key={overlay}
                  onClick={() => setTopologyOverlay(overlay)}
                  className={`px-2 py-0.5 text-[11px] capitalize transition-colors ${
                    topologyOverlay === overlay
                      ? 'bg-charcoal text-white font-medium'
                      : 'text-[#555] hover:text-ink hover:bg-[#f0f0f0]'
                  }`}
                >
                  {overlay === 'community' ? 'Clusters' : overlay}
                </button>
              ))}
            </div>
          )}

          {/* Group by Voltage Toggle in Map Mode (only when 2+ voltages) */}
          {viewMode === 'map' && uniqueVoltages.length >= 2 && (
            <label className="flex items-center gap-1.5 bg-white/95 backdrop-blur-md border border-[#cfd3d8] shadow-2xs px-2.5 py-1 text-xs text-[#555] cursor-pointer hover:text-ink">
              <input
                type="checkbox"
                checked={groupByVoltage}
                onChange={(e) => setGroupByVoltage(e.target.checked)}
                className="accent-charcoal cursor-pointer"
              />
              <span className="text-[11px] font-medium">Group by voltage</span>
            </label>
          )}
        </div>
      )}

      {/* 2. Topology Stats Card (In Map Mode or when overlay active) */}
      {viewMode === 'map' && topologyData && (
        <div className="absolute top-14 left-3 z-20 bg-white/95 backdrop-blur-md border border-[#cfd3d8] p-3 shadow-md text-xs space-y-1.5 min-w-[210px] select-none">
          <div className="flex items-center justify-between border-b border-[#e5e7eb] pb-1">
            <span className="eyebrow">Topology Graph Stats</span>
            <span className="text-[10px] font-mono text-[#888]">{gridCase.toUpperCase()}</span>
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11px] font-mono pt-0.5">
            <div>
              <span className="text-[#666] block text-[9.5px]">Avg Degree</span>
              <span className="font-semibold text-ink">{topologyData.average_degree?.toFixed(2) ?? '---'}</span>
            </div>
            <div>
              <span className="text-[#666] block text-[9.5px]">Bridges</span>
              <span className="font-semibold text-amber">{topologyData.num_bridge_branches ?? 0}</span>
            </div>
            <div>
              <span className="text-[#666] block text-[9.5px]">Islands</span>
              <span className="font-semibold text-ink">{topologyData.num_islands ?? 1}</span>
            </div>
            <div>
              <span className="text-[#666] block text-[9.5px]">Diameter</span>
              <span className="font-semibold text-ink">{topologyData.diameter ?? '---'}</span>
            </div>
          </div>
        </div>
      )}

      {/* Visible Error State when loading fails */}
      {gridError ? (
        <div className="absolute inset-0 z-30 bg-[#f7f8f9] flex flex-col items-center justify-center p-6 text-center">
          <div className="w-12 h-12 rounded-full bg-red/10 text-red flex items-center justify-center mb-3">
            <AlertTriangle className="w-6 h-6" />
          </div>
          <h3 className="text-base font-serif font-bold text-ink mb-1">
            Could not load grid data. Is the backend running?
          </h3>
          <p className="text-xs text-[#666] max-w-md mb-3 leading-relaxed">
            The transmission scene could not connect to the power flow topology service. Verify that the FastAPI backend server is active.
          </p>
          {failingUrl && (
            <div className="text-[11px] font-mono text-[#666] bg-white px-3 py-1.5 border border-[#e5e7eb] mb-4 max-w-md truncate shadow-2xs">
              <span className="text-[#999] select-none">Failing URL: </span>
              <span className="text-red font-medium">{failingUrl}</span>
            </div>
          )}
          <button
            type="button"
            onClick={() => {
              fetchGridList();
              fetchGridAndLayout();
            }}
            className="btn-estate-dark text-xs py-2 px-4 flex items-center gap-1.5 hover:bg-charcoal"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Retry</span>
          </button>
        </div>
      ) : null}

      {/* Loading state indicator */}
      {loadingGrid && !gridError && (
        <div className="absolute inset-0 z-20 bg-soft/80 backdrop-blur-xs flex flex-col items-center justify-center pointer-events-none">
          <div className="w-7 h-7 border-2 border-charcoal/20 border-t-charcoal rounded-full animate-spin mb-2" />
          <p className="text-xs font-mono text-[#666]">Rendering transmission topology...</p>
        </div>
      )}

      {/* Canvas / Scene */}
      {viewMode === 'city' ? (
        <CityScene
          buses={buses}
          branches={branches}
          layoutMap={layoutMap}
          outagedLines={outagedLines}
          outagedGens={outagedGens}
          branchLoading={activeBranchLoadings}
          activeIsolatedBuses={activeIsolatedBuses}
          gridRadius={gridRadius}
          cameraResetTrigger={cameraResetTrigger}
          reducedMotion={reducedMotion}
          canvasWrapperRef={canvasWrapperRef}
          onClickBranch={(br, isShift) => handleClickBranch(br, isShift ?? false)}
          onHoverBranch={handleHoverBranch}
          onClickBus={(bus, isShift) => handleClickBus(bus, isShift ?? false)}
          onHoverBus={handleHoverBus}
          hoveredBranchId={hoveredBranch?.id ?? null}
          hoveredBusId={hoveredBus?.id ?? null}
          newlyTrippedBranchIds={newlyTrippedBranchIds}
          previouslyTrippedBranchIds={previouslyTrippedBranchIds}
          overloadedBranchIds={overloadedBranchIds}
          framingCentroid={framingCentroid}
        />
      ) : (
        <Canvas
          camera={{ position: [0, 1.12, 3.68], fov: 44 }}
          gl={{ antialias: true, alpha: true }}
          onWheel={(e) => e.stopPropagation()}
        >
          <ambientLight intensity={1.15} />
          <pointLight position={[6, 12, 6]} intensity={1.2} />
          <pointLight position={[-6, -6, -6]} intensity={0.4} />

          <SceneCameraController
            cameraResetTrigger={cameraResetTrigger}
            shakeIntensity={shakeIntensity}
            reducedMotion={reducedMotion}
            viewMode={viewMode === 'map' ? 'map' : '3d'}
            gridRadius={gridRadius}
            gridCase={gridCase}
            framingCentroid={framingCentroid}
          />

          <AnimatedSceneGroup
            viewMode={viewMode === 'map' ? 'map' : '3d'}
            layoutMap={layoutMap}
            mapLayoutMap={mapLayoutMap}
            buses={buses}
            branches={branches}
            outagedLines={outagedLines}
            outagedGens={outagedGens}
            activeBranchLoadings={activeBranchLoadings}
            activeIsolatedBuses={activeIsolatedBuses}
            hoveredBranch={hoveredBranch}
            onHoverBranch={handleHoverBranch}
            onClickBranch={handleClickBranch}
            onHoverBus={handleHoverBus}
            onClickBus={handleClickBus}
            reducedMotion={reducedMotion}
            glowInfluential={glowInfluential}
            influentialBranchIds={influentialBranchIds}
            showCriticality={showCriticality}
            branchCriticalityMap={branchCriticalityMap}
            showMaintenanceOverlay={showMaintenanceOverlay}
            maintenancePriorityMap={maintenancePriorityMap}
            topologyOverlay={topologyOverlay}
            topologyData={topologyData}
            bridgeBranchIds={bridgeBranchIds}
            shockwaveOrigin={shockwaveOrigin}
            shockwaveTime={shockwaveTime}
            sparks={sparks}
            showBusNumbers={showBusNumbers}
            labelMode={labelMode}
            groupByVoltage={groupByVoltage}
            uniqueVoltages={uniqueVoltages}
            gridRadius={gridRadius}
            hoveredBusId={hoveredBus?.id ?? null}
            newlyTrippedBranchIds={newlyTrippedBranchIds}
            previouslyTrippedBranchIds={previouslyTrippedBranchIds}
            overloadedBranchIds={overloadedBranchIds}
          />
        </Canvas>
      )}

      {/* Floating Rich Tooltip */}
      {tooltip && (
        <div
          className="fixed z-50 pointer-events-none transition-transform duration-75 ease-out"
          style={{
            left: `${tooltip.x + 14}px`,
            top: `${tooltip.y + 14}px`,
            transform: 'translate(0, 0)'
          }}
        >
          <div className="bg-white/95 backdrop-blur-md px-3.5 py-2.5 border border-charcoal/30 shadow-lg text-ink min-w-[220px] rounded-none">
            <p className="text-xs font-semibold tracking-tight text-ink border-b border-[#e5e7eb] pb-1 mb-1.5 flex items-center justify-between">
              <span>{tooltip.title}</span>
              {tooltip.type === 'branch' && <span className="text-[10px] text-[#666] font-normal">Branch</span>}
            </p>
            {tooltip.details.map((d, i) => (
              <p key={i} className="text-[11px] text-[#444] leading-relaxed">
                {d}
              </p>
            ))}
            {tooltip.actionHint && (
              <p className="mt-2 pt-1 border-t border-[#f0f0f0] text-[10px] font-medium text-red flex items-center gap-1">
                <span>⚡</span>
                <span>{tooltip.actionHint}</span>
              </p>
            )}
          </div>
        </div>
      )}

      {/* Map Mode Voltage Bands Indicator - only when enabled and grid has multiple voltages */}
      {viewMode === 'map' && groupByVoltage && uniqueVoltages.length >= 2 && (
        <div className="absolute bottom-3 left-4 pointer-events-none z-10">
          <span className="text-[11px] text-[#555] bg-white/90 backdrop-blur-sm px-2.5 py-1 border border-[#e5e7eb] font-mono shadow-2xs">
            Voltage Bands: Color-coded zones group buses by rated voltage level
          </span>
        </div>
      )}

      {/* Replay Overlay Banner if active */}
      {isPlayingReplay && replayData && replayStepIndex >= 0 && (
        <div className="absolute top-3 right-4 z-20 bg-charcoal/90 text-white px-3.5 py-2 border border-white/20 shadow-lg flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-red animate-ping" />
            <span className="text-xs font-semibold uppercase tracking-wider text-amber">
              Cascade Replay Step {replayStepIndex + 1}/{replayData.total_steps}
            </span>
          </div>
          <span className="text-xs text-white/90 font-mono">
            {replayData.steps[replayStepIndex]?.description || 'Tripping propagation'}
          </span>
        </div>
      )}
    </div>
  );
};
