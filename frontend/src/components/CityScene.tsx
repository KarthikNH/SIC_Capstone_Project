/**
 * CityScene.tsx -- Procedural digital-twin city scene
 *
 * Renders any bus/branch grid as an isometric-style city:
 *   - Ground plane with seamless horizon fading into #eef2f8 fog and background
 *   - Instanced low-poly buildings, substation yards, generator plants, lattice pylons, catenary cables
 *   - Smart screen-space collision avoidance & priority labels with leader lines
 *   - Frame padding so the whole city fits comfortably in view
 *   - Labels: Smart | All | Off and Detail: Low | High toggles
 */

import React, { useRef, useMemo, useState, useEffect, useCallback } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, Html } from '@react-three/drei';
import * as THREE from 'three';
import type { Bus, Branch, BusLayout } from '../types';
import { useGridStore } from '../store';

// ---- Palette ---------------------------------------------------------------
const C_GROUND      = new THREE.Color('#eef2f8');
const C_GRID        = new THREE.Color('#d4dae5');
const C_ROAD        = new THREE.Color('#dce2ec');
const C_BUILDING    = new THREE.Color('#b0b5bc');
const C_BLDG_DARK   = new THREE.Color('#8a9099');
const C_YARD        = new THREE.Color('#d0d4d9');
const C_FENCE       = new THREE.Color('#9aa3ad');
const C_TRANSFORMER = new THREE.Color('#7a8490');
const C_PLANT       = new THREE.Color('#9aa3ad');
const C_CHIMNEY     = new THREE.Color('#7a8490');
const C_PYLON       = new THREE.Color('#8a9099');
const C_CABLE       = new THREE.Color('#5a6270');
const C_CABLE_ST    = new THREE.Color('#d98a1f');
const C_CABLE_OV    = new THREE.Color('#c8443b');
const C_CABLE_OUT   = new THREE.Color('#e02424');
const C_WIN_ON      = new THREE.Color('#fef3c7');

function voltColour(kv: number): string {
  if (kv >= 345) return '#7c3aed';
  if (kv >= 230) return '#2563eb';
  if (kv >= 115) return '#f59e0b';
  if (kv >= 69)  return '#16a34a';
  return '#9aa3ad';
}

function busShortLabel(bus: Bus): string {
  const prefix =
    bus.type === 'generator'    ? 'GEN'
    : bus.type === 'slack'      ? 'REF'
    : bus.type === 'substation' ? 'SUB'
    : 'BUS';
  return `${prefix} ${bus.id + 1}`;
}

function busFullDetail(bus: Bus, hasSingleVoltage: boolean): string {
  const short = busShortLabel(bus);
  const parts: string[] = [short];
  if (!hasSingleVoltage && bus.vn_kv) {
    parts.push(`${bus.vn_kv} kV`);
  }
  if (bus.type === 'generator' && bus.gen_p_mw) {
    parts.push(`${Math.round(bus.gen_p_mw)} MW gen`);
  } else if (bus.base_p_mw && bus.base_p_mw > 0) {
    parts.push(`${Math.round(bus.base_p_mw)} MW load`);
  }
  return parts.join(' \u00b7 ');
}

// ---- Layout helpers --------------------------------------------------------
function projectToGround(
  layoutMap: Record<number, BusLayout>,
  scale: number,
): Record<number, THREE.Vector2> {
  const out: Record<number, THREE.Vector2> = {};
  for (const [id, pos] of Object.entries(layoutMap)) {
    out[Number(id)] = new THREE.Vector2(pos.x * scale, pos.z * scale);
  }
  return out;
}

function relaxPositions(
  pos: Record<number, THREE.Vector2>,
  minDist: number,
  iters = 8,
): Record<number, THREE.Vector2> {
  const ids = Object.keys(pos).map(Number);
  const cur: Record<number, THREE.Vector2> = {};
  ids.forEach(id => (cur[id] = pos[id].clone()));
  for (let iter = 0; iter < iters; iter++) {
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i], b = ids[j];
        const d = cur[a].distanceTo(cur[b]);
        if (d < minDist && d > 0.001) {
          const push = ((minDist - d) / 2) * 0.5;
          const dir = cur[b].clone().sub(cur[a]).normalize();
          cur[a].sub(dir.clone().multiplyScalar(push));
          cur[b].add(dir.clone().multiplyScalar(push));
        }
      }
    }
  }
  return cur;
}

// ---- Catenary curve --------------------------------------------------------
function buildCatenary(
  a: THREE.Vector3,
  b: THREE.Vector3,
  sag: number,
  segs = 24,
): THREE.Vector3[] {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    pts.push(new THREE.Vector3(
      a.x + (b.x - a.x) * t,
      a.y + (b.y - a.y) * t - sag * 4 * t * (1 - t),
      a.z + (b.z - a.z) * t,
    ));
  }
  return pts;
}

// ---- Ground plane ----------------------------------------------------------
const GroundPlane: React.FC<{ size: number }> = ({ size }) => {
  const vastSize = Math.max(1600, size * 25);
  const padSize = size * 1.5;
  const gridLines = useMemo(() => {
    const step = Math.max(0.4, padSize / 24);
    const half = padSize * 0.55;
    const verts: number[] = [];
    for (let x = -half; x <= half + 0.001; x += step) {
      verts.push(x, 0.005, -half, x, 0.005, half);
    }
    for (let z = -half; z <= half + 0.001; z += step) {
      verts.push(-half, 0.005, z, half, 0.005, z);
    }
    return new Float32Array(verts);
  }, [padSize]);

  return (
    <group>
      {/* Expansive horizon ground base plane - prevents any black void at any camera distance or angle */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, 0]} receiveShadow>
        <planeGeometry args={[vastSize, vastSize]} />
        <meshBasicMaterial color={C_GROUND} />
      </mesh>

      {/* Main city ground pad */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
        <planeGeometry args={[padSize, padSize]} />
        <meshStandardMaterial color="#e5ebf3" roughness={0.92} />
      </mesh>

      {/* Subtle road ribbons */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.002, 0]}>
        <planeGeometry args={[padSize, padSize * 0.03]} />
        <meshStandardMaterial color={C_ROAD} roughness={0.88} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.002, 0]}>
        <planeGeometry args={[padSize * 0.03, padSize]} />
        <meshStandardMaterial color={C_ROAD} roughness={0.88} />
      </mesh>

      {/* Fine schematic coordinate grid */}
      <lineSegments>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[gridLines, 3]} />
        </bufferGeometry>
        <lineBasicMaterial color={C_GRID} transparent opacity={0.65} />
      </lineSegments>
    </group>
  );
};

