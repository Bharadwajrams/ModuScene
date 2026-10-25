/**
 * Manual Module Selector unit tests
 *
 * Wired exactly like the application: EventBus + CommandRouter →
 * SelectionManager, with the real SceneManager / DisplayAdapter /
 * Inspector on top. No CV engine, no MediaPipe, no hand tracking.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { EventBus } from '../../src/core/event-bus';
import { CommandRouter } from '../../src/core/command-router';
import { SceneManager } from '../../src/engine-3d/scene-manager';
import { SelectionManager } from '../../src/engine-3d/selection-manager';
import { DisplayAdapter } from '../../src/engine-3d/display-adapter';
import { TransformService } from '../../src/engine-3d/transform-service';
import { Inspector } from '../../src/engine-ui/inspector';
import { ManualModuleSelector } from '../../src/engine-ui/manual-module-selector';
import type { SelectionCommand } from '../../src/core/contracts';

// ─── Harness ─────────────────────────────────────────────

interface Harness {
  eventBus: EventBus;
  scene: THREE.Scene;
  sceneManager: SceneManager;
  selection: SelectionManager;
  displayAdapter: DisplayAdapter;
  transformService: TransformService;
  selector: ManualModuleSelector;
  inspectorHost: HTMLElement;
  addModule: (name: string) => string;
  rows: () => HTMLElement[];
  rowNames: () => string[];
}

function setup(): Harness {
  const eventBus = new EventBus();
  const scene = new THREE.Scene();
  const sceneManager = new SceneManager(scene);
  const selection = new SelectionManager(
    eventBus,
    scene,
    (id) => sceneManager.getObject(id),
    (id) => sceneManager.getObject(id)?.name ?? id,
  );
  const displayAdapter = new DisplayAdapter(sceneManager);
  const transformService = new TransformService(eventBus, sceneManager);

  // Same routing as main.ts
  const router = new CommandRouter(eventBus);
  router.onSelection((cmd) => selection.select(cmd.objectId));

  const inspectorHost = document.createElement('footer');
  inspectorHost.className = 'inspector-region';
  document.body.appendChild(inspectorHost);
  new Inspector(eventBus, displayAdapter, inspectorHost, transformService);

  const selector = new ManualModuleSelector(eventBus, displayAdapter, inspectorHost);

  const addModule = (name: string): string =>
    sceneManager.addObject(
      new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial()),
      name,
    );

  const rows = (): HTMLElement[] =>
    Array.from(document.querySelectorAll('.manual-module-selector__row'));

  return {
    eventBus,
    scene,
    sceneManager,
    selection,
    displayAdapter,
    transformService,
    selector,
    inspectorHost,
    addModule,
    rows,
    rowNames: () => rows().map((r) => r.querySelector('.manual-module-selector__name')!.textContent ?? ''),
  };
}

let h: Harness;

beforeEach(() => {
  document.body.innerHTML = '';
  h = setup();
});

afterEach(() => {
  h.selector.close();
  document.body.innerHTML = '';
});

// ─── Listing ─────────────────────────────────────────────

describe('ManualModuleSelector — listing', () => {
  it('lists exactly the modules present in the scene', () => {
    h.addModule('door');
    h.addModule('gate');
    h.selector.openPanel();

    expect(h.selector.isOpen).toBe(true);
    expect(h.rowNames()).toEqual(['door', 'gate']);
  });

  it('does not show placeholder or asset-library-only entries', () => {
    h.selector.openPanel();
    expect(h.rows()).toHaveLength(0);
    expect(document.querySelector('.manual-module-selector__popup')!.textContent).not.toMatch(/select|choose/i);
  });

  it('shows an empty state for an empty scene without errors', () => {
    h.selector.openPanel();

    const empty = document.querySelector('.manual-module-selector__empty') as HTMLElement;
    expect(empty.textContent).toBe('No modules in scene');
    expect(empty.style.display).toBe('flex');
    expect(h.rows()).toHaveLength(0);
  });

  it('hides objects that are not visible in the scene', () => {
    const id = h.addModule('hidden-thing');
    h.sceneManager.getObject(id)!.visible = false;
    h.selector.openPanel();

    expect(h.rowNames()).not.toContain('hidden-thing');
  });

  it('reflects added and removed modules on refresh', () => {
    h.addModule('alpha');
    h.selector.openPanel();
    expect(h.rowNames()).toEqual(['alpha']);

    const b = h.addModule('beta');
    h.selector.refresh();
    expect(h.rowNames()).toEqual(['alpha', 'beta']);

    h.sceneManager.removeObject(b);
    h.selector.refresh();
    expect(h.rowNames()).toEqual(['alpha']);
  });

  it('names entries exactly like the CV module list view model', () => {
    h.addModule('alpha');
    h.addModule('beta');
    h.selector.openPanel();

    // One shared source of truth: DisplayAdapter → SceneObjectRecord.name
    expect(h.rowNames()).toEqual(
      h.displayAdapter.getModuleListItems(null).map((item) => item.displayName),
    );
  });
});

// ─── Selection ───────────────────────────────────────────

describe('ManualModuleSelector — selection', () => {
  it('selects through the established selection pipeline on click', () => {
    const id = h.addModule('door');
    h.selector.openPanel();

    h.rows()[0].click();

    expect(h.selection.selectedId).toBe(id);
    expect(h.selection.getState().displayName).toBe('door');
  });

  it('resolves the correct object when display names are duplicated', () => {
    const first = h.addModule('bridge');
    const second = h.addModule('bridge');
    h.selector.openPanel();

    const rows = h.rows();
    expect(rows).toHaveLength(2);
    expect(rows[0].dataset.objectId).toBe(first);
    expect(rows[1].dataset.objectId).toBe(second);
    // Duplicates are disambiguated visually by the stable object id
    expect(rows[1].querySelector('.manual-module-selector__id')!.textContent).toBe(second);

    rows[1].click();
    expect(h.selection.selectedId).toBe(second);

    rows[0].click();
    expect(h.selection.selectedId).toBe(first);
  });

  it('adds the viewport highlight for the selected object', () => {
    const id = h.addModule('door');
    h.selector.openPanel();
    h.rows()[0].click();

    const highlight = h.scene.children.find(
      (child) => child.name === `__highlight_${id}__`,
    );
    expect(highlight).toBeDefined();
  });

  it('updates the Inspector with the selected module', () => {
    h.addModule('door');
    h.selector.openPanel();
    h.rows()[0].click();

    expect(h.inspectorHost.querySelector('.inspector-module-name')!.textContent).toBe('door');
    const moveX = h.inspectorHost.querySelector(
      '.inspector-input[data-property="position"][data-axis="x"]',
    ) as HTMLInputElement;
    expect(moveX.value).toBe('0.00');
  });

  it('marks the current entry as selected', () => {
    h.addModule('door');
    h.addModule('gate');
    h.selector.openPanel();

    h.rows()[1].click();

    const rows = h.rows();
    expect(rows[0].classList.contains('manual-module-selector__row--selected')).toBe(false);
    expect(rows[1].classList.contains('manual-module-selector__row--selected')).toBe(true);
    expect(rows[1].getAttribute('aria-selected')).toBe('true');
  });

  it('keeps object transforms untouched by selection', () => {
    const id = h.addModule('door');
    const obj = h.sceneManager.getObject(id)!;
    obj.position.set(2, 3, 4);
    obj.rotation.set(0.5, 0.25, 0.1);
    obj.scale.set(1.5, 1.5, 1.5);

    h.selector.openPanel();
    h.rows()[0].click();

    expect(obj.position.toArray()).toEqual([2, 3, 4]);
    expect(obj.rotation.x).toBeCloseTo(0.5);
    expect(obj.scale.toArray()).toEqual([1.5, 1.5, 1.5]);
  });

  it('works with mouse clicks alone — no CV engine is involved', () => {
    const id = h.addModule('door');
    h.selector.openPanel();
    h.rows()[0].click();

    // Selection happened purely through DOM click → command → SelectionManager
    expect(h.selection.selectedId).toBe(id);
    expect(h.displayAdapter.getModuleListItems(id)[0].isSelected).toBe(true);
  });
});

// ─── Sync with the CV selector ───────────────────────────

describe('ManualModuleSelector — shared selection state', () => {
  it('reflects a selection made by the CV Module Selection UI', () => {
    const id = h.addModule('door');
    h.selector.openPanel();

    // Exactly what the CV Module Selection grid emits on hold-confirm
    const cmd: SelectionCommand = {
      commandId: 'cv-sel-1',
      objectId: id,
      source: 'MODULE_SELECTION_UI',
    };
    h.eventBus.emit('ui:selection-command', cmd);

    const row = h.rows()[0];
    expect(row.classList.contains('manual-module-selector__row--selected')).toBe(true);
    expect(h.selection.selectedId).toBe(id);
  });

  it('selection made manually is visible to the CV module list view model', () => {
    const id = h.addModule('door');
    h.selector.openPanel();
    h.rows()[0].click();

    const items = h.displayAdapter.getModuleListItems(h.selection.selectedId);
    expect(items.find((i) => i.objectId === id)?.isSelected).toBe(true);
  });

  it('drops a stale selected entry when the object is deleted', () => {
    const id = h.addModule('door');
    h.selector.openPanel();
    h.rows()[0].click();

    h.sceneManager.removeObject(id);
    h.selection.select(null);
    h.selector.refresh();

    expect(h.rows()).toHaveLength(0);
    expect(document.querySelector('.manual-module-selector__empty') as HTMLElement).toBeTruthy();
    expect((document.querySelector('.manual-module-selector__empty') as HTMLElement).style.display).toBe('flex');
  });
});

// ─── Open / close lifecycle ──────────────────────────────

describe('ManualModuleSelector — open/close lifecycle', () => {
  it('toggles closed and open via the button', () => {
    h.addModule('door');
    const button = document.querySelector('.manual-module-selector__button') as HTMLButtonElement;

    button.click();
    expect(h.selector.isOpen).toBe(true);
    expect(button.getAttribute('aria-expanded')).toBe('true');

    button.click();
    expect(h.selector.isOpen).toBe(false);
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  it('closes on Escape', () => {
    h.selector.openPanel();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(h.selector.isOpen).toBe(false);
  });

  it('closes when the user clicks outside', () => {
    h.selector.openPanel();
    const outside = document.createElement('div');
    document.body.appendChild(outside);
    outside.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(h.selector.isOpen).toBe(false);
  });

  it('stays open when clicking inside the popup', () => {
    h.addModule('door');
    h.selector.openPanel();
    h.rows()[0].dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(h.selector.isOpen).toBe(true);
  });

  it('does not accumulate rows or duplicate selection commands on reopen', () => {
    const id = h.addModule('door');
    let commands = 0;
    h.eventBus.on('ui:selection-command', () => {
      commands += 1;
    });

    h.selector.openPanel();
    h.selector.close();
    h.selector.openPanel();
    h.selector.close();
    h.selector.openPanel();

    expect(h.rows()).toHaveLength(1);
    h.rows()[0].click();
    expect(commands).toBe(1);
    expect(h.selection.selectedId).toBe(id);
  });

  it('does not duplicate entry clicks after several open/close cycles', () => {
    h.addModule('door');
    h.addModule('gate');

    for (let i = 0; i < 3; i++) {
      h.selector.openPanel();
      h.selector.close();
    }
    h.selector.openPanel();

    h.rows()[1].click();
    expect(h.rows()).toHaveLength(2);
    expect(h.rows()[1].getAttribute('aria-selected')).toBe('true');
  });
});
