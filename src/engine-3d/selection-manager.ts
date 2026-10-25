/**
 * Module Builder V1.1 — Selection Manager
 *
 * Authoritative owner of the currently selected scene object.
 * Selection commands from any source (viewport click, Module Selection UI)
 * converge here. Other systems consume read-only state via events.
 *
 * Single authority — no parallel selection state allowed.
 * Source of truth: Doc 04 §9, D-003
 */

import * as THREE from 'three';
import type { ObjectId, SelectionState, SelectionChangedEvent, TimestampMs } from '../core/contracts';
import { EventBus } from '../core/event-bus';

// ─── Selection Highlight ──────────────────────────────────

const HIGHLIGHT_COLOR = 0x1d4ed8;

// ─── Selection Manager ───────────────────────────────────

export class SelectionManager {
  private eventBus: EventBus;
  private currentSelection: ObjectId | null = null;
  private scene: THREE.Scene;
  private outlineObjects = new Map<ObjectId, THREE.Object3D>();
  private getObject: (id: ObjectId) => THREE.Object3D | null;
  private getName: (id: ObjectId) => string;

  constructor(
    eventBus: EventBus,
    scene: THREE.Scene,
    getObject: (id: ObjectId) => THREE.Object3D | null,
    getName: (id: ObjectId) => string,
  ) {
    this.eventBus = eventBus;
    this.scene = scene;
    this.getObject = getObject;
    this.getName = getName;
  }

  /**
   * Request a selection change. This is the authoritative path.
   * Any source (viewport click, Module Selection UI) goes through here.
   */
  select(objectId: ObjectId | null): void {
    if (objectId === this.currentSelection) return;

    const previousObjectId = this.currentSelection;

    // Remove highlight from old selection
    if (previousObjectId) {
      this.removeHighlight(previousObjectId);
    }

    // Update selection
    this.currentSelection = objectId;

    // Add highlight to new selection
    if (objectId) {
      this.addHighlight(objectId);
    }

    // Emit selection changed event
    const event: SelectionChangedEvent = {
      objectId,
      displayName: objectId ? this.getName(objectId) : null,
      previousObjectId,
      timestamp: Date.now() as TimestampMs,
    };
    this.eventBus.emit('selection:changed', event);
  }

  /**
   * Get the current selection state (read-only snapshot).
   */
  getState(): SelectionState {
    return {
      objectId: this.currentSelection,
      displayName: this.currentSelection ? this.getName(this.currentSelection) : null,
      isSelected: this.currentSelection !== null,
    };
  }

  /**
   * Get the currently selected ObjectId (or null).
   */
  get selectedId(): ObjectId | null {
    return this.currentSelection;
  }

  /**
   * Check if a given ObjectId is currently selected.
   */
  isSelected(objectId: ObjectId): boolean {
    return this.currentSelection === objectId;
  }

  /**
   * Clear selection without emitting an event (for internal use).
   */
  clear(): void {
    if (this.currentSelection) {
      this.removeHighlight(this.currentSelection);
    }
    this.currentSelection = null;
  }

  // ─── Visual Highlight ─────────────────────────────────

  private addHighlight(objectId: ObjectId): void {
    const obj = this.getObject(objectId);
    if (!obj) return;

    // Create a wireframe highlight around the object
    const box = new THREE.Box3().setFromObject(obj);
    const size = new THREE.Vector3();
    box.getSize(size);

    const edgesGeometry = new THREE.EdgesGeometry(
      new THREE.BoxGeometry(size.x + 0.05, size.y + 0.05, size.z + 0.05),
    );
    const edgesMaterial = new THREE.LineBasicMaterial({
      color: HIGHLIGHT_COLOR,
      linewidth: 2,
    });
    const edges = new THREE.LineSegments(edgesGeometry, edgesMaterial);

    // Center the highlight on the object
    const center = new THREE.Vector3();
    box.getCenter(center);
    edges.position.copy(center);
    edges.name = `__highlight_${objectId}__`;

    this.scene.add(edges);
    this.outlineObjects.set(objectId, edges);
  }

  private removeHighlight(objectId: ObjectId): void {
    const highlight = this.outlineObjects.get(objectId);
    if (highlight) {
      this.scene.remove(highlight);
      highlight.traverse((child) => {
        if (child instanceof THREE.LineSegments) {
          child.geometry.dispose();
          if (child.material instanceof THREE.Material) {
            child.material.dispose();
          }
        }
      });
      this.outlineObjects.delete(objectId);
    }
  }

  /**
   * Dispose all highlights — for cleanup.
   */
  dispose(): void {
    for (const objectId of this.outlineObjects.keys()) {
      this.removeHighlight(objectId);
    }
  }
}