// ---- Building cluster (load bus) -------------------------------------------
const BuildingCluster: React.FC<{
  pos: THREE.Vector2;
  loadMw: number;
  maxLoad: number;
  isIsolated: boolean;
  isHovered: boolean;
  detailLevel?: 'low' | 'high';
  opacity?: number;
  onClick: () => void;
  onPointerOver: (e: any) => void;
  onPointerOut: () => void;
}> = ({ pos, loadMw, maxLoad, isIsolated, isHovered, detailLevel = 'high', opacity = 1.0, onClick, onPointerOver, onPointerOut }) => {
  const norm = Math.max(0, Math.min(1, loadMw / Math.max(1, maxLoad)));
  const mainH = 0.25 + norm * 1.55;
  const fp = 0.22 + norm * 0.18;
  const tint = isIsolated ? C_BLDG_DARK : isHovered ? new THREE.Color().copy(C_BUILDING).offsetHSL(0, 0, 0.1) : C_BUILDING;

  // Deterministic small offsets
  const sx = ((Math.sin((pos.x * 31.1 + pos.y * 7.3) * 127) * 4375.8) % 1 + 1) % 1;
  const offsets: [number, number, number, number][] = useMemo(() => {
    const list: [number, number, number, number][] = [
      [0, mainH, fp, 1],
      [((Math.sin(sx * 7 + 1) * 4375) % 1 + 1) % 1 * 0.35 - 0.175, mainH * 0.6, fp * 0.78, 0.92],
      [((Math.sin(sx * 7 + 3) * 4375) % 1 + 1) % 1 * 0.35 - 0.175, mainH * 0.42, fp * 0.60, 0.84],
    ];
    return detailLevel === 'low' ? list.slice(0, 1) : list;
  }, [mainH, fp, sx, detailLevel]);

  const isTrans = opacity < 0.999;

  return (
    <group position={[pos.x, 0, pos.y]} onClick={onClick} onPointerOver={onPointerOver} onPointerOut={onPointerOut}>
      {offsets.map(([ox, h, f, bright], i) => (
        <mesh
          key={i}
          position={[ox, h / 2, i === 2 ? 0.12 : 0]}
          castShadow={!isTrans}
          receiveShadow={!isTrans}
          renderOrder={isTrans ? 10 : 0}
        >
          <boxGeometry args={[f, h, f]} />
          <meshStandardMaterial
            color={new THREE.Color().copy(tint).offsetHSL(0, 0, (bright - 1) * 0.12)}
            roughness={0.8}
            transparent={isTrans}
            opacity={opacity}
            depthWrite={!isTrans}
          />
        </mesh>
      ))}
      {!isIsolated && mainH > 0.4 && opacity > 0.05 && (
        <mesh position={[0, mainH / 2, fp / 2 + 0.002]} renderOrder={isTrans ? 12 : 1}>
          <planeGeometry args={[fp * 0.76, mainH * 0.82]} />
          <meshStandardMaterial
            color={C_WIN_ON}
            emissive={C_WIN_ON}
            emissiveIntensity={0.15 * opacity}
            transparent
            opacity={0.65 * opacity}
            depthWrite={false}
          />
        </mesh>
      )}
    </group>
  );
};

