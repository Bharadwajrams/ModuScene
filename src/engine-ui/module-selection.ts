/**
 * Module Builder V1.1 — Module Selection
 *
 * Renders the currently loaded scene modules as a responsive grid of
 * interactive cells (multiple columns and rows inside the existing dropdown).
 * The module cell ITSELF is the interaction area:
 *
 *   hover          → highlight (handled via pointer processor → --hovered)
 *   ~1 s hold      → module is selected (confirm ring drawn by CVWorkspace)
 *   selected       → persistent green highlight (until another is selected)
 *
 * There is deliberately NO per-module "Select" button — the 1-second
 * hold/confirmation mechanism is the only selection path.
 *
 * Source of truth: Doc 02 §4.1, Doc 02 §6, Doc 05 §15.1
 */

import type { ModuleListItem, ObjectId, SelectionCommand } from '../core/contracts';
import { EventBus } from '../core/event-bus';
import { DisplayAdapter } from '../engine-3d/display-adapter';

/** How long the green flash stays on a cell after hold confirmation. */
const SELECTED_FLASH_MS = 450;

// ─── Module Selection ────────────────────────────────────

export class ModuleSelection {
  private eventBus: EventBus;
  private displayAdapter: DisplayAdapter;
  private panel: HTMLElement;
  private listContainer: HTMLElement;
  private emptyState: HTMLElement;
  private currentItems: ModuleListItem[] = [];
  private selectedId: ObjectId | null = null;

  /** objectId of the cell showing its post-confirmation flash (→ timeout id) */
  private flashTimeouts = new Map<ObjectId, number>();

  constructor(
    eventBus: EventBus,
    displayAdapter: DisplayAdapter,
    panel: HTMLElement,
  ) {
    this.eventBus = eventBus;
    this.displayAdapter = displayAdapter;
    this.panel = panel;

    // Setup panel structure
    this.panel.className = 'cv-module-selection';

    const header = document.createElement('div');
    header.className = 'cv-module-selection__header';
    header.textContent = 'MODULE SELECTION';

    this.listContainer = document.createElement('div');
    this.listContainer.className = 'cv-module-selection__list';

    this.emptyState = document.createElement('div');
    this.emptyState.className = 'cv-module-selection__empty';
    this.emptyState.textContent = 'No modules loaded';

    this.panel.appendChild(header);
    this.panel.appendChild(this.listContainer);
    this.panel.appendChild(this.emptyState);
  }

  /**
   * Refresh the module list from the CURRENT scene state.
   * The list always mirrors what is actually present in the 3D viewport —
   * modules added to the scene appear automatically, removed ones disappear.
   * Keeps the previous selection when none is supplied (so a rebuild caused
   * by scene churn does not drop the green selected state).
   */
  refresh(): void {
    this.renderList(this.selectedId);
  }

  /**
   * Refresh with a specific selected ID (selection actually changed).
   * Marks the confirmed module for a short green flash so the 1-second hold
   * visibly "lands" on the cell that earned the selection.
   */
  refreshWithSelection(selectedId: ObjectId | null): void {
    const justConfirmed =
      selectedId !== null && selectedId !== this.selectedId && this.hasCell(selectedId);
    this.selectedId = selectedId;
    this.renderList(selectedId);
    if (justConfirmed) this.flashSelected(selectedId as ObjectId);
  }

  private hasCell(objectId: ObjectId): boolean {
    return this.listContainer.querySelector(`[data-object-id="${objectId}"]`) !== null;
  }

  /**
   * Brief green flash on the freshly confirmed cell. Purely visual feedback
   * for the hold confirmation — the persistent state is --selected.
   */
  private flashSelected(objectId: ObjectId): void {
    const existing = this.flashTimeouts.get(objectId);
    if (existing !== undefined) window.clearTimeout(existing);

    const cell = this.listContainer.querySelector(
      `[data-object-id="${objectId}"]`,
    ) as HTMLElement | null;
    if (cell) {
      cell.classList.add('cv-module-row--just-selected');
      this.flashTimeouts.set(
        objectId,
        window.setTimeout(() => {
          cell.classList.remove('cv-module-row--just-selected');
          this.flashTimeouts.delete(objectId);
        }, SELECTED_FLASH_MS),
      );
    }
  }

  private renderList(selectedId: ObjectId | null): void {
    // Read the live module list from the 3D scene — the single source of
    // truth. No placeholder or hard-coded module names anywhere in this path.
    this.currentItems = this.displayAdapter.getModuleListItems(selectedId);

    this.listContainer.innerHTML = '';

    if (this.currentItems.length === 0) {
      this.emptyState.style.display = 'flex';
      this.listContainer.style.display = 'none';
      return;
    }

    this.emptyState.style.display = 'none';
    this.listContainer.style.display = 'grid';

    for (const item of this.currentItems) {
      const cell = this.createModuleCell(item);
      this.listContainer.appendChild(cell);
    }
  }

  /**
   * One grid cell = one module = the whole interaction area.
   * Primary path (CV hand pointer): hover → highlight, ~1 s hold → select,
   * both driven by the CV pointer processor via row hit-testing.
   * Secondary path (mouse): clicking the cell emits the exact same
   * selection command the old per-row Select button did.
   */
  private createModuleCell(item: ModuleListItem): HTMLElement {
    const cell = document.createElement('div');
    cell.className = `cv-module-row ${item.isSelected ? 'cv-module-row--selected' : ''}`;
    cell.dataset.objectId = item.objectId;
    cell.addEventListener('click', () => this.selectModule(item.objectId));

    // Hold-ring slot: pre-created so CVWorkspace.setModuleHoldProgress()
    // only toggles --hold-progress (no DOM mutation mid-hold, so the grid
    // never reflows while the 1-second confirmation is running).
    const ring = document.createElement('div');
    ring.className = 'cv-module-row__holdring';
    ring.style.setProperty('--hold-progress', '0');

    const nameSpan = document.createElement('span');
    nameSpan.className = 'cv-module-row__name';
    nameSpan.textContent = item.displayName;

    cell.appendChild(ring);
    cell.appendChild(nameSpan);
    return cell;
  }

  private selectModule(objectId: ObjectId): void {
    const cmd: SelectionCommand = {
      commandId: `module-sel-${Date.now()}`,
      objectId,
      source: 'MODULE_SELECTION_UI',
    };

    this.eventBus.emit('ui:selection-command', cmd);
  }
}
