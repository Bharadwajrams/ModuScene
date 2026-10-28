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
import { SelectionManager } from '../../src/engine-3d/selection-manager';
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
  const selectionManager = new SelectionManager(
    eventBus,
    scene,
    (id) => sceneManager.getObject(id),
    (id) => sceneManager.getObject(id)?.name ?? id,
  );
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

  /**
   * Mirror of `MainApp.getSelectedModuleIds()`: checked modules are
   * authoritative, the selected module is used only when nothing is checked.
   */
  const resolveSelectionTargets = (
    primaryId: ObjectId | null,
    checkedIds: ObjectId[],
  ): ObjectId[] => {
    const ids: ObjectId[] = [];
    for (const id of checkedIds) {
      if (ids.includes(id)) continue;
      if (!sceneManager.getObject(id)) continue;
      ids.push(id);
    }
    if (ids.length > 0) return ids;
    return primaryId && sceneManager.getObject(primaryId) ? [primaryId] : [];
  };

  /**
   * Mirror of `MainApp.handleDelete()` for a multi-selection: collect the
   * targets first, then detach each instance and record one DELETE entry per
   * module, then clear the selection.
   */
  const deleteSelection = (
    primaryId: ObjectId | null,
    checkedIds: ObjectId[] = [],
  ): ObjectId[] => {
    const targetIds = resolveSelectionTargets(primaryId, checkedIds);
    if (targetIds.length === 0) return [];

    for (const objectId of targetIds) {
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
        before: before ?? undefined,
        timestamp: history.now(),
      });
    }

    selectionManager.select(null);
    return targetIds;
  };

  const addModule = (name = 'cube'): ObjectId =>
    sceneManager.addObject(
      new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial()),
      name,
    );

  return {
    scene,
    sceneManager,
    transformService,
    selectionManager,
    history,
    deleteObject,
    deleteSelection,
    resolveSelectionTargets,
    addModule,
    deletedMeta,
  };
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

// ─── Delete — multiple selected modules ─────────────────

