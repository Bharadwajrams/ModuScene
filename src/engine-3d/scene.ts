/**
 * Module Builder V1.1 — 3D Scene Core
 *
 * Owns: Three.js renderer, camera, controls, render loop.
 * This is the foundation of the 3D Engine.
 *
 * Source of truth: Doc 04 §4, Doc 04 §5
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// ─── Scene Core ──────────────────────────────────────────

export class SceneCore {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly controls: OrbitControls;
  private animationFrameId: number | null = null;
  private resizeObserver: ResizeObserver | null = null;

  constructor(canvas: HTMLCanvasElement) {
    // Scene — blue-tinted workspace so the 3D viewport reads as a distinct
    // blue working area against the light editor UI (visual-theme pass;
    // color constant only, no behavior).
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xc9d9ec);

    // Camera
    this.camera = new THREE.PerspectiveCamera(
      60, // FOV
      1,  // aspect — will be updated on resize
      0.1,
      1000,
    );
    this.camera.position.set(5, 5, 10);
    this.camera.lookAt(0, 0, 0);

    // Renderer
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;

    // Controls (Orbit)
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.screenSpacePanning = true;
    this.controls.minDistance = 1;
    this.controls.maxDistance = 200;
    this.controls.maxPolarAngle = Math.PI * 0.9;

    // Lighting
    this.setupLighting();

    // Ground
    this.setupGround();

    // Resize handling
    this.setupResize(canvas);

    // Initial size
    this.handleResize();
  }

  private setupLighting(): void {
    // Ambient light for base illumination (light theme: neutral, brighter)
    const ambient = new THREE.AmbientLight(0xffffff, 0.55);
    this.scene.add(ambient);

    // Main directional light
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
    dirLight.position.set(10, 15, 10);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.width = 2048;
    dirLight.shadow.mapSize.height = 2048;
    dirLight.shadow.camera.near = 0.5;
    dirLight.shadow.camera.far = 50;
    dirLight.shadow.camera.left = -20;
    dirLight.shadow.camera.right = 20;
    dirLight.shadow.camera.top = 20;
    dirLight.shadow.camera.bottom = -20;
    this.scene.add(dirLight);

    // Fill light from opposite side
    const fillLight = new THREE.DirectionalLight(0x8888ff, 0.3);
    fillLight.position.set(-5, 3, -5);
    this.scene.add(fillLight);
  }

  private setupGround(): void {
    const groundGeometry = new THREE.PlaneGeometry(100, 100);
    const groundMaterial = new THREE.MeshStandardMaterial({
      color: 0xd4e0ef,
      roughness: 0.9,
      metalness: 0.0,
    });
    const ground = new THREE.Mesh(groundGeometry, groundMaterial);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = 0;
    ground.receiveShadow = true;
    ground.name = '__ground__'; // Internal marker — not selectable
    this.scene.add(ground);

    // Grid helper for visual reference
    // Blue-gray grid lines, slightly darker than the ground/background.
    const grid = new THREE.GridHelper(100, 100, 0x9fb5d4, 0xb6c7e0);
    grid.position.y = 0.01; // Slightly above ground to prevent z-fighting
    this.scene.add(grid);
  }

  private setupResize(canvas: HTMLCanvasElement): void {
    this.resizeObserver = new ResizeObserver(() => {
      this.handleResize();
    });
    this.resizeObserver.observe(canvas.parentElement || canvas);
  }

  private handleResize(): void {
    const parent = this.renderer.domElement.parentElement;
    if (!parent) return;

    const width = parent.clientWidth;
    const height = parent.clientHeight;

    // Skip if no meaningful size to avoid glitches during panel transitions,
    // but don't bail entirely — just don't update if size is zero.
    if (width === 0 || height === 0) {
      return;
    }

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  /** Start the render loop */
  start(): void {
    if (this.animationFrameId !== null) return;

    const animate = (): void => {
      this.animationFrameId = requestAnimationFrame(animate);
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    };

    animate();
  }

  /** Stop the render loop */
  stop(): void {
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  /** Force a resize update — call after layout changes */
  updateSize(): void {
    this.handleResize();
  }

  /** Dispose all resources */
  dispose(): void {
    this.stop();
    this.resizeObserver?.disconnect();
    this.controls.dispose();
    this.renderer.dispose();
  }
}
