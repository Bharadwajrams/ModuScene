/**
 * Duplicate — single and multi-module tests
 *
 * Guards the defect: Duplicate only ever read `selectionManager.selectedId`, so
 * the modules checked for group movement (the Inspector's Manual Module
 * Selector checkboxes) were silently dropped and only the selected module was
 * copied (or nothing at all when the duplication target was merely checked).
 *
 * The scene half is exercised directly against the real SceneManager /
 * TransformService / SelectionManager / HistoryManager. The two selection
 * helpers below mirror main.ts (the app itself needs WebGL and cannot be
 * instantiated here) exactly as `delete-undo-redo.test.ts` mirrors the DELETE
 * branches: resolve the target list, then duplicate it as one collection.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { EventBus } from '../../src/core/event-bus';
import { HistoryManager } from '../../src/core/history-manager';
import { SceneManager, nextDuplicateName } from '../../src/engine-3d/scene-manager';
import { TransformService } from '../../src/engine-3d/transform-service';
import { SelectionManager } from '../../src/engine-3d/selection-manager';
import type {
  AssetRecord,
  HistoryRecord,
  ObjectId,
  TransformSnapshot,
} from '../../src/core/contracts';

// ─── Harness ─────────────────────────────────────────────

/**
 * Mirror of `MainApp.getSelectedModuleIds()` (src/main.ts): checked modules
 * win; the selected module is used only when nothing is checked.
 */
function resolveDuplicateTargets(
  primaryId: ObjectId | null,
  checkedIds: ObjectId[],
  sceneManager: SceneManager,
): ObjectId[] {
  const ids: ObjectId[] = [];
  for (const id of checkedIds) {
    if (ids.includes(id)) continue;
    if (!sceneManager.getObject(id)) continue;
    ids.push(id);
  }
  if (ids.length > 0) return ids;

  return primaryId && sceneManager.getObject(primaryId) ? [primaryId] : [];
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

  const assets: AssetRecord[] = [
    { assetId: 'asset-ground', name: 'Ground_Tile', sourceType: 'GLB', textureStatus: 'OK', loadStatus: 'LOADED' },
    { assetId: 'asset-house', name: 'Group_House', sourceType: 'GLB', textureStatus: 'OK', loadStatus: 'LOADED' },
    { assetId: 'asset-stone', name: 'Stone_Ground', sourceType: 'GLB', textureStatus: 'OK', loadStatus: 'LOADED' },
  ];

  // main.ts metadata maps (CREATE / DELETE bookkeeping)
  const createdMeta = new Map<ObjectId, { name: string; assetId: string }>();

  const history = new HistoryManager(
    eventBus,
    (record: HistoryRecord) => {
      // Redo CREATE — mirror of MainApp.applyHistoryRecord
      if (record.actionType === 'CREATE') {
        const meta = createdMeta.get(record.targetObjectId);
        if (!meta || !record.after) return;
        const original = sceneManager.getAllObjects().find((o) => o.name === meta.name);
        if (!original) return;
        const originalObj = sceneManager.getObject(original.objectId);
        if (!originalObj) return;
        const clone = originalObj.clone(true);
        const newId = sceneManager.addObject(
          clone,
          nextDuplicateName(meta.name, sceneManager.objectNames()),
        );
        transformService.setTransform(newId, record.after);
        selectionManager.select(newId);
        return;
      }
      if (record.after) {
        transformService.setTransform(record.targetObjectId, record.after);
        selectionManager.select(record.targetObjectId);
      }
    },
    (record: HistoryRecord) => {
      // Undo CREATE — mirror of MainApp.revertHistoryRecord
      if (record.actionType === 'CREATE') {
        sceneManager.removeObject(record.targetObjectId);
        selectionManager.select(null);
        return;
      }
      if (record.before) {
        transformService.setTransform(record.targetObjectId, record.before);
        selectionManager.select(record.targetObjectId);
      }
    },
  );

  /**
   * Mirror of `MainApp.handleDuplicate()` — the whole current selection (the
   * selected module plus every checked module), duplicated as one collection.
   */
  const duplicate = (primaryId: ObjectId | null, checkedIds: ObjectId[] = []): ObjectId[] => {
    const targetIds = resolveDuplicateTargets(primaryId, checkedIds, sceneManager);
    if (targetIds.length === 0) return [];

    const copies = sceneManager.duplicateObjects(targetIds);

    for (const { sourceId, cloneId } of copies) {
      const afterSnapshot = transformService.getTransform(cloneId);
      const originalObj = sceneManager.getObject(sourceId);
      const assetEntry = assets.find((a) => a.name === originalObj?.name);
      createdMeta.set(cloneId, {
        name: originalObj?.name || 'Duplicate',
        assetId: assetEntry?.assetId || '',
      });

      history.recordAction({
        commandId: history.generateCommandId(),
        actionType: 'CREATE',
        targetObjectId: cloneId,
        source: 'UI',
        after: afterSnapshot ?? undefined,
        timestamp: history.now(),
      });
    }

    const selectedClone =
      copies.find((copy) => copy.sourceId === primaryId)?.cloneId ?? copies[0]?.cloneId;
    if (selectedClone) selectionManager.select(selectedClone);
    return copies.map((copy) => copy.cloneId);
  };

  const addMesh = (
    name = 'cube',
    position: [number, number, number] = [0, 0, 0],
  ): ObjectId => {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ color: 0x33aa66 }),
    );
    mesh.position.set(position[0], position[1], position[2]);
    return sceneManager.addObject(mesh, name);
  };

  const snapshot = (id: ObjectId): TransformSnapshot => transformService.getTransform(id)!;

  return {
    scene,
    sceneManager,
    transformService,
    selectionManager,
    history,
    duplicate,
    addMesh,
    snapshot,
  };
}

