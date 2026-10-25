/**
 * Delete → Undo → Redo — identity + fidelity tests
 *
 * Guards two defects:
 *  1. undo restored the module under a fresh id, so redo silently did nothing;
 *  2. undo rebuilt a grey placeholder box, losing geometry, materials and
 *     textures (the mesh was disposed on delete).
 *
 * The DELETE branches mirror main.ts (the app itself needs WebGL and cannot be
 * instantiated here), wired to the real SceneManager / TransformService /
 * HistoryManager: delete DETACHES the instance without disposing, undo
 * re-attaches that same instance under its original id, redo detaches again.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as THREE from 'three';
import { EventBus } from '../../src/core/event-bus';
import { HistoryManager } from '../../src/core/history-manager';
import { SceneManager } from '../../src/engine-3d/scene-manager';
import { TransformService } from '../../src/engine-3d/transform-service';
import type { HistoryRecord, ObjectId, TransformSnapshot } from '../../src/core/contracts';

// ─── Harness ─────────────────────────────────────────────

interface DeletedMeta {
  name: string;
  object: THREE.Object3D;
  snapshot: TransformSnapshot;
}

function setup() {
  const eventBus = new EventBus();
  const scene = new THREE.Scene();
  const sceneManager = new SceneManager(scene);
  const transformService = new TransformService(eventBus, sceneManager);
  const deletedMeta = new Map<ObjectId, DeletedMeta>();

  const history = new HistoryManager(
    eventBus,
    (record) => {
      // Redo DELETE — detach, never dispose (main.ts applyHistoryRecord)
      if (record.actionType === 'DELETE') {
        sceneManager.detachObject(record.targetObjectId);
      } else if (record.after) {
        transformService.setTransform(record.targetObjectId, record.after);
      }
    },
    (record) => {
      // Undo DELETE — re-attach the ORIGINAL instance (main.ts revertHistoryRecord)
      if (record.actionType === 'DELETE') {
        const meta = deletedMeta.get(record.targetObjectId);
        if (!meta || !record.before) return;
        const restoredId = sceneManager.addObject(meta.object, meta.name, record.targetObjectId);
        transformService.setTransform(restoredId, record.before);
      } else if (record.before) {
        transformService.setTransform(record.targetObjectId, record.before);
      }
    },
  );

  const deleteObject = (objectId: ObjectId): void => {
    const before = transformService.getTransform(objectId);
    const detached = sceneManager.detachObject(objectId);
    if (before && detached) {
      deletedMeta.set(objectId, { name: detached.name, object: detached, snapshot: before });
    }

    history.recordAction({
      commandId: history.generateCommandId(),
      actionType: 'DELETE',
      targetObjectId: objectId,
      source: 'UI',
      before,
      timestamp: history.now(),
    });
  };

  const addModule = (name = 'cube'): ObjectId =>
    sceneManager.addObject(
      new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial()),
      name,
    );

  return { scene, sceneManager, transformService, history, deleteObject, addModule, deletedMeta };
}

let h: ReturnType<typeof setup>;

beforeEach(() => {
  h = setup();
});

// ─── Delete / undo / redo ────────────────────────────────

describe('Delete → Undo → Redo', () => {
  it('undo restores the module under its original id', () => {
    const id = h.addModule('door');
    h.deleteObject(id);
    expect(h.sceneManager.objectCount).toBe(0);

    h.history.undo();

    expect(h.sceneManager.objectCount).toBe(1);
    expect(h.sceneManager.getObject(id)).not.toBeNull();
    expect(h.sceneManager.hasObject(id)).toBe(true);
  });

  it('redo after undo removes the restored module (regression)', () => {
    const id = h.addModule('door');
    h.deleteObject(id);
    h.history.undo();
    expect(h.sceneManager.objectCount).toBe(1);

    h.history.redo();

    expect(h.sceneManager.objectCount).toBe(0);
    expect(h.sceneManager.getObject(id)).toBeNull();
  });

  it('undo/redo can be repeated without leaking objects', () => {
    const id = h.addModule('gate');
    h.deleteObject(id);

    for (let i = 0; i < 3; i++) {
      h.history.undo();
      expect(h.sceneManager.objectCount).toBe(1);
      expect(h.sceneManager.getObject(id)).not.toBeNull();

      h.history.redo();
      expect(h.sceneManager.objectCount).toBe(0);
    }
  });

  it('restores the deleted transform, not just the id', () => {
    const id = h.addModule('door');
    h.sceneManager.getObject(id)!.position.set(3, 1, -2);
    h.deleteObject(id);

    h.history.undo();

    const restored = h.sceneManager.getObject(id)!;
    expect([restored.position.x, restored.position.y, restored.position.z]).toEqual([3, 1, -2]);
  });
});

// ─── Appearance fidelity ─────────────────────────────────

describe('Delete → Undo fidelity', () => {
  /** An "imported module": several meshes, distinct materials, one textured. */
  const makeImportedModule = (): THREE.Group => {
    const group = new THREE.Group();
    group.name = 'village_house';

    const texture = new THREE.DataTexture(new Uint8Array([255, 0, 0, 255]), 1, 1);
    texture.needsUpdate = true;

    const wall = new THREE.Mesh(
      new THREE.BoxGeometry(2, 3, 4),
      new THREE.MeshStandardMaterial({ color: 0x3366cc }),
    );
    wall.name = 'walls';

    const roof = new THREE.Mesh(
      new THREE.ConeGeometry(3, 2, 4),
      new THREE.MeshStandardMaterial({ color: 0x993333, map: texture }),
    );
    roof.name = 'roof';
    roof.position.y = 2.5;

    group.add(wall, roof);
    return group;
  };

  it('restores geometry, materials, textures and name unchanged', () => {
    const id = h.sceneManager.addObject(makeImportedModule(), 'village_house');
    const original = h.sceneManager.getObject(id)!;
    const originalWall = original.getObjectByName('walls') as THREE.Mesh;
    const originalRoof = original.getObjectByName('roof') as THREE.Mesh;
    const originalMaterial = originalRoof.material as THREE.MeshStandardMaterial;

    // References captured BEFORE the delete — they must survive untouched.
    const wallGeometry = originalWall.geometry;
    const wallMaterial = originalWall.material;
    const roofMaterial = originalMaterial;
    const roofTexture = originalMaterial.map;
    const childCount = original.children.length;

    h.deleteObject(id);
    expect(h.sceneManager.getObject(id)).toBeNull();

    h.history.undo();

    const restored = h.sceneManager.getObject(id)!;
    const restoredRoof = restored.getObjectByName('roof') as THREE.Mesh;
    expect(restored).toBe(original); // same instance, not a rebuild
    expect(restored.name).toBe('village_house');
    expect(restored.getObjectByName('walls')).toBe(originalWall);
    expect(restored.getObjectByName('walls')!.geometry).toBe(wallGeometry);
    expect((restored.getObjectByName('walls') as THREE.Mesh).material).toBe(wallMaterial);
    expect(restoredRoof.material).toBe(roofMaterial);
    expect((restoredRoof.material as THREE.MeshStandardMaterial).map).toBe(roofTexture);
    expect(roofMaterial.color.getHex()).toBe(0x993333);
    expect(restored.children).toHaveLength(childCount);
  });

  it('keeps a built-in shape exactly as it was', () => {
    const id = h.addModule('sphere');
    const original = h.sceneManager.getObject(id)!;
    const originalMaterial = (original as THREE.Mesh).material as THREE.MeshBasicMaterial;
    originalMaterial.color.setHex(0x00ff88);
    original.scale.set(2, 1.5, 0.5);

    h.deleteObject(id);
    h.history.undo();

    const restored = h.sceneManager.getObject(id)!;
    expect(restored).toBe(original);
    expect(((restored as THREE.Mesh).material as THREE.MeshBasicMaterial).color.getHex()).toBe(0x00ff88);
    expect([restored.scale.x, restored.scale.y, restored.scale.z]).toEqual([2, 1.5, 0.5]);
  });

  it('never disposes the resources across repeated undo/redo cycles', () => {
    const id = h.sceneManager.addObject(makeImportedModule(), 'village_house');
    const original = h.sceneManager.getObject(id)!;
    const disposes: number[] = [];
    original.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        vi.spyOn(child.geometry, 'dispose');
        const material = child.material as THREE.Material;
        vi.spyOn(material, 'dispose');
        disposes.push(0);
      }
    });

    h.deleteObject(id);

    for (let i = 0; i < 5; i++) {
      h.history.undo();
      expect(h.sceneManager.getObject(id)).toBe(original);
      h.history.redo();
      expect(h.sceneManager.getObject(id)).toBeNull();
    }
    h.history.undo();
    expect(h.sceneManager.getObject(id)).toBe(original);

    let disposeCalls = 0;
    original.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        disposeCalls += vi.mocked(child.geometry.dispose).mock.calls.length;
        disposeCalls += vi.mocked((child.material as THREE.Material).dispose).mock.calls.length;
      }
    });
    expect(disposeCalls).toBe(0);
  });

  it('detachObject keeps the instance usable outside the scene', () => {
    const id = h.addModule('door');
    const original = h.sceneManager.getObject(id)!;

    const detached = h.sceneManager.detachObject(id);

    expect(detached).toBe(original);
    expect(h.sceneManager.objectCount).toBe(0);
    expect(detached!.parent).toBeNull();
    // Resources still intact after detachment
    expect((original as THREE.Mesh).geometry).toBeTruthy();
    expect((original as THREE.Mesh).material).toBeTruthy();
  });
});

// ─── SceneManager identity rule ──────────────────────────

describe('SceneManager — restoreId', () => {
  it('re-registers a removed object under the requested id', () => {
    const id = h.addModule('door');
    h.sceneManager.removeObject(id);

    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
    const restored = h.sceneManager.addObject(mesh, 'door', id);

    expect(restored).toBe(id);
    expect(h.sceneManager.getObject(id)).toBe(mesh);
  });

  it('ignores the requested id when it is already in use', () => {
    const occupied = h.addModule('door');
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());

    const assigned = h.sceneManager.addObject(mesh, 'copy', occupied);

    expect(assigned).not.toBe(occupied);
    expect(h.sceneManager.getObject(occupied)?.name).toBe('door');
    expect(h.sceneManager.objectCount).toBe(2);
  });

  it('detachObject releases the id so a later restore can reuse it', () => {
    const id = h.addModule('door');
    const detached = h.sceneManager.detachObject(id)!;
    expect(h.sceneManager.hasObject(id)).toBe(false);

    const restoredId = h.sceneManager.addObject(detached, 'door', id);
    expect(restoredId).toBe(id);
    expect(h.sceneManager.getObject(id)).toBe(detached);
  });
});
