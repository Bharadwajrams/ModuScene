/**
 * Duplicate naming — numbered suffixes
 *
 * Replaces the old "(copy)" appending behaviour: a duplicated module is named
 * "<base> (n)" with the LOWEST free number, so repeated duplication gives
 * "Cube (1)", "Cube (2)", "Cube (3)" instead of "Cube (copy)(copy)(copy)".
 *
 * `duplicateBaseName` only strips a trailing " (n)" when the name really
 * belongs to a duplicate family, so a module whose genuine name contains
 * parentheses or numbers keeps them.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { SceneManager, duplicateBaseName, nextDuplicateName } from '../../src/engine-3d/scene-manager';
import type { ObjectId } from '../../src/core/contracts';

// ─── Harness ─────────────────────────────────────────────

function setup() {
  const sceneManager = new SceneManager(new THREE.Scene());

  const addModule = (name: string): ObjectId =>
    sceneManager.addObject(
      new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial()),
      name,
    );

  const duplicate = (id: ObjectId): string => {
    const cloneId = sceneManager.duplicateObject(id);
    return sceneManager.getObject(cloneId!)!.name;
  };

  const names = (): string[] => sceneManager.objectNames();

  return { sceneManager, addModule, duplicate, names };
}

let h: ReturnType<typeof setup>;

beforeEach(() => {
  h = setup();
});

// ─── Pure naming function ────────────────────────────────

describe('nextDuplicateName', () => {
  it('numbers the first duplicate of a plain name', () => {
    expect(nextDuplicateName('Cube', ['Cube'])).toBe('Cube (1)');
  });

  it('continues the numbering from an existing duplicate', () => {
    expect(nextDuplicateName('Cube', ['Cube', 'Cube (1)'])).toBe('Cube (2)');
    expect(nextDuplicateName('Cube (1)', ['Cube', 'Cube (1)'])).toBe('Cube (2)');
    expect(nextDuplicateName('Cube (3)', ['Cube', 'Cube (1)', 'Cube (2)', 'Cube (3)'])).toBe(
      'Cube (4)',
    );
  });

  it('fills the lowest free number when there is a gap', () => {
    expect(nextDuplicateName('Cube', ['Cube', 'Cube (1)', 'Cube (3)'])).toBe('Cube (2)');
    expect(nextDuplicateName('Cube', ['Cube', 'Cube (2)'])).toBe('Cube (1)');
  });

  it('never repeats a name already used by another module', () => {
    // A different module happens to be called "Cube (1)"
    expect(nextDuplicateName('Cube', ['Cube', 'Cube (1)'])).toBe('Cube (2)');
    expect(nextDuplicateName('Cube', ['Cube', 'Cube (1)', 'Cube (2)', 'Cube (4)'])).toBe(
      'Cube (3)',
    );
  });

  it('keeps names that only look like duplicates (no family in the scene)', () => {
    expect(nextDuplicateName('House (2)', ['House (2)'])).toBe('House (2) (1)');
    expect(nextDuplicateName('Wall (north)', ['Wall (north)'])).toBe('Wall (north) (1)');
    expect(nextDuplicateName('Tower 2024', ['Tower 2024'])).toBe('Tower 2024 (1)');
    expect(nextDuplicateName('Part 2 of 3', ['Part 2 of 3'])).toBe('Part 2 of 3 (1)');
  });

  it('does not strip parentheses that are not a trailing number', () => {
    expect(nextDuplicateName('Roof (draft)', ['Roof (draft)'])).toBe('Roof (draft) (1)');
    expect(nextDuplicateName('Cube (1) (draft)', ['Cube (1) (draft)'])).toBe(
      'Cube (1) (draft) (1)',
    );
  });
});

describe('duplicateBaseName', () => {
  it('resolves a numbered duplicate to its family base', () => {
    expect(duplicateBaseName('Cube (2)', ['Cube', 'Cube (2)'])).toBe('Cube');
  });

  it('keeps a naturally parenthesised name when it is not a duplicate', () => {
    expect(duplicateBaseName('House (2)', ['House (2)'])).toBe('House (2)');
    expect(duplicateBaseName('House (2)', ['House', 'House (2)'])).toBe('House');
  });

  it('leaves plain names untouched', () => {
    expect(duplicateBaseName('Cube', ['Cube'])).toBe('Cube');
    expect(duplicateBaseName('village_house', ['village_house'])).toBe('village_house');
  });
});

// ─── Scene integration ───────────────────────────────────

describe('Duplicate names in the scene', () => {
  it('numbers successive duplicates and leaves the original name alone', () => {
    const cube = h.addModule('Cube');

    expect(h.duplicate(cube)).toBe('Cube (1)');
    expect(h.duplicate(cube)).toBe('Cube (2)');
    expect(h.duplicate(cube)).toBe('Cube (3)');
    expect(h.names()).toEqual(['Cube', 'Cube (1)', 'Cube (2)', 'Cube (3)']);
  });

  it('duplicating a numbered duplicate continues the numbering', () => {
    const cube = h.addModule('Cube');
    const first = h.duplicate(cube); // Cube (1)
    const firstId = h.sceneManager.getAllObjects().find((o) => o.name === first)!.objectId;

    expect(h.duplicate(firstId)).toBe('Cube (2)');
    expect(h.duplicate(firstId)).toBe('Cube (3)');
    expect(h.names()).toEqual(['Cube', 'Cube (1)', 'Cube (2)', 'Cube (3)']);
  });

  it('picks the lowest free number after names were deleted', () => {
    const cube = h.addModule('Cube');
    h.duplicate(cube); // Cube (1)
    h.duplicate(cube); // Cube (2)
    const second = h.sceneManager.getAllObjects().find((o) => o.name === 'Cube (2)')!.objectId;
    h.sceneManager.removeObject(second);

    expect(h.duplicate(cube)).toBe('Cube (2)');
  });

  it('names each module of a multi-module duplication independently', () => {
    const cube = h.addModule('Cube');
    const sphere = h.addModule('Sphere');

    const pairs = h.sceneManager.duplicateObjects([cube, sphere]);
    expect(pairs.map((p) => h.sceneManager.getObject(p.cloneId)!.name)).toEqual([
      'Cube (1)',
      'Sphere (1)',
    ]);

    const again = h.sceneManager.duplicateObjects([cube, sphere]);
    expect(again.map((p) => h.sceneManager.getObject(p.cloneId)!.name)).toEqual([
      'Cube (2)',
      'Sphere (2)',
    ]);
  });

  it('numbers a module and its own duplicate in one multi-duplication', () => {
    const cube = h.addModule('Cube');
    const firstCopy = h.sceneManager.duplicateObject(cube)!;

    const pairs = h.sceneManager.duplicateObjects([cube, firstCopy]);

    expect(pairs.map((p) => h.sceneManager.getObject(p.cloneId)!.name)).toEqual([
      'Cube (2)',
      'Cube (3)',
    ]);
    expect(new Set(h.names()).size).toBe(h.names().length);
  });

  it('never produces two identical display names across repeated duplication', () => {
    const cube = h.addModule('Cube');
    const sphere = h.addModule('Sphere');

    for (let round = 0; round < 4; round++) {
      h.sceneManager.duplicateObjects([cube, sphere]);
    }

    const all = h.names();
    expect(all).toHaveLength(10);
    expect(new Set(all).size).toBe(10);
    expect(all.filter((n) => n.startsWith('Cube')).sort()).toEqual([
      'Cube',
      'Cube (1)',
      'Cube (2)',
      'Cube (3)',
      'Cube (4)',
    ]);
  });

  it('keeps a meaningful parenthesised name and numbers from it', () => {
    const house = h.addModule('House (2)');

    expect(h.duplicate(house)).toBe('House (2) (1)');
    expect(h.duplicate(house)).toBe('House (2) (2)');
    expect(h.names()).toEqual(['House (2)', 'House (2) (1)', 'House (2) (2)']);
  });

  it('keeps the duplicate offset and independent instances while renaming', () => {
    const cube = h.addModule('Cube');
    h.sceneManager.getObject(cube)!.position.set(2, 1, -3);

    const copyId = h.sceneManager.duplicateObject(cube)!;
    const copy = h.sceneManager.getObject(copyId)!;

    expect(copy.name).toBe('Cube (1)');
    expect([copy.position.x, copy.position.y, copy.position.z]).toEqual([3, 1, -2]);
    // Original untouched, copy is its own object
    expect(h.sceneManager.getObject(cube)!.name).toBe('Cube');
    expect([h.sceneManager.getObject(cube)!.position.x, h.sceneManager.getObject(cube)!.position.z]).toEqual([2, -3]);
    expect(copy).not.toBe(h.sceneManager.getObject(cube));
  });
});