let h: ReturnType<typeof setup>;

beforeEach(() => {
  h = setup();
});

// ─── Scene layer: single duplication unchanged ───────────

describe('SceneManager.duplicateObjects — single module', () => {
  it('behaves exactly like duplicateObject', () => {
    const id = h.addMesh('Ground_Tile', [2, 0, 3]);

    const pairs = h.sceneManager.duplicateObjects([id]);

    expect(pairs).toHaveLength(1);
    const cloneId = pairs[0].cloneId;
    expect(pairs[0].sourceId).toBe(id);
    expect(cloneId).not.toBe(id);

    const original = h.sceneManager.getObject(id)!;
    const clone = h.sceneManager.getObject(cloneId)!;
    // Same offset the single-module button always applied
    expect([clone.position.x, clone.position.y, clone.position.z]).toEqual([3, 0, 4]);
    expect(clone.name).toBe('Ground_Tile (1)');
    // The original is untouched and the copy is a separate instance
    expect([original.position.x, original.position.z]).toEqual([2, 3]);
    expect(clone).not.toBe(original);
    expect(h.sceneManager.hasObject(id)).toBe(true);
  });

  it('skips ids that are not in the scene', () => {
    expect(h.sceneManager.duplicateObjects(['obj-missing'])).toEqual([]);
    expect(h.sceneManager.objectCount).toBe(0);
  });
});

// ─── Scene layer: multi duplication ──────────────────────

