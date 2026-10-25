/**
 * Module Builder V1.1 — GLB Exporter
 *
 * Exports the assembled scene as GLB with textures preserved.
 * Uses GLTFExporter from Three.js addons.
 *
 * Source of truth: Doc 01 §15, Doc 04 §14
 */

import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

// ─── Exporter ────────────────────────────────────────────

export class SceneExporter {
  private exporter: GLTFExporter;

  constructor() {
    this.exporter = new GLTFExporter();
  }

  /**
   * Export the scene (or selected objects) as GLB.
   * Triggers a file download in the browser.
   */
  async exportGLB(
    scene: THREE.Scene,
    filename: string = 'module-builder-export.glb',
  ): Promise<boolean> {
    try {
      // Filter out internal objects (ground, grid, highlights)
      const exportScene = this.prepareExportScene(scene);

      const result = await new Promise<ArrayBuffer>((resolve, reject) => {
        this.exporter.parse(
          exportScene,
          (gltf) => resolve(gltf as ArrayBuffer),
          (error) => reject(error),
          { binary: true },
        );
      });

      // Create download
      const blob = new Blob([result], { type: 'model/gltf-binary' });
      const url = URL.createObjectURL(blob);

      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      URL.revokeObjectURL(url);

      console.log(`[Exporter] Exported: ${filename}`);
      return true;
    } catch (error) {
      console.error('[Exporter] Export failed:', error);
      return false;
    }
  }

  /**
   * Prepare a clean scene for export — remove internal objects,
   * preserve world transforms, and include basic lighting.
   */
  private prepareExportScene(scene: THREE.Scene): THREE.Scene {
    const exportScene = new THREE.Scene();

    // Add basic lighting so exported GLB renders correctly in viewers
    const ambient = new THREE.AmbientLight(0xffffff, 0.6);
    exportScene.add(ambient);

    const dirLight = new THREE.DirectionalLight(0xffffff, 1.0);
    dirLight.position.set(5, 10, 5);
    exportScene.add(dirLight);

    scene.children.forEach((child) => {
      // Skip ground, grid, and internal markers
      if (
        child.name === '__ground__' ||
        child.name.startsWith('__highlight_') ||
        child instanceof THREE.GridHelper
      ) {
        return;
      }

      // Skip original scene lights (we add our own)
      if (child instanceof THREE.AmbientLight || child instanceof THREE.DirectionalLight) {
        return;
      }

      // Clone to avoid modifying the original
      const clone = child.clone(true);

      // Ensure world matrix is computed before cloning
      // so nested hierarchies preserve correct world transforms
      child.updateWorldMatrix(true, false);
      clone.applyMatrix4(child.matrixWorld);

      exportScene.add(clone);
    });

    return exportScene;
  }
}
