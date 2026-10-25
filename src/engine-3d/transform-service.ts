/**
 * Module Builder V1.1 — Transform Service
 *
 * Authoritative executor of object transforms. All transform requests
 * (Inspector input, CV intents) converge here as TransformCommands.
 * Applies transforms to Three.js Object3D instances.
 *
 * Source of truth: Doc 04 §8, Doc 05 §5, D-004
 */

import * as THREE from 'three';
import type {
  TransformCommand,
  TransformChangedEvent,
  TransformSnapshot,
  ObjectId,
  TimestampMs,
} from '../core/contracts';
import { EventBus } from '../core/event-bus';
import { SceneManager } from './scene-manager';

// ─── Transform Service ───────────────────────────────────

export class TransformService {
  private eventBus: EventBus;
  private sceneManager: SceneManager;

  constructor(eventBus: EventBus, sceneManager: SceneManager) {
    this.eventBus = eventBus;
    this.sceneManager = sceneManager;
  }

  /**
   * Apply a TransformCommand to the target object.
   * This is the single execution path for all object transforms.
   */
  apply(cmd: TransformCommand): boolean {
    const object = this.sceneManager.getObject(cmd.objectId);
    if (!object) return false;

    // Apply the transform
    let success = false;
    switch (cmd.property) {
      case 'POSITION':
        success = this.applyPosition(object, cmd);
        break;
      case 'ROTATION':
        success = this.applyRotation(object, cmd);
        break;
      case 'SCALE':
        success = this.applyScale(object, cmd);
        break;
    }

    if (!success) return false;

    // Capture after state
    const after = this.sceneManager.getTransform(object);

    // Emit transform changed event
    const event: TransformChangedEvent = {
      objectId: cmd.objectId,
      transform: after,
      source: cmd.source,
      timestamp: Date.now() as TimestampMs,
    };
    this.eventBus.emit('transform:changed', event);

    return true;
  }

  /**
   * Set the exact transform snapshot on an object (for undo/redo restore).
   */
  setTransform(objectId: ObjectId, snapshot: TransformSnapshot): boolean {
    const object = this.sceneManager.getObject(objectId);
    if (!object) return false;

    object.position.set(snapshot.position.x, snapshot.position.y, snapshot.position.z);
    object.rotation.set(
      snapshot.rotationRadians.x,
      snapshot.rotationRadians.y,
      snapshot.rotationRadians.z,
    );
    object.scale.set(snapshot.scale.x, snapshot.scale.y, snapshot.scale.z);

    // Emit event
    const event: TransformChangedEvent = {
      objectId,
      transform: snapshot,
      source: 'OTHER_UI',
      timestamp: Date.now() as TimestampMs,
    };
    this.eventBus.emit('transform:changed', event);

    return true;
  }

  /**
   * Get the current transform of an object.
   */
  getTransform(objectId: ObjectId): TransformSnapshot | null {
    const object = this.sceneManager.getObject(objectId);
    if (!object) return null;
    return this.sceneManager.getTransform(object);
  }

  // ─── Private: Property-specific transforms ─────────────

  private applyPosition(object: THREE.Object3D, cmd: TransformCommand): boolean {
    if (cmd.operation === 'SET') {
      object.position.set(cmd.values.x, cmd.values.y, cmd.values.z);
    } else if (cmd.operation === 'DELTA') {
      object.position.x += cmd.values.x;
      object.position.y += cmd.values.y;
      object.position.z += cmd.values.z;
    }
    return true;
  }

  private applyRotation(object: THREE.Object3D, cmd: TransformCommand): boolean {
    if (cmd.operation === 'SET') {
      object.rotation.set(cmd.values.x, cmd.values.y, cmd.values.z);
    } else if (cmd.operation === 'DELTA') {
      object.rotation.x += cmd.values.x;
      object.rotation.y += cmd.values.y;
      object.rotation.z += cmd.values.z;
    }
    return true;
  }

  private applyScale(object: THREE.Object3D, cmd: TransformCommand): boolean {
    if (cmd.operation === 'SET') {
      object.scale.set(cmd.values.x, cmd.values.y, cmd.values.z);
    } else if (cmd.operation === 'DELTA') {
      object.scale.x += cmd.values.x;
      object.scale.y += cmd.values.y;
      object.scale.z += cmd.values.z;
    } else if (cmd.operation === 'SCALE_FACTOR') {
      // Multiplicative scale (CV sessions). Refuse factors that would
      // collapse or invert the geometry — keeps the scene matrix valid.
      const nextX = object.scale.x * cmd.values.x;
      const nextY = object.scale.y * cmd.values.y;
      const nextZ = object.scale.z * cmd.values.z;
      if (!Number.isFinite(nextX) || !Number.isFinite(nextY) || !Number.isFinite(nextZ)) return false;
      if (Math.abs(nextX) < 1e-4 || Math.abs(nextY) < 1e-4 || Math.abs(nextZ) < 1e-4) return false;
      object.scale.set(nextX, nextY, nextZ);
    }
    return true;
  }
}
