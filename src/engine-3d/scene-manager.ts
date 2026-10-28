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

// ─── Duplicate Result ────────────────────────────────────

/** One duplicated copy and the module it was cloned from. */
export interface DuplicatePair {
  sourceId: ObjectId;
  cloneId: ObjectId;
}

// ─── Duplicate Naming ────────────────────────────────────

/** A trailing duplicate number: "Cube (3)" → base "Cube", number "3". */
const DUPLICATE_SUFFIX = /^(.+?) \((\d+)\)$/;

/**
 * Base name used for duplicate numbering.
 *
 * A trailing " (N)" is dropped only when the name really belongs to a
 * duplicate family — its bare base, or a sibling "base (k)", is present in
 * `existingNames`. So "Cube (1)" resolves to "Cube", while a module genuinely
 * called "House (2)" (no "House" in the scene) keeps its whole name: meaningful
 * parentheses and numbers are never stripped.
 */
export function duplicateBaseName(name: string, existingNames: Iterable<string>): string {
  const match = DUPLICATE_SUFFIX.exec(name);
  if (!match) return name;

  const base = match[1];
  for (const existing of existingNames) {
    // The name itself proves nothing — look for a DIFFERENT module in the family
    if (existing === name) continue;
    const family = DUPLICATE_SUFFIX.exec(existing)?.[1] ?? existing;
    if (family === base) return base;
  }
  return name;
}

/**
 * Next numbered duplicate name for `name`: "Cube" → "Cube (1)", "Cube (1)" →
 * "Cube (2)", lowest free number first ("Cube", "Cube (1)", "Cube (3)" →
 * "Cube (2)"). Numbers already used by any module in `existingNames` are
 * skipped, so two scene instances can never end up with the same name.
 */
export function nextDuplicateName(name: string, existingNames: Iterable<string>): string {
  const names = [...existingNames];
  const base = duplicateBaseName(name, names);
  const used = new Set(names);

  let index = 1;
  while (used.has(`${base} (${index})`)) index += 1;
  return `${base} (${index})`;
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
   *
   * The copy is named `"<base> (n)"` — "Cube" → "Cube (1)", "Cube (1)" →
   * "Cube (2)" — using the lowest number not already taken in the scene (see
   * `nextDuplicateName`). The original keeps its name, and duplicating a
   * duplicate never nests another suffix.
   */
  duplicateObject(objectId: ObjectId): ObjectId | null {
    const entry = this.registry.get(objectId);
    if (!entry) return null;

    const clone = entry.object.clone(true);
    // Offset slightly so the duplicate is visible
    clone.position.x += 1;
    clone.position.z += 1;

    return this.addObject(clone, nextDuplicateName(entry.assetName, this.objectNames()));
  }

  /** Display names of every module currently in the scene (duplicate naming). */
  objectNames(): string[] {
    return [...this.registry.values()].map((entry) => entry.assetName);
  }

  /**
   * Duplicate several objects as one collection.
   *
   * Every copy goes through `duplicateObject`, so the offset is IDENTICAL for
   * the whole collection — the copies keep the originals' relative
   * arrangement instead of being scattered. Each copy is an independent
   * `clone(true)` registered under a fresh unique id, and the originals are
   * never modified. Unknown ids are skipped; the returned pairs pair every
   * copy with the module it came from (for history metadata).
   */
  duplicateObjects(objectIds: ObjectId[]): DuplicatePair[] {
    const pairs: DuplicatePair[] = [];
    for (const sourceId of objectIds) {
      const cloneId = this.duplicateObject(sourceId);
      if (cloneId) pairs.push({ sourceId, cloneId });
    }
    return pairs;
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