describe('SceneManager.duplicateObjects — multiple modules', () => {
  it('copies every module with its own unique id', () => {
    const a = h.addMesh('Ground_Tile', [0, 0, 0]);
    const b = h.addMesh('Group_House', [5, 0, 0]);
    const c = h.addMesh('Stone_Ground', [0, 0, 5]);

    const pairs = h.sceneManager.duplicateObjects([a, b, c]);

    expect(pairs).toHaveLength(3);
    expect(h.sceneManager.objectCount).toBe(6);

    const cloneIds = pairs.map((p) => p.cloneId);
    const allIds = new Set([a, b, c, ...cloneIds]);
    expect(allIds.size).toBe(6); // no collisions anywhere
    expect(cloneIds).not.toContain(a);
    expect(pairs.map((p) => p.sourceId)).toEqual([a, b, c]);
  });

  it('preserves the collection’s relative arrangement', () => {
    const positions: Array<[number, number, number]> = [
      [0, 0, 0],
      [4, 0, 0],
      [4, 2, 3],
    ];
    const sources = positions.map((p, i) => h.addMesh(`mod-${i}`, p));

    const pairs = h.sceneManager.duplicateObjects(sources);
    const originals = sources.map((id) => h.snapshot(id).position);
    const copies = pairs.map((p) => h.snapshot(p.cloneId).position);

    // Every pairwise delta of the copies equals the originals' delta: the
    // structure survives, it is only shifted as a whole.
    for (let i = 0; i < originals.length; i++) {
      for (let j = 0; j < originals.length; j++) {
        expect(copies[j].x - copies[i].x).toBeCloseTo(originals[j].x - originals[i].x, 10);
        expect(copies[j].y - copies[i].y).toBeCloseTo(originals[j].y - originals[i].y, 10);
        expect(copies[j].z - copies[i].z).toBeCloseTo(originals[j].z - originals[i].z, 10);
      }
    }

    // One uniform collection offset (the existing Dup offset: +1 X, +1 Z).
    for (let i = 0; i < originals.length; i++) {
      expect(copies[i].x - originals[i].x).toBeCloseTo(1, 10);
      expect(copies[i].y - originals[i].y).toBeCloseTo(0, 10);
      expect(copies[i].z - originals[i].z).toBeCloseTo(1, 10);
    }
  });

  it('preserves each module’s own rotation and scale', () => {
    const a = h.addMesh('a');
    const b = h.addMesh('b');
    const objA = h.sceneManager.getObject(a)!;
    objA.rotation.set(0.3, 1.1, -0.4);
    objA.scale.set(2, 1.5, 0.5);

    const objB = h.sceneManager.getObject(b)!;
    objB.rotation.set(-1.2, 0, 0.8);
    objB.scale.set(0.25, 4, 1);

    const pairs = h.sceneManager.duplicateObjects([a, b]);

    for (let i = 0; i < 2; i++) {
      const before = h.snapshot(pairs[i].sourceId);
      const after = h.snapshot(pairs[i].cloneId);
      // Quaternion round-tripping in Object3D.clone leaves float noise, so
      // compare with a tolerance instead of exact identity.
      expect(after.rotationRadians.x).toBeCloseTo(before.rotationRadians.x, 10);
      expect(after.rotationRadians.y).toBeCloseTo(before.rotationRadians.y, 10);
      expect(after.rotationRadians.z).toBeCloseTo(before.rotationRadians.z, 10);
      expect(after.scale.x).toBeCloseTo(before.scale.x, 10);
      expect(after.scale.y).toBeCloseTo(before.scale.y, 10);
      expect(after.scale.z).toBeCloseTo(before.scale.z, 10);
    }
  });

  it('duplicates only the ids it is given', () => {
    const a = h.addMesh('a');
    const b = h.addMesh('b');
    const untouchedA = h.addMesh('untouched-a');
    const untouchedB = h.addMesh('untouched-b');

    const pairs = h.sceneManager.duplicateObjects([a, b]);

    expect(pairs).toHaveLength(2);
    expect(h.sceneManager.objectCount).toBe(6);
    expect(h.sceneManager.getObject(untouchedA)!.name).toBe('untouched-a');
    expect(h.sceneManager.getObject(untouchedB)!.name).toBe('untouched-b');
    // Exactly one copy per source, no copy of the unselected modules
    const copyNames = pairs.map((p) => h.sceneManager.getObject(p.cloneId)!.name);
    expect(copyNames.sort()).toEqual(['a (1)', 'b (1)']);
  });

  it('leaves every original transform untouched', () => {
    const ids = [
      h.addMesh('a', [1, 2, 3]),
      h.addMesh('b', [-4, 0, 2]),
    ];
    const before = ids.map((id) => JSON.stringify(h.snapshot(id)));

    h.sceneManager.duplicateObjects(ids);

    expect(ids.map((id) => JSON.stringify(h.snapshot(id)))).toEqual(before);
  });

  it('gives each copy an independent transform', () => {
    const a = h.addMesh('a', [0, 0, 0]);
    const b = h.addMesh('b', [3, 0, 0]);

    const [copyA, copyB] = h.sceneManager.duplicateObjects([a, b]).map((p) => p.cloneId);

    const origA = h.snapshot(a);
    h.sceneManager.getObject(copyA)!.position.set(20, 5, -7);
    h.sceneManager.getObject(copyA)!.rotation.set(1, 2, 3);
    h.sceneManager.getObject(copyA)!.scale.set(3, 3, 3);

    // Neither the original nor the sibling copy moved with it.
    expect(h.snapshot(a)).toEqual(origA);
    expect([h.snapshot(copyB).position.x, h.snapshot(copyB).position.z]).toEqual([4, 1]);
  });

  it('does not reuse ids across repeated duplication', () => {
    const a = h.addMesh('a', [0, 0, 0]);
    const b = h.addMesh('b', [2, 0, 0]);

    const first = h.sceneManager.duplicateObjects([a, b]).map((p) => p.cloneId);
    const second = h.sceneManager.duplicateObjects([a, b]).map((p) => p.cloneId);

    expect(new Set([a, b, ...first, ...second]).size).toBe(6);
    expect(h.sceneManager.objectCount).toBe(6);
    // Each round applies the same existing offset to the same originals —
    // copies never wander apart or stack on top of each other.
    expect(first.map((id) => h.snapshot(id).position.x)).toEqual([1, 3]);
    expect(second.map((id) => h.snapshot(id).position.x)).toEqual([1, 3]);
  });
});