// ---- Substation yard -------------------------------------------------------
const SubstationYard: React.FC<{
  pos: THREE.Vector2;
  isHovered: boolean;
  isOutaged: boolean;
  isIsolated?: boolean;
  opacity?: number;
  onClick: () => void;
  onPointerOver: (e: any) => void;
  onPointerOut: () => void;
}> = ({ pos, isHovered, isOutaged, isIsolated, opacity = 1.0, onClick, onPointerOver, onPointerOut }) => {
  const isTrans = opacity < 0.999 || Boolean(isIsolated);
  const effOpacity = (isIsolated ? 0.35 : 1.0) * opacity;

  return (
    <group
      position={[pos.x, 0, pos.y]}
      onClick={onClick}
      onPointerOver={onPointerOver}
      onPointerOut={onPointerOut}
    >
      <mesh position={[0, 0.01, 0]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={isTrans ? 10 : 0}>
        <planeGeometry args={[0.65, 0.55]} />
        <meshStandardMaterial
          color={isIsolated ? '#8a9099' : isHovered ? '#d8dce2' : C_YARD}
          roughness={0.9}
          transparent={isTrans}
          opacity={effOpacity}
          depthWrite={!isTrans}
        />
      </mesh>
      {/* Fence walls */}
      {([[-0.325, 0.045, 0, 0.01, 0.09, 0.55],
         [ 0.325, 0.045, 0, 0.01, 0.09, 0.55],
         [0, 0.045, -0.275, 0.65, 0.09, 0.01],
         [0, 0.045,  0.275, 0.65, 0.09, 0.01]] as [number,number,number,number,number,number][]).map(
        ([x, y, z, w, h, d], i) => (
          <mesh key={i} position={[x, y, z]} renderOrder={isTrans ? 10 : 0}>
            <boxGeometry args={[w, h, d]} />
            <meshStandardMaterial
              color={C_FENCE}
              roughness={0.95}
              transparent={isTrans}
              opacity={effOpacity}
              depthWrite={!isTrans}
            />
          </mesh>
        )
      )}
      {/* Transformer boxes */}
      {([-0.15, 0.05, 0.15] as number[]).map((tx, i) => (
        <mesh key={i} position={[tx, 0.09, (i === 2 ? 0.1 : 0)]} castShadow={!isTrans} renderOrder={isTrans ? 10 : 0}>
          <boxGeometry args={[0.11, 0.18, 0.13]} />
          <meshStandardMaterial
            color={isIsolated ? '#7a8490' : isOutaged ? '#c8443b' : C_TRANSFORMER}
            roughness={0.7}
            transparent={isTrans}
            opacity={effOpacity}
            depthWrite={!isTrans}
            emissive={!isIsolated && isOutaged ? new THREE.Color('#7a2020') : new THREE.Color('#000000')}
            emissiveIntensity={!isIsolated && isOutaged ? 0.35 * opacity : 0}
          />
        </mesh>
      ))}
      {/* Bushing insulators */}
      {([-0.15, 0.05] as number[]).map((tx, i) => (
        <mesh key={i} position={[tx, 0.215, 0]} renderOrder={isTrans ? 10 : 0}>
          <cylinderGeometry args={[0.014, 0.014, 0.055, 8]} />
          <meshStandardMaterial
            color="#e0e0e0"
            roughness={0.5}
            transparent={isTrans}
            opacity={effOpacity}
            depthWrite={!isTrans}
          />
        </mesh>
      ))}
    </group>
  );
};

// ---- Generator plant -------------------------------------------------------
const GeneratorPlant: React.FC<{
  pos: THREE.Vector2;
  genMw: number;
  isHovered: boolean;
  isOutaged: boolean;
  isIsolated?: boolean;
  opacity?: number;
  onClick: () => void;
  onPointerOver: (e: any) => void;
  onPointerOut: () => void;
}> = ({ pos, genMw, isHovered, isOutaged, isIsolated, opacity = 1.0, onClick, onPointerOver, onPointerOut }) => {
  const norm = Math.max(0.15, Math.min(1, genMw / 200));
  const hallH = 0.28 + norm * 0.32;
  const isTrans = opacity < 0.999 || Boolean(isIsolated);
  const effOpacity = (isIsolated ? 0.35 : 1.0) * opacity;

  return (
    <group position={[pos.x, 0, pos.y]} onClick={onClick} onPointerOver={onPointerOver} onPointerOut={onPointerOut}>
      <mesh position={[0, hallH / 2, 0]} castShadow={!isTrans} renderOrder={isTrans ? 10 : 0}>
        <boxGeometry args={[0.55, hallH, 0.35]} />
        <meshStandardMaterial
          color={isIsolated ? '#7a8490' : isHovered ? new THREE.Color().copy(C_PLANT).offsetHSL(0, 0, 0.06) : C_PLANT}
          roughness={0.85}
          transparent={isTrans}
          opacity={effOpacity}
          depthWrite={!isTrans}
          emissive={!isIsolated && isOutaged ? new THREE.Color('#7a2020') : new THREE.Color('#000000')}
          emissiveIntensity={!isIsolated && isOutaged ? 0.35 * opacity : 0}
        />
      </mesh>
      <mesh position={[0.2, hallH + 0.22, -0.08]} castShadow={!isTrans} renderOrder={isTrans ? 10 : 0}>
        <cylinderGeometry args={[0.044, 0.06, 0.44, 8]} />
        <meshStandardMaterial color={C_CHIMNEY} roughness={0.9} transparent={isTrans} opacity={effOpacity} depthWrite={!isTrans} />
      </mesh>
      <mesh position={[-0.2, 0.12, 0.05]} castShadow={!isTrans} renderOrder={isTrans ? 10 : 0}>
        <boxGeometry args={[0.18, 0.24, 0.22]} />
        <meshStandardMaterial color={C_BLDG_DARK} roughness={0.9} transparent={isTrans} opacity={effOpacity} depthWrite={!isTrans} />
      </mesh>
    </group>
  );
};

// ---- Slack marker ----------------------------------------------------------
const SlackMarker: React.FC<{ pos: THREE.Vector2 }> = ({ pos }) => (
  <group position={[pos.x, 0, pos.y]}>
    <mesh position={[0, 0.18, 0]}>
      <cylinderGeometry args={[0.015, 0.015, 0.36, 8]} />
      <meshStandardMaterial color={C_PYLON} roughness={0.8} />
    </mesh>
    <mesh position={[0, 0.38, 0]}>
      <sphereGeometry args={[0.04, 10, 10]} />
      <meshBasicMaterial color="#f59e0b" />
    </mesh>
  </group>
);

// ---- Pylon geometry (shared, built once) ------------------------------------
const PYLON_H = 0.55;
const PYLON_BASE = 0.14;
const PYLON_TOP  = 0.06;

function buildPylonGeometry(): THREE.BufferGeometry {
  const verts: number[] = [];
  const add = (a: THREE.Vector3, b: THREE.Vector3) =>
    verts.push(a.x, a.y, a.z, b.x, b.y, b.z);

  const base = [
    new THREE.Vector3(-PYLON_BASE/2, 0,  PYLON_BASE/2),
    new THREE.Vector3( PYLON_BASE/2, 0,  PYLON_BASE/2),
    new THREE.Vector3( PYLON_BASE/2, 0, -PYLON_BASE/2),
    new THREE.Vector3(-PYLON_BASE/2, 0, -PYLON_BASE/2),
  ];
  const midH = PYLON_H * 0.42;
  const mid = base.map(c => new THREE.Vector3(c.x * 0.55, midH, c.z * 0.55));
  const top = base.map(c => new THREE.Vector3(c.x * PYLON_TOP / PYLON_BASE, PYLON_H, c.z * PYLON_TOP / PYLON_BASE));

  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    add(base[i], mid[i]);
    add(mid[i],  top[i]);
    add(base[i], base[j]);
    add(mid[i],  mid[j]);
    add(top[i],  top[j]);
    add(base[i], mid[j]);
    add(mid[i],  top[j]);
  }
  const arm = PYLON_TOP * 2.5;
  add(new THREE.Vector3(-arm/2, PYLON_H, 0), new THREE.Vector3(arm/2, PYLON_H, 0));

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  return geo;
}

const SHARED_PYLON_GEO = buildPylonGeometry();

