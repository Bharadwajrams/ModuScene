/**
 * Module Builder V1.1 — Display Adapter
 *
 * Converts 3D Engine state into presentation-safe data for UI consumption.
 * UI never reads raw Object3D — it receives ObjectDisplayData and
 * InspectorViewModel through this adapter.
 *
 * Source of truth: Doc 05 §15, Doc 04 §4
 */

import * as THREE from 'three';
import type {
  ObjectId,
  ObjectDisplayData,
  InspectorViewModel,
  InspectorSection,
  ModuleListItem,
  Vector3Value,
} from '../core/contracts';
import { SceneManager } from './scene-manager';

// ─── Helper: radians to degrees ──────────────────────────

function toDegrees(rad: Vector3Value): Vector3Value {
  return {
    x: (rad.x * 180) / Math.PI,
    y: (rad.y * 180) / Math.PI,
    z: (rad.z * 180) / Math.PI,
  };
}

// ─── Display Adapter ─────────────────────────────────────

export class DisplayAdapter {
  private sceneManager: SceneManager;

  constructor(sceneManager: SceneManager) {
    this.sceneManager = sceneManager;
  }

  /**
   * Convert an Object3D to UI-safe display data.
   */
  getObjectDisplayData(objectId: ObjectId): ObjectDisplayData | null {
    const object = this.sceneManager.getObject(objectId);
    if (!object) return null;

    const transform = this.sceneManager.getTransform(object);
    return {
      objectId,
      name: object.name || objectId,
      transform,
      visible: object.visible,
    };
  }

  /**
   * Convert the current selection to an Inspector view model.
   */
  getInspectorViewModel(objectId: ObjectId | null): InspectorViewModel {
    if (!objectId) {
      return {
        objectId: null,
        name: null,
        move: null,
        scale: null,
        rotationDegrees: null,
        additionalSections: [],
      };
    }

    const object = this.sceneManager.getObject(objectId);
    if (!object) {
      return {
        objectId: null,
        name: null,
        move: null,
        scale: null,
        rotationDegrees: null,
        additionalSections: [],
      };
    }

    const transform = this.sceneManager.getTransform(object);
    const additionalSections: InspectorSection[] = [
      { label: 'Position', content: `X: ${transform.position.x.toFixed(3)}, Y: ${transform.position.y.toFixed(3)}, Z: ${transform.position.z.toFixed(3)}` },
    ];

    try {
      const wp = object.getWorldPosition(new THREE.Vector3());
      additionalSections.push({ label: 'World Position', content: `X: ${wp.x.toFixed(3)}, Y: ${wp.y.toFixed(3)}, Z: ${wp.z.toFixed(3)}` });
    } catch (_e) {
      // World position not yet computed (object not rendered)
    }

    return {
      objectId,
      name: object.name || objectId,
      move: transform.position,
      scale: transform.scale,
      rotationDegrees: toDegrees(transform.rotationRadians),
      additionalSections,
    };
  }

  /**
   * Get all scene objects as module list items for Module Selection UI.
   */
  getModuleListItems(selectedId: ObjectId | null): ModuleListItem[] {
    const records = this.sceneManager.getAllObjects();
    return records
      .filter((r) => r.visible) // Only show visible objects
      .map((r) => ({
        objectId: r.objectId,
        displayName: r.name,
        isSelected: r.objectId === selectedId,
        visible: r.visible,
        enabled: true,
      }));
  }
}