// ─── Appearance / imported modules ───────────────────────

describe('Duplicate — appearance', () => {
  /** An "imported module": a group of several meshes with distinct materials. */
  const makeImportedModule = (): THREE.Group => {
    const group = new THREE.Group();
    group.name = 'Group_House';

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

  it('copies a textured multi-mesh import with its geometry and materials', () => {
    const id = h.sceneManager.addObject(makeImportedModule(), 'Group_House');
    const original = h.sceneManager.getObject(id)!;

    const [cloneId] = h.sceneManager.duplicateObjects([id]).map((p) => p.cloneId);
    const clone = h.sceneManager.getObject(cloneId)!;

    expect(clone).not.toBe(original);
    expect(clone.children).toHaveLength(original.children.length);
    expect(clone.getObjectByName('walls')).not.toBe(original.getObjectByName('walls'));

    const cloneRoof = clone.getObjectByName('roof') as THREE.Mesh;
    const originalRoof = original.getObjectByName('roof') as THREE.Mesh;
    const cloneMaterial = cloneRoof.material as THREE.MeshStandardMaterial;
    // Appearance is preserved exactly — same colours, same texture.
    expect(cloneMaterial.color.getHex()).toBe(0x993333);
    expect(cloneMaterial.map).toBe((originalRoof.material as THREE.MeshStandardMaterial).map);
    expect(cloneRoof.geometry).toBe(originalRoof.geometry);
    expect(clone.name).toBe('Group_House (1)');
  });

  it('keeps a copied child transform independent of the original', () => {
    const id = h.sceneManager.addObject(makeImportedModule(), 'Group_House');
    const original = h.sceneManager.getObject(id)!;
    const [cloneId] = h.sceneManager.duplicateObjects([id]).map((p) => p.cloneId);
    const clone = h.sceneManager.getObject(cloneId)!;

    (clone.getObjectByName('roof') as THREE.Mesh).position.set(9, 9, 9);

    expect(original.getObjectByName('roof')!.position.toArray()).toEqual([0, 2.5, 0]);
  });

  it('keeps a built-in shape’s material colour', () => {
    const id = h.addMesh('cube', [0, 0, 0]);
    const original = h.sceneManager.getObject(id) as THREE.Mesh;
    (original.material as THREE.MeshBasicMaterial).color.setHex(0x00ff88);

    const [cloneId] = h.sceneManager.duplicateObjects([id]).map((p) => p.cloneId);
    const clone = h.sceneManager.getObject(cloneId) as THREE.Mesh;

    expect((clone.material as THREE.MeshBasicMaterial).color.getHex()).toBe(0x00ff88);
  });
});

// ─── Selection resolution (mirrors main.ts) ──────────────

describe('Duplicate — current selection resolution', () => {
  it('duplicates only the selected module when nothing is checked', () => {
    const a = h.addMesh('a');
    const b = h.addMesh('b');

    const copies = h.duplicate(a);

    expect(copies).toHaveLength(1);
    expect(h.sceneManager.objectCount).toBe(3);
    expect(h.sceneManager.getObject(b)!.name).toBe('b');
  });

  it('duplicates every checked module', () => {
    const checked1 = h.addMesh('Group_House');
    const checked2 = h.addMesh('Stone_Ground');
    const checked3 = h.addMesh('Ground_Tile');

    const copies = h.duplicate(null, [checked1, checked2, checked3]);

    expect(copies).toHaveLength(3);
    expect(h.sceneManager.objectCount).toBe(6);
    for (const id of [checked1, checked2, checked3]) {
      expect(h.sceneManager.hasObject(id)).toBe(true);
    }
  });

  it('does NOT duplicate an unchecked module that merely happens to be selected', () => {
    const staleSelection = h.addMesh('old-selection');
    const checked1 = h.addMesh('Ground_Tile');
    const checked2 = h.addMesh('Group_House');

    const copies = h.duplicate(staleSelection, [checked1, checked2]);

    expect(copies).toHaveLength(2);
    // Only the two checked modules were copied — no third copy of the selection
    expect(h.sceneManager.objectCount).toBe(5);
    const names = copies.map((id) => h.sceneManager.getObject(id)!.name).sort();
    expect(names.sort()).toEqual(['Ground_Tile (1)', 'Group_House (1)']);
  });

  it('duplicates a checked module only once when it is also the selection', () => {
    const a = h.addMesh('a');
    const b = h.addMesh('b');

    // The selected module is one of the checked ones (the usual case)
    const copies = h.duplicate(a, [a, b]);

    expect(copies).toHaveLength(2);
    expect(h.sceneManager.objectCount).toBe(4);
    expect(new Set(copies).size).toBe(2);
  });

  it('works when modules are checked but nothing is selected', () => {
    const a = h.addMesh('a');
    const b = h.addMesh('b');

    const copies = h.duplicate(null, [a, b]);

    expect(copies).toHaveLength(2);
    expect(h.sceneManager.objectCount).toBe(4);
  });

  it('does nothing when nothing is selected or checked', () => {
    h.addMesh('a');

    expect(h.duplicate(null)).toEqual([]);
    expect(h.history.undoDepth).toBe(0);
    expect(h.selectionManager.selectedId).toBeNull();
  });

  it('falls back to the selected module when every checked id is stale', () => {
    const a = h.addMesh('a');
    const gone = h.addMesh('gone');
    h.sceneManager.removeObject(gone);

    const copies = h.duplicate(a, [gone]);

    expect(copies).toHaveLength(1);
    expect(h.sceneManager.objectCount).toBe(2);
  });

  it('selects the copy of the selected module when it is checked too', () => {
    const selected = h.addMesh('Ground_Tile', [2, 0, 2]);
    const checked = h.addMesh('Group_House', [8, 0, 2]);

    const copies = h.duplicate(selected, [selected, checked]);

    expect(copies).toHaveLength(2);
    expect(h.sceneManager.getObject(h.selectionManager.selectedId!)!.name).toBe(
      'Ground_Tile (1)',
    );
  });

  it('selects the first copy when the selected module was not duplicated', () => {
    const selected = h.addMesh('old-selection', [2, 0, 2]);
    const checked = h.addMesh('Group_House', [8, 0, 2]);

    const copies = h.duplicate(selected, [checked]);

    expect(copies).toHaveLength(1);
    expect(h.selectionManager.selectedId).toBe(copies[0]);
    expect(h.sceneManager.getObject(copies[0]!)!.name).toBe('Group_House (1)');
  });
});

// ─── History ─────────────────────────────────────────────

describe('Duplicate — history', () => {
  it('records one CREATE entry per copy and undo removes them one by one', () => {
    const a = h.addMesh('a');
    const b = h.addMesh('b');
    const c = h.addMesh('c');

    h.duplicate(a, [a, b, c]);
    expect(h.history.undoDepth).toBe(3);

    h.history.undo();
    expect(h.sceneManager.objectCount).toBe(5);
    h.history.undo();
    expect(h.sceneManager.objectCount).toBe(4);
    h.history.undo();
    expect(h.sceneManager.objectCount).toBe(3);

    // Originals only remain
    expect(h.sceneManager.hasObject(a)).toBe(true);
    expect(h.sceneManager.hasObject(b)).toBe(true);
    expect(h.sceneManager.hasObject(c)).toBe(true);
  });

  it('redo after undo re-creates a copy at its duplicated transform', () => {
    const a = h.addMesh('a', [1, 0, 1]);

    h.duplicate(a);
    h.history.undo();
    expect(h.sceneManager.objectCount).toBe(1);

    h.history.redo();

    expect(h.sceneManager.objectCount).toBe(2);
    // The redo path re-adds the copy from the CREATE record (existing
    // behaviour: it reuses the original's stored name). What matters is that
    // the restored module is a separate object at the duplicated transform.
    const restored = h.sceneManager
      .getAllObjects()
      .find((o) => o.objectId !== a)!;
    expect(restored.objectId).not.toBe(a);
    expect([restored.transform.position.x, restored.transform.position.z]).toEqual([2, 2]);
  });

  it('successive duplications of the same selection stay independent', () => {
    const a = h.addMesh('a', [0, 0, 0]);
    const b = h.addMesh('b', [4, 0, 0]);

    const first = h.duplicate(a, [a, b]);
    const second = h.duplicate(a, [a, b]);

    expect(first).toHaveLength(2);
    expect(second).toHaveLength(2);
    const all = [a, b, ...first, ...second];
    expect(new Set(all).size).toBe(6);

    // Moving one copy never changes its original or its siblings
    h.sceneManager.getObject(second[0]!)!.position.set(50, 0, 50);
    expect(h.sceneManager.getObject(a)!.position.toArray()).toEqual([0, 0, 0]);
    expect(h.sceneManager.getObject(first[0]!)!.position.toArray()).toEqual([1, 0, 1]);
    expect(h.sceneManager.getObject(second[1]!)!.position.toArray()).toEqual([5, 0, 1]);
  });
});