// ---- Cable branch renderer -------------------------------------------------
const CableBranch: React.FC<{
  branch: Branch;
  posA: THREE.Vector2;
  posB: THREE.Vector2;
  loading: number;
  isOutaged: boolean;
  isHovered: boolean;
  isNewlyTripped?: boolean;
  isPreviouslyTripped?: boolean;
  isOverloaded?: boolean;
  detailLevel?: 'low' | 'high';
  showMaintenanceOverlay?: boolean;
  maintenancePriorityMap?: Record<number, { priority: number; color: string; urgency: string }> | null;
  onClick: (shiftKey: boolean) => void;
  onPointerOver: (e: any) => void;
  onPointerOut: () => void;
}> = ({
  branch,
  posA,
  posB,
  loading,
  isOutaged,
  isHovered,
  detailLevel = 'high',
  isNewlyTripped = false,
  isPreviouslyTripped = false,
  isOverloaded = false,
  showMaintenanceOverlay = false,
  maintenancePriorityMap,
  onClick,
  onPointerOver,
  onPointerOut
}) => {
  const dx = posB.x - posA.x;
  const dz = posB.y - posA.y;
  const dist = Math.sqrt(dx * dx + dz * dz);
  if (dist < 0.02) return null;

  const cableColor = isNewlyTripped
    ? new THREE.Color('#ef4444')
    : isPreviouslyTripped
    ? new THREE.Color('#6b7280')
    : isOutaged
    ? C_CABLE_OUT.clone()
    : showMaintenanceOverlay && maintenancePriorityMap && maintenancePriorityMap[branch.id] !== undefined
    ? new THREE.Color(maintenancePriorityMap[branch.id].color)
    : isOverloaded || loading >= 100
    ? C_CABLE_OV.clone()
    : loading >= 65
    ? C_CABLE_ST.clone()
    : isHovered
    ? new THREE.Color().copy(C_CABLE).offsetHSL(0, 0, 0.18)
    : C_CABLE.clone();

  const isTransformer = branch.is_transformer;
  const sag = (isOutaged || isNewlyTripped || isPreviouslyTripped)
    ? 0.08 + dist * 0.12
    : 0.06 + dist * 0.055;
  const numPylons = isTransformer
    ? 0
    : detailLevel === 'low'
      ? Math.min(2, Math.max(1, Math.round(dist / 2.4)))
      : Math.max(2, Math.round(dist / 1.3));

  const pylonPositions = useMemo(() => {
    const pts: THREE.Vector3[] = [];
    if (numPylons === 0) return pts;
    for (let i = 0; i <= numPylons; i++) {
      const t = i / numPylons;
      pts.push(new THREE.Vector3(posA.x + dx * t, 0, posA.y + dz * t));
    }
    return pts;
  }, [posA.x, posA.y, posB.x, posB.y, numPylons, dx, dz]);

  const cableTubes = useMemo(() => {
    if (isTransformer) {
      const a3 = new THREE.Vector3(posA.x, 0.22, posA.y);
      const b3 = new THREE.Vector3(posB.x, 0.22, posB.y);
      const pts = [a3, new THREE.Vector3().lerpVectors(a3, b3, 0.5), b3];
      try {
        const curve = new THREE.CatmullRomCurve3(pts);
        return [new THREE.TubeGeometry(curve, 8, 0.012, 4, false)];
      } catch { return []; }
    }
    const anchors = pylonPositions.map(p => new THREE.Vector3(p.x, PYLON_H, p.z));
    const geos: THREE.TubeGeometry[] = [];
    const segs = detailLevel === 'low' ? 8 : 16;
    for (let i = 0; i < anchors.length - 1; i++) {
      const pts = buildCatenary(anchors[i], anchors[i + 1], sag, segs);
      try {
        const curve = new THREE.CatmullRomCurve3(pts);
        geos.push(new THREE.TubeGeometry(curve, pts.length * 2, 0.009, 4, false));
      } catch { /* skip */ }
    }
    return geos;
  }, [pylonPositions, sag, isTransformer, posA, posB, detailLevel]);

  const midX = (posA.x + posB.x) / 2;
  const midZ = (posA.y + posB.y) / 2;

  return (
    <group>
      {pylonPositions.map((pp, i) => (
        <lineSegments key={i} position={[pp.x, 0, pp.z]}>
          <primitive object={SHARED_PYLON_GEO} attach="geometry" />
          <lineBasicMaterial color={C_PYLON} />
        </lineSegments>
      ))}
      {cableTubes.map((geo, i) => (
        <mesh key={i} geometry={geo}>
          <meshStandardMaterial
            color={cableColor}
            roughness={0.7}
            metalness={0.15}
            emissive={isOverloaded ? new THREE.Color('#d97706') : isNewlyTripped ? new THREE.Color('#ef4444') : new THREE.Color('#000000')}
            emissiveIntensity={isOverloaded ? 0.45 : isNewlyTripped ? 0.55 : 0}
          />
        </mesh>
      ))}

      {/* Tripped Marker Label */}
      {isNewlyTripped && (
        <Html position={[midX, PYLON_H + 0.18, midZ]} center distanceFactor={14}>
          <div className="px-1.5 py-0.5 bg-red text-white text-[9.5px] font-bold font-mono border border-white shadow-md animate-pulse whitespace-nowrap pointer-events-none">
            TRIPPED
          </div>
        </Html>
      )}

      {/* Previously Tripped 'X' Marker */}
      {isPreviouslyTripped && (
        <Html position={[midX, PYLON_H + 0.12, midZ]} center distanceFactor={14}>
          <div className="w-4 h-4 rounded-full bg-white/95 border border-[#6b7280] text-[#4b5563] text-[10px] font-mono font-black flex items-center justify-center shadow-xs pointer-events-none">
            ✕
          </div>
        </Html>
      )}

      {/* Wide invisible hit area */}
      <mesh
        position={[midX, 0.35, midZ]}
        onClick={e => { e.stopPropagation(); onClick(e.nativeEvent?.shiftKey ?? false); }}
        onPointerOver={e => { e.stopPropagation(); onPointerOver(e); }}
        onPointerOut={() => onPointerOut()}
      >
        <cylinderGeometry args={[0.2, 0.2, Math.max(0.2, dist), 6]} />
        <meshBasicMaterial transparent opacity={0.001} depthWrite={false} />
      </mesh>
    </group>
  );
};

