/**
 * Module Builder V1.1 — Scene Manager
 *
 * Owns: Scene graph, Object3D instances, hierarchy, duplication/removal.
 * Instantiates and owns scene instances.
 *
 * Source of truth: Doc 04 §4, Doc 04 §14
 */

import * as THREE from 'three';
import type { ObjectId, SceneObjectRecord, TransformSnapshot } from '../core/contracts';

// ─── Object Registry Entry ────────────────────────────────

interface ObjectEntry {
  id: ObjectId;
  object: THREE.Object3D;
  assetName: string;
}

// ─── Scene Manager ───────────────────────────────────────

export class SceneManager {
  private scene: THREE.Scene;
  private registry = new Map<ObjectId, ObjectEntry>();
  private nextId = 1;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  /**
   * Add a Three.js object to the managed scene.
   * Returns the assigned ObjectId.
   *
   * `restoreId` re-registers a removed object under its ORIGINAL id (undo of
   * a delete), so a later redo still finds the object the history record
   * names. An id that is already in use is ignored — a fresh one is assigned.
   */
  addObject(object: THREE.Object3D, name?: string, restoreId?: ObjectId): ObjectId {
    const restored = restoreId !== undefined && !this.registry.has(restoreId);
    const id = restored ? restoreId : `obj-${this.nextId++}`;
    object.name = name || id;

    // Enable shadows on the object and its children
    object.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });

    this.scene.add(object);
    this.registry.set(id, { id, object, assetName: object.name });

    return id;
  }

  /**
   * Remove an object from the scene WITHOUT disposing its resources.
   * Used by Delete so Undo can put the very same instance (geometry,
   * textures, materials) back. The caller owns the returned object and must
   * dispose it when the history entry behind it is gone.
   * Returns the detached object, or null if the id was not registered.
   */
  detachObject(objectId: ObjectId): THREE.Object3D | null {
    const entry = this.registry.get(objectId);
    if (!entry) return null;

    this.scene.remove(entry.object);
    this.registry.delete(objectId);
    return entry.object;
  }

  /**
   * Remove an object from the scene.
   */
  removeObject(objectId: ObjectId): boolean {
    const entry = this.registry.get(objectId);
    if (!entry) return false;

    this.scene.remove(entry.object);
    this.registry.delete(objectId);

    // Dispose geometry and materials to free GPU memory
    entry.object.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.geometry?.dispose();
        if (Array.isArray(child.material)) {
          child.material.forEach((m) => m.dispose());
        } else {
          child.material?.dispose();
        }
      }
    });

    return true;
  }

  /**
   * Duplicate an object — creates a clone with offset.
   */
  duplicateObject(objectId: ObjectId): ObjectId | null {
    const entry = this.registry.get(objectId);
    if (!entry) return null;

    const clone = entry.object.clone(true);
    // Offset slightly so the duplicate is visible
    clone.position.x += 1;
    clone.position.z += 1;

    return this.addObject(clone, `${entry.assetName} (copy)`);
  }

  /**
   * Get the Three.js Object3D by ObjectId.
   */
  getObject(objectId: ObjectId): THREE.Object3D | null {
    return this.registry.get(objectId)?.object ?? null;
  }

  /**
   * Get all registered objects as display data.
   */
  getAllObjects(): SceneObjectRecord[] {
    const records: SceneObjectRecord[] = [];
    for (const entry of this.registry.values()) {
      records.push({
        objectId: entry.id,
        assetId: entry.id, // Simplified — real implementation uses asset registry
        name: entry.assetName,
        visible: entry.object.visible,
        transform: this.getTransform(entry.object),
      });
    }
    return records;
  }

  /**
   * Get the transform snapshot of an Object3D.
   */
  getTransform(object: THREE.Object3D): TransformSnapshot {
    return {
      position: {
        x: object.position.x,
        y: object.position.y,
        z: object.position.z,
      },
      rotationRadians: {
        x: object.rotation.x,
        y: object.rotation.y,
        z: object.rotation.z,
      },
      scale: {
        x: object.scale.x,
        y: object.scale.y,
        z: object.scale.z,
      },
    };
  }

  /**
   * Check if an ObjectId exists.
   */
  hasObject(objectId: ObjectId): boolean {
    return this.registry.has(objectId);
  }

  /**
   * Get the count of managed objects.
   */
  get objectCount(): number {
    return this.registry.size;
  }

  /**
   * Clear all objects — for testing and scene reset.
   */
  clear(): void {
    for (const entry of this.registry.values()) {
      this.scene.remove(entry.object);
    }
    this.registry.clear();
  }
}
