import type * as THREE from 'three';

export type LoadingVariant = 'auto' | 'css' | 'three';
export type LoadingSize = 'sm' | 'md' | 'lg' | 'fullscreen';
export type ThreeAnimationType = 'lattice' | 'crystals' | 'fractals';

export interface LoadingIndicatorProps {
  loading: boolean;
  variant?: LoadingVariant;
  size?: LoadingSize;
  message?: string;
  progress?: number;
  showProgress?: boolean;
  animationType?: ThreeAnimationType | 'random';
}

export interface LatticeNode {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  connections: number[];
  energy: number;
}

export interface Crystal {
  mesh: THREE.Mesh;
  rotationAxis: THREE.Vector3;
  rotationSpeed: number;
  floatOffset: number;
  originalY: number;
}

export interface FractalBranch {
  mesh: THREE.Mesh;
  depth: number;
  angle: number;
  scale: number;
}