// ---- Floating compact label with leader line -------------------------------
const CityLabel: React.FC<{
  bus: Bus;
  pos: THREE.Vector2;
  height: number;
  visible: boolean;
  isDetailed: boolean;
  hasSingleVoltage: boolean;
  isHighPriority?: boolean;
}> = ({ bus, pos, height, visible, isDetailed, hasSingleVoltage, isHighPriority }) => {
  const dot = voltColour(bus.vn_kv);
  const text = isDetailed ? busFullDetail(bus, hasSingleVoltage) : busShortLabel(bus);

  return (
    <Html
      position={[pos.x, height + 0.06, pos.y]}
      center={false}
      zIndexRange={[250, 0]}
    >
      <div
        style={{
          transform: 'translate(-50%, -100%)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          pointerEvents: 'none',
          userSelect: 'none',
          transition: 'opacity 0.18s ease, transform 0.18s ease',
          opacity: visible ? 1 : 0,
        }}
      >
        {/* Compact fixed-pixel pill (does NOT scale with camera distance) */}
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
            boxShadow: '0 1px 4px rgba(0, 0, 0, 0.10)',
            whiteSpace: 'nowrap',
            fontSize: 11,
            lineHeight: '14px',
            fontWeight: 600,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
            color: '#1a2332',
          }}
        >
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: dot, flexShrink: 0 }} />
          <span>{text}</span>
        </div>

        {/* Thin vertical leader line down to the building/yard anchor */}
        <div
          style={{
            width: 1,
            height: 12,
            background: isHighPriority ? '#c8443b' : '#9aa3ad',
            opacity: 0.65,
          }}
        />
      </div>
    </Html>
  );
};

// ---- City camera controller ------------------------------------------------
const CityCameraController: React.FC<{
  gridRadius: number;
  cameraResetTrigger: number;
  framingCentroid?: [number, number, number] | null;
  reducedMotion?: boolean;
}> = ({ gridRadius, cameraResetTrigger, framingCentroid, reducedMotion }) => {
  const controlsRef = useRef<any>(null);
  const { camera } = useThree();
  const r = Math.max(4, gridRadius);
  const isUserInteracting = useRef(false);
  const framingTarget = useRef<THREE.Vector3 | null>(null);
  const framingStartTime = useRef<number>(0);

  // Isometric framed distance with padding so the whole city fits in viewport comfortably
  const frameCam = useCallback(() => {
    if (!controlsRef.current) return;
    camera.position.set(r * 1.75, r * 1.6, r * 1.75);
    controlsRef.current.target.set(0, 0, 0);
    controlsRef.current.update();
    framingTarget.current = null;
  }, [camera, r]);

  useEffect(() => {
    frameCam();
  }, [cameraResetTrigger, r, frameCam]);

  useEffect(() => {
    if (!controlsRef.current) return;
    controlsRef.current.minDistance = r * 0.25;
    controlsRef.current.maxDistance = r * 8.0;
    controlsRef.current.update();
  }, [r]);

  // Gentle framing when new line trips
  useEffect(() => {
    if (framingCentroid && !reducedMotion && !isUserInteracting.current) {
      framingTarget.current = new THREE.Vector3(framingCentroid[0], 0, framingCentroid[2]);
      framingStartTime.current = performance.now() / 1000;
    } else {
      framingTarget.current = null;
    }
  }, [framingCentroid, reducedMotion]);

  useFrame((_, delta) => {
    if (controlsRef.current && framingTarget.current && !isUserInteracting.current) {
      const elapsed = performance.now() / 1000 - framingStartTime.current;
      if (elapsed < 1.8) {
        controlsRef.current.target.lerp(framingTarget.current, Math.min(1, delta * 2.2));
        controlsRef.current.update();
      } else {
        framingTarget.current = null;
      }
    }
  });

  return (
    <OrbitControls
      ref={controlsRef}
      makeDefault
      enableDamping
      dampingFactor={0.08}
      rotateSpeed={0.65}
      zoomSpeed={1.0}
      zoomToCursor
      panSpeed={0.9}
      minDistance={r * 0.25}
      maxDistance={r * 8.0}
      maxPolarAngle={Math.PI / 2.05}
      minPolarAngle={0.08}
      onStart={() => {
        isUserInteracting.current = true;
        framingTarget.current = null;
      }}
      onEnd={() => { isUserInteracting.current = false; }}
    />
  );
};

// ---- Inner scene (runs inside Canvas context) ------------------------------
interface SceneProps {
  buses: Bus[];
  branches: Branch[];
  layoutMap: Record<number, BusLayout>;
  outagedLines: number[];
  outagedGens: number[];
  branchLoading: Record<string, number>;
  activeIsolatedBuses: Set<number>;
  gridRadius: number;
  cameraResetTrigger: number;
  hoveredBranchId: number | null;
  hoveredBusId: number | null;
  detailLevel: 'low' | 'high';
  labelMode: 'smart' | 'all' | 'off';
  buildingsOpacity?: number;
  applyToStructures?: boolean;
  newlyTrippedBranchIds?: Set<number>;
  previouslyTrippedBranchIds?: Set<number>;
  overloadedBranchIds?: Set<number>;
  showMaintenanceOverlay?: boolean;
  maintenancePriorityMap?: Record<number, { priority: number; color: string; urgency: string }> | null;
  framingCentroid?: [number, number, number] | null;
  reducedMotion?: boolean;
  onClickBranch: (br: Branch, isShift?: boolean) => void;
  onHoverBranch: (br: Branch | null, e?: any) => void;
  onClickBus: (bus: Bus, isShift?: boolean) => void;
  onHoverBus: (bus: Bus | null, e?: any) => void;
}