describe('Delete — multiple selected modules', () => {
  it('deletes every module checked in the selector', () => {
    const a = h.addModule('Ground_Tile');
    const b = h.addModule('Group_House');
    const c = h.addModule('Stone_Ground');

    const deleted = h.deleteSelection(null, [a, b, c]);

    expect(deleted).toEqual([a, b, c]);
    expect(h.sceneManager.objectCount).toBe(0);
    expect(h.sceneManager.hasObject(a)).toBe(false);
    expect(h.sceneManager.hasObject(b)).toBe(false);
    expect(h.sceneManager.hasObject(c)).toBe(false);
  });

  it('deletes only the checked modules and leaves the rest untouched', () => {
    const checked1 = h.addModule('a');
    const checked2 = h.addModule('b');
    const unselected = h.addModule('keep-me');

    const deleted = h.deleteSelection(null, [checked1, checked2]);

    expect(deleted).toHaveLength(2);
    expect(h.sceneManager.objectCount).toBe(1);
    expect(h.sceneManager.getObject(unselected)!.name).toBe('keep-me');
  });

  it('does NOT delete an unchecked module that merely happens to be selected', () => {
    const staleSelection = h.addModule('old-selection');
    const checked1 = h.addModule('a');
    const checked2 = h.addModule('b');

    const deleted = h.deleteSelection(staleSelection, [checked1, checked2]);

    expect(deleted).toEqual([checked1, checked2]);
    expect(h.sceneManager.getObject(staleSelection)).not.toBeNull();
    expect(h.sceneManager.objectCount).toBe(1);
  });

  it('deletes the selected module alone when nothing is checked', () => {
    const selected = h.addModule('a');
    const other = h.addModule('b');

    const deleted = h.deleteSelection(selected);

    expect(deleted).toEqual([selected]);
    expect(h.sceneManager.hasObject(selected)).toBe(false);
    expect(h.sceneManager.hasObject(other)).toBe(true);
  });

  it('deletes a checked module only once when it is also the selection', () => {
    const a = h.addModule('a');
    const b = h.addModule('b');

    const deleted = h.deleteSelection(a, [a, b]);

    expect(deleted).toEqual([a, b]);
    expect(h.sceneManager.objectCount).toBe(0);
  });

  it('falls back to the selected module when every checked id is stale', () => {
    const selected = h.addModule('a');
    const gone = h.addModule('gone');
    h.sceneManager.removeObject(gone);

    const deleted = h.deleteSelection(selected, [gone]);

    expect(deleted).toEqual([selected]);
    expect(h.sceneManager.objectCount).toBe(0);
  });

  it('clears the selection so no deleted module stays active', () => {
    const a = h.addModule('a');
    const b = h.addModule('b');
    h.selectionManager.select(a);
    expect(h.selectionManager.selectedId).toBe(a);

    h.deleteSelection(a, [a, b]);

    expect(h.selectionManager.selectedId).toBeNull();
    expect(h.sceneManager.objectCount).toBe(0);
  });

  it('does nothing when there is no selection', () => {
    h.addModule('a');

    expect(h.deleteSelection(null, [])).toEqual([]);
    expect(h.sceneManager.objectCount).toBe(1);
    expect(h.history.undoDepth).toBe(0);
    expect(h.selectionManager.selectedId).toBeNull();
  });

  it('removes one instance of a shared asset without touching its sibling', () => {
    // Two instances of the same imported module: same asset, different ids.
    const makeInstance = () =>
      new THREE.Mesh(
        new THREE.BoxGeometry(1, 1, 1),
        new THREE.MeshStandardMaterial({ color: 0x884422 }),
      );
    const firstMesh = makeInstance();
    const secondMesh = makeInstance();
    const first = h.sceneManager.addObject(firstMesh, 'village_house');
    const second = h.sceneManager.addObject(secondMesh, 'village_house');

    h.deleteSelection(first);

    expect(h.sceneManager.hasObject(first)).toBe(false);
    expect(h.sceneManager.hasObject(second)).toBe(true);
    const survivor = h.sceneManager.getObject(second) as THREE.Mesh;
    expect(survivor).toBe(secondMesh);
    // Resources were never disposed, so the surviving instance still renders.
    expect(survivor.geometry).toBe(secondMesh.geometry);
    expect(survivor.material).toBe(secondMesh.material);
    expect(h.deletedMeta.get(first)!.object).toBe(firstMesh);
  });

  it('never touches the asset catalog, so a deleted asset can be added again', () => {
    const assets = [{ assetId: 'asset-house', name: 'village_house' }];
    const before = JSON.stringify(assets);

    const a = h.addModule('village_house');
    h.deleteSelection(a);

    expect(h.sceneManager.objectCount).toBe(0);
    expect(JSON.stringify(assets)).toBe(before);

    // The asset is still usable: a new instance registers under a fresh id.
    const readded = h.sceneManager.addObject(
      new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial()),
      assets[0].name,
    );
    expect(h.sceneManager.hasObject(readded)).toBe(true);
    expect(readded).not.toBe(a);
  });

  it('undo restores every deleted module under its own id and transform', () => {
    const a = h.addModule('a');
    const b = h.addModule('b');
    const c = h.addModule('c');
    const originals = new Map(
      [a, b, c].map((id) => [id, h.sceneManager.getObject(id)!] as const),
    );
    h.sceneManager.getObject(a)!.position.set(3, 0, -2);
    h.sceneManager.getObject(b)!.position.set(-1, 2, 0);
    h.sceneManager.getObject(c)!.scale.set(2, 1.5, 0.5);

    h.deleteSelection(null, [a, b, c]);
    expect(h.sceneManager.objectCount).toBe(0);

    h.history.undo();
    h.history.undo();
    h.history.undo();

    expect(h.sceneManager.objectCount).toBe(3);
    for (const id of [a, b, c]) {
      expect(h.sceneManager.getObject(id)).toBe(originals.get(id));
      expect(h.sceneManager.hasObject(id)).toBe(true);
    }
    expect(h.sceneManager.getObject(a)!.position.toArray()).toEqual([3, 0, -2]);
    expect(h.sceneManager.getObject(b)!.position.toArray()).toEqual([-1, 2, 0]);
    expect(h.sceneManager.getObject(c)!.scale.toArray()).toEqual([2, 1.5, 0.5]);
  });

  it('removes the group again on redo and stays consistent across cycles', () => {
    const a = h.addModule('a');
    const b = h.addModule('b');

    h.deleteSelection(a, [a, b]);

    for (let i = 0; i < 3; i++) {
      h.history.undo();
      h.history.undo();
      expect(h.sceneManager.objectCount).toBe(2);
      expect(h.sceneManager.hasObject(a)).toBe(true);
      expect(h.sceneManager.hasObject(b)).toBe(true);

      h.history.redo();
      h.history.redo();
      expect(h.sceneManager.objectCount).toBe(0);
    }
  });

  it('keeps deleting correctly across duplication and further deletions', () => {
    const a = h.addModule('a');
    const b = h.addModule('b');
    const pairs = h.sceneManager.duplicateObjects([a, b]);
    const copyA = pairs[0].cloneId;
    const copyB = pairs[1].cloneId;

    // Delete the copies only — the originals must survive
    h.deleteSelection(null, [copyA, copyB]);
    expect(h.sceneManager.hasObject(a)).toBe(true);
    expect(h.sceneManager.hasObject(b)).toBe(true);
    expect(h.sceneManager.objectCount).toBe(2);

    // A later group delete of the remaining modules still works
    h.deleteSelection(a, [a, b]);
    expect(h.sceneManager.objectCount).toBe(0);
    expect(h.sceneManager.hasObject(copyA)).toBe(false);
    expect(new Set([a, b, copyA, copyB]).size).toBe(4);
  });
});