const CitySceneInner: React.FC<SceneProps> = ({
  buses, branches, layoutMap,
  outagedLines, outagedGens, branchLoading, activeIsolatedBuses,
  gridRadius, cameraResetTrigger,
  hoveredBranchId, hoveredBusId,
  detailLevel,
  labelMode,
  buildingsOpacity = 100,
  applyToStructures = false,
  newlyTrippedBranchIds,
  previouslyTrippedBranchIds,
  overloadedBranchIds,
  showMaintenanceOverlay,
  maintenancePriorityMap,
  framingCentroid,
  reducedMotion,
  onClickBranch, onHoverBranch, onClickBus, onHoverBus,
}) => {
  const { camera, size } = useThree();
  const [camDist, setCamDist] = useState(10);
  useFrame(() => setCamDist(camera.position.length()));

  const scale = Math.max(1, gridRadius / 3.5);

  const rawPos = useMemo(
    () => projectToGround(layoutMap, scale),
    [layoutMap, scale],
  );
  const busPos = useMemo(
    () => relaxPositions(rawPos, 0.55, 10),
    [rawPos],
  );
  const maxLoad = useMemo(
    () => Math.max(1, ...buses.map(b => b.base_p_mw || 0)),
    [buses],
  );

  // Single voltage level check
  const uniqueVoltages = useMemo(
    () => Array.from(new Set(buses.map(b => b.vn_kv).filter(Boolean))),
    [buses],
  );
  const hasSingleVoltage = uniqueVoltages.length <= 1;

  function busHeight(bus: Bus): number {
    if (bus.type === 'generator') return 0.6;
    if (bus.type === 'substation') return 0.32;
    if (bus.type === 'slack') return 0.44;
    const n = Math.max(0, Math.min(1, (bus.base_p_mw || 0) / Math.max(1, maxLoad)));
    return 0.25 + n * 1.55;
  }

  // --- Smart label priority sets ---
  const importantBusIds = useMemo(() => {
    const scores = buses.map(b => {
      const gen = b.gen_p_mw || 0;
      const load = b.base_p_mw || 0;
      return { id: b.id, score: gen * 1.5 + load };
    });
    scores.sort((a, b) => b.score - a.score);
    return new Set(scores.slice(0, 8).map(s => s.id));
  }, [buses]);

  const outagedEndBusIds = useMemo(() => {
    const set = new Set<number>();
    outagedGens.forEach(id => set.add(id));
    outagedLines.forEach(lid => {
      const br = branches.find(b => b.id === lid);
      if (br) {
        set.add(br.from_bus);
        set.add(br.to_bus);
      }
    });
    return set;
  }, [outagedGens, outagedLines, branches]);

  const hoveredBusIds = useMemo(() => {
    const set = new Set<number>();
    if (hoveredBusId !== null) set.add(hoveredBusId);
    if (hoveredBranchId !== null) {
      const br = branches.find(b => b.id === hoveredBranchId);
      if (br) {
        set.add(br.from_bus);
        set.add(br.to_bus);
      }
    }
    return set;
  }, [hoveredBusId, hoveredBranchId, branches]);

  const highRiskBusIds = useMemo(() => {
    const set = new Set<number>();
    activeIsolatedBuses.forEach(id => set.add(id));
    branches.forEach(br => {
      const loading = branchLoading[String(br.id)] ?? 0;
      if (loading >= 100) {
        set.add(br.from_bus);
        set.add(br.to_bus);
      }
    });
    return set;
  }, [activeIsolatedBuses, branches, branchLoading]);

  // --- Throttled screen-space collision avoidance & visibility calculation ---
  const [visibleBusIds, setVisibleBusIds] = useState<Set<number>>(new Set());
  const lastUpdateRef = useRef(0);

  useFrame(() => {
    const now = performance.now();
    if (now - lastUpdateRef.current < 100) return; // 100 ms throttle
    lastUpdateRef.current = now;

    const width = size.width || window.innerWidth;
    const height = size.height || window.innerHeight;

    const candidates: Array<{
      id: number;
      priority: number;
      distToCenter: number;
      isDetailed: boolean;
      screenX: number;
      screenY: number;
    }> = [];

    const tempVec = new THREE.Vector3();

    for (const bus of buses) {
      const pos = busPos[bus.id];
      if (!pos) continue;

      const isHovered = hoveredBusIds.has(bus.id);
      const isOutaged = outagedEndBusIds.has(bus.id);
      const isHighRisk = highRiskBusIds.has(bus.id);
      const isImportant = importantBusIds.has(bus.id);

      let priority = -1;
      if (isOutaged) priority = 4;
      else if (isHovered) priority = 3;
      else if (isHighRisk) priority = 2;
      else if (isImportant) priority = 1;
      else if (labelMode === 'all') priority = 0;
      else if (labelMode === 'smart' && camDist < gridRadius * 2.6) priority = 0;

      if (labelMode === 'off' && priority < 3) continue;
      if (priority < 0) continue;

      tempVec.set(pos.x, busHeight(bus) + 0.15, pos.y);
      tempVec.project(camera);

      // Frustum & behind-camera clipping
      if (tempVec.z > 1.0 || tempVec.x < -1.1 || tempVec.x > 1.1 || tempVec.y < -1.1 || tempVec.y > 1.1) {
        continue;
      }

      const distToCenter = Math.sqrt(tempVec.x * tempVec.x + tempVec.y * tempVec.y);

      // Progressive zoom-based reveal in smart mode (near screen centre only)
      if (labelMode === 'smart' && priority === 0 && distToCenter > 0.72) {
        continue;
      }

      const screenX = ((tempVec.x + 1) / 2) * width;
      const screenY = ((-tempVec.y + 1) / 2) * height;

      candidates.push({
        id: bus.id,
        priority,
        distToCenter,
        isDetailed: isHovered || isOutaged,
        screenX,
        screenY,
      });
    }

    // Sort: highest priority first, then closest to center
    candidates.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.distToCenter - b.distToCenter;
    });

    const acceptedIds = new Set<number>();
    const boxes: Array<{ left: number; right: number; top: number; bottom: number }> = [];
    const maxCap = labelMode === 'all' ? 25 : 15;

    for (const c of candidates) {
      if (acceptedIds.size >= maxCap && c.priority < 3) {
        continue;
      }

      const w = c.isDetailed ? 140 : 64;
      const h = 22;
      const box = {
        left: c.screenX - w / 2 - 4,
        right: c.screenX + w / 2 + 4,
        top: c.screenY - h - 16,
        bottom: c.screenY - 2,
      };

      let collides = false;
      if (c.priority < 3) {
        for (const b of boxes) {
          if (
            !(
              box.right < b.left ||
              box.left > b.right ||
              box.bottom < b.top ||
              box.top > b.bottom
            )
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

    setVisibleBusIds(prev => {
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

  if (!buses.length) return null;

  return (
    <>
      <color attach="background" args={['#eef2f8']} />
      <ambientLight intensity={1.12} />
      <directionalLight position={[10, 16, 8]} intensity={0.95} castShadow />
      <directionalLight position={[-8, 10, -6]} intensity={0.35} />
      <fog attach="fog" args={['#eef2f8', gridRadius * 2.8, gridRadius * 9.5]} />

      <GroundPlane size={gridRadius * 2.5} />
      <CityCameraController
        gridRadius={gridRadius}
        cameraResetTrigger={cameraResetTrigger}
        framingCentroid={framingCentroid}
        reducedMotion={reducedMotion}
      />

      {/* Branches */}
      {branches.map(br => {
        const pa = busPos[br.from_bus];
        const pb = busPos[br.to_bus];
        if (!pa || !pb) return null;
        const isNewlyTripped = newlyTrippedBranchIds?.has(br.id) ?? false;
        const isPrevTripped = previouslyTrippedBranchIds?.has(br.id) ?? false;
        const isOverloaded = overloadedBranchIds?.has(br.id) ?? false;
        const isOut = outagedLines.includes(br.id) || isNewlyTripped || isPrevTripped;

        return (
          <CableBranch
            key={`br-${br.id}`}
            branch={br}
            posA={pa}
            posB={pb}
            loading={branchLoading[String(br.id)] ?? 35}
            isOutaged={isOut}
            isHovered={hoveredBranchId === br.id}
            detailLevel={detailLevel}
            isNewlyTripped={isNewlyTripped}
            isPreviouslyTripped={isPrevTripped}
            isOverloaded={isOverloaded}
            showMaintenanceOverlay={showMaintenanceOverlay}
            maintenancePriorityMap={maintenancePriorityMap}
            onClick={(isShift) => onClickBranch(br, isShift)}
            onPointerOver={e => onHoverBranch(br, e)}
            onPointerOut={() => onHoverBranch(null)}
          />
        );
      })}

      {/* Buses */}
      {buses.map(bus => {
        const pos = busPos[bus.id];
        if (!pos) return null;
        const isIsolated = activeIsolatedBuses.has(bus.id);
        const isGenOut   = outagedGens.includes(bus.id);
        const isHovered  = hoveredBusId === bus.id;
        const isOutagedEnd = outagedEndBusIds.has(bus.id);
        const isVisible  = visibleBusIds.has(bus.id);
        const isDetailed = isHovered || isOutagedEnd;
        const bldgOpacity = Math.max(0, Math.min(1, buildingsOpacity / 100));
        const structOpacity = applyToStructures ? bldgOpacity : 1.0;

        return (
          <React.Fragment key={`bus-${bus.id}`}>
            {bus.type === 'load' && (
              <BuildingCluster
                pos={pos} loadMw={bus.base_p_mw || 0} maxLoad={maxLoad}
                isIsolated={isIsolated} isHovered={isHovered}
                detailLevel={detailLevel}
                opacity={bldgOpacity}
                onClick={() => onClickBus(bus)}
                onPointerOver={e => onHoverBus(bus, e)}
                onPointerOut={() => onHoverBus(null)}
              />
            )}
            {bus.type === 'substation' && (
              <SubstationYard
                pos={pos} isHovered={isHovered} isOutaged={isGenOut} isIsolated={isIsolated}
                opacity={structOpacity}
                onClick={() => onClickBus(bus)}
                onPointerOver={e => onHoverBus(bus, e)}
                onPointerOut={() => onHoverBus(null)}
              />
            )}
            {bus.type === 'generator' && (
              <GeneratorPlant
                pos={pos} genMw={bus.gen_p_mw || 50}
                isHovered={isHovered} isOutaged={isGenOut} isIsolated={isIsolated}
                opacity={structOpacity}
                onClick={() => onClickBus(bus)}
                onPointerOver={e => onHoverBus(bus, e)}
                onPointerOut={() => onHoverBus(null)}
              />
            )}
            {bus.type === 'slack' && <SlackMarker pos={pos} />}
            <CityLabel
              bus={bus}
              pos={pos}
              height={busHeight(bus)}
              visible={isVisible}
              isDetailed={isDetailed}
              hasSingleVoltage={hasSingleVoltage}
              isHighPriority={isOutagedEnd || isGenOut}
            />
          </React.Fragment>
        );
      })}
    </>
  );
};

// ---- Legend ----------------------------------------------------------------
export const CityLegend: React.FC<{ hasSingleVoltage?: boolean; voltageKv?: number }> = ({
  hasSingleVoltage = false,
  voltageKv = 132,
}) => (
  <div className="absolute bottom-3 left-4 z-20 bg-white/95 backdrop-blur-md border border-[#cfd3d8] shadow-md p-3 text-[11px] text-ink space-y-1.5 select-none max-w-[250px]">
    <p className="eyebrow text-[10px] mb-1 text-charcoal">City View Legend</p>
    {[
      { e: '\u{1F3E2}', t: 'Building cluster \u2014 load area (taller = more demand)' },
      { e: '\u{1F4E6}', t: 'Fenced yard with transformers \u2014 substation' },
      { e: '\u{1F3ED}', t: 'Plant with chimney \u2014 generator' },
      { e: '\u26A1',    t: 'Lattice pylons + cable \u2014 transmission line' },
    ].map(({ e, t }) => (
      <div key={t} className="flex items-start gap-2">
        <span>{e}</span>
        <span className="text-[#555] leading-snug">{t}</span>
      </div>
    ))}

    {hasSingleVoltage && (
      <div className="border-t border-[#e5e7eb] pt-1 text-[10px] text-[#666] font-mono">
        Uniform grid voltage: {voltageKv} kV across all buses.
      </div>
    )}

    <div className="border-t border-[#e5e7eb] pt-1.5 space-y-1">
      {[
        { c: '#9aa3ad', t: 'Cable \u2014 normal' },
        { c: '#d98a1f', t: 'Cable \u2014 stressed (\u226565\u0025)' },
        { c: '#c8443b', t: 'Cable \u2014 overloaded (\u2265100\u0025)' },
        { c: '#e02424', t: 'Cable \u2014 outaged' },
      ].map(({ c, t }) => (
        <div key={t} className="flex items-center gap-2">
          <span style={{ display:'inline-block', width:22, height:3, background:c, borderRadius:2, flexShrink:0 }} />
          <span className="text-[#555]">{t}</span>
        </div>
      ))}
    </div>
    <p className="text-[9.5px] text-[#888] pt-1 border-t border-[#f0f0f0] leading-tight">
      Schematic city view. Positions are not geographic.
    </p>
  </div>
);

// ---- Public component ------------------------------------------------------
export interface CitySceneProps {
  buses: Bus[];
  branches: Branch[];
  layoutMap: Record<number, BusLayout>;
  outagedLines: number[];
  outagedGens: number[];
  branchLoading: Record<string, number>;
  activeIsolatedBuses: Set<number>;
  gridRadius: number;
  cameraResetTrigger: number;
  reducedMotion?: boolean;
  canvasWrapperRef?: React.RefObject<HTMLDivElement | null>;
  onClickBranch: (br: Branch, isShift?: boolean) => void;
  onHoverBranch: (br: Branch | null, e?: any) => void;
  onClickBus: (bus: Bus, isShift?: boolean) => void;
  onHoverBus: (bus: Bus | null, e?: any) => void;
  hoveredBranchId: number | null;
  hoveredBusId: number | null;
  newlyTrippedBranchIds?: Set<number>;
  previouslyTrippedBranchIds?: Set<number>;
  overloadedBranchIds?: Set<number>;
  framingCentroid?: [number, number, number] | null;
}

export const CityScene: React.FC<CitySceneProps> = ({
  buses, branches, layoutMap,
  outagedLines, outagedGens, branchLoading, activeIsolatedBuses,
  gridRadius, cameraResetTrigger,
  reducedMotion, canvasWrapperRef,
  onClickBranch, onHoverBranch, onClickBus, onHoverBus,
  hoveredBranchId, hoveredBusId,
  newlyTrippedBranchIds,
  previouslyTrippedBranchIds,
  overloadedBranchIds,
  framingCentroid,
}) => {
  const [detailLevel, setDetailLevel] = useState<'low' | 'high'>(() => (buses.length > 150 ? 'low' : 'high'));
  const {
    labelMode,
    setLabelMode,
    buildingsOpacity,
    setBuildingsOpacity,
    applyToStructures,
    setApplyToStructures,
    showMaintenanceOverlay,
    maintenanceData,
  } = useGridStore();
  const r = Math.max(4, gridRadius);

  // Compute maintenance priority map for City overlay
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

  return (
    <div ref={canvasWrapperRef} className="relative w-full h-full bg-[#eef2f8]">
      {/* Top-Right Controls: Opacity Slider, Labels Mode & Detail */}
      <div className="absolute top-3 right-3 z-30 flex items-center gap-2 select-none">
        {/* Buildings Opacity Slider & Structures Option */}
        <div className="flex items-center gap-2 bg-white/95 backdrop-blur-md border border-[#cfd3d8] shadow-2xs px-2.5 py-1 text-xs">
          <span className="text-[10px] uppercase font-mono tracking-wider text-[#666]">Opacity</span>
          <input
            type="range"
            min="0"
            max="100"
            value={buildingsOpacity}
            onChange={(e) => setBuildingsOpacity(Number(e.target.value))}
            className="w-20 h-1.5 accent-charcoal cursor-pointer"
            title={`Buildings opacity: ${buildingsOpacity}%`}
          />
          <span className="text-[10px] font-mono text-charcoal w-7 text-right">{buildingsOpacity}%</span>
          <label className="flex items-center gap-1 pl-1.5 border-l border-[#cfd3d8] cursor-pointer text-[10px] text-[#555] hover:text-ink">
            <input
              type="checkbox"
              checked={applyToStructures}
              onChange={(e) => setApplyToStructures(e.target.checked)}
              className="accent-charcoal cursor-pointer rounded-xs"
            />
            <span>Structures</span>
          </label>
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

        {/* Detail: Low | High */}
        <div className="flex items-center bg-white/95 backdrop-blur-md border border-[#cfd3d8] shadow-2xs p-0.5 text-xs">
          <span className="px-2 py-0.5 text-[10px] uppercase font-mono tracking-wider text-[#666]">Detail</span>
          <button
            onClick={() => setDetailLevel('low')}
            className={`px-2 py-0.5 text-[11px] font-medium transition-all ${
              detailLevel === 'low' ? 'bg-charcoal text-white shadow-2xs' : 'text-[#555] hover:text-ink'
            }`}
          >
            Low
          </button>
          <button
            onClick={() => setDetailLevel('high')}
            className={`px-2 py-0.5 text-[11px] font-medium transition-all ${
              detailLevel === 'high' ? 'bg-charcoal text-white shadow-2xs' : 'text-[#555] hover:text-ink'
            }`}
          >
            High
          </button>
        </div>
      </div>

      <Canvas
        camera={{ position: [r * 1.75, r * 1.6, r * 1.75], fov: 44 }}
        gl={{ antialias: true, alpha: false }}
        style={{ background: '#eef2f8' }}
        onWheel={(e) => e.stopPropagation()}
        shadows
      >
        <CitySceneInner
          buses={buses} branches={branches} layoutMap={layoutMap}
          outagedLines={outagedLines} outagedGens={outagedGens}
          branchLoading={branchLoading} activeIsolatedBuses={activeIsolatedBuses}
          gridRadius={gridRadius} cameraResetTrigger={cameraResetTrigger}
          hoveredBranchId={hoveredBranchId} hoveredBusId={hoveredBusId}
          detailLevel={detailLevel}
          labelMode={labelMode}
          buildingsOpacity={buildingsOpacity}
          applyToStructures={applyToStructures}
          newlyTrippedBranchIds={newlyTrippedBranchIds}
          previouslyTrippedBranchIds={previouslyTrippedBranchIds}
          overloadedBranchIds={overloadedBranchIds}
          showMaintenanceOverlay={showMaintenanceOverlay}
          maintenancePriorityMap={maintenancePriorityMap}
          framingCentroid={framingCentroid}
          reducedMotion={reducedMotion}
          onClickBranch={onClickBranch} onHoverBranch={onHoverBranch}
          onClickBus={onClickBus} onHoverBus={onHoverBus}
        />
      </Canvas>
    </div>
  );
};