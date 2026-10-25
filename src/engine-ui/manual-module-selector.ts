/**
 * Module Builder V1.2 — Manual Module Selector
 *
 * Mouse-operated sibling of the CV Module Selection panel, docked at the far
 * right of the bottom Inspector bar. It lists the modules that are ACTUALLY
 * present in the 3D scene and selects them on click.
 *
 * Presentation only:
 *   - the list view model comes from DisplayAdapter.getModuleListItems() —
 *     the exact same source the CV Module Selection grid renders, so there is
 *     no second module registry and nothing can go stale
 *   - selection is REQUESTED by emitting the existing `ui:selection-command`,
 *     which CommandRouter forwards to SelectionManager (the single authority)
 *   - selected state is mirrored from `selection:changed`, so mouse and CV
 *     selection always agree
 *   - a checkbox per row builds a GROUP for movement only. Group ids are
 *     pruned against the live scene list on every render, so a removed
 *     module can never keep travelling
 *   - no Three.js, gesture, CV or pointer-ownership code is touched
 *
 * Source of truth: Doc 02 §4.1, Doc 05 §15.1 (Module Selection), Doc 04 §9
 */

import type {
  ModuleListItem,
  ObjectId,
  SelectionCommand,
} from '../core/contracts';
import { EventBus } from '../core/event-bus';
import { DisplayAdapter } from '../engine-3d/display-adapter';

// ─── Manual Module Selector ──────────────────────────────

export class ManualModuleSelector {
  private eventBus: EventBus;
  private displayAdapter: DisplayAdapter;
  private root: HTMLElement;
  private button: HTMLButtonElement;
  private popup: HTMLElement;
  private listEl: HTMLElement;
  private emptyEl: HTMLElement;
  private currentItems: ModuleListItem[] = [];
  private selectedId: ObjectId | null = null;
  /** Modules checked for group movement (movement only — never rotation/scale). */
  private checkedIds = new Set<ObjectId>();
  private open = false;
  private commandSeq = 0;

  // Bound so they can be removed again — the document listeners exist ONLY
  // while the popup is open (reopening must not stack handlers).
  private readonly onDocumentPointerDown = (event: Event): void => {
    const target = event.target as Node | null;
    if (target && this.root.contains(target)) return;
    if (target && this.popup.contains(target)) return;
    this.close();
  };

  private readonly onDocumentKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      this.close();
      this.button.focus();
    }
  };

  private readonly onViewportChange = (): void => {
    if (this.open) this.positionPopup();
  };

  constructor(eventBus: EventBus, displayAdapter: DisplayAdapter, host: HTMLElement) {
    this.eventBus = eventBus;
    this.displayAdapter = displayAdapter;

    // ── Trigger (right end of the Inspector bar) ────────
    this.root = document.createElement('div');
    this.root.className = 'manual-module-selector';

    this.button = document.createElement('button');
    this.button.type = 'button';
    this.button.className = 'manual-module-selector__button';
    this.button.setAttribute('aria-haspopup', 'listbox');
    this.button.setAttribute('aria-expanded', 'false');
    this.button.title = 'Select a module in the scene';
    this.button.innerHTML = `
      <svg class="manual-module-selector__icon" viewBox="0 0 24 24" width="14" height="14"
           fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="3" width="7" height="7"/>
        <rect x="14" y="3" width="7" height="7"/>
        <rect x="3" y="14" width="7" height="7"/>
        <rect x="14" y="14" width="7" height="7"/>
      </svg>
      <span class="manual-module-selector__label">Module Selector</span>
    `;
    this.button.addEventListener('click', () => this.toggle());

    this.root.appendChild(this.button);
    host.appendChild(this.root);

    // ── Popup (fixed, so the Inspector's scroll container never clips it) ──
    this.popup = document.createElement('div');
    this.popup.className = 'manual-module-selector__popup';
    this.popup.setAttribute('role', 'listbox');
    this.popup.setAttribute('aria-label', 'Modules in scene');
    this.popup.hidden = true;

    const header = document.createElement('div');
    header.className = 'manual-module-selector__header';
    header.textContent = 'SCENE MODULES';

    this.listEl = document.createElement('div');
    this.listEl.className = 'manual-module-selector__list';

    this.emptyEl = document.createElement('div');
    this.emptyEl.className = 'manual-module-selector__empty';
    this.emptyEl.textContent = 'No modules in scene';

    this.popup.appendChild(header);
    this.popup.appendChild(this.listEl);
    this.popup.appendChild(this.emptyEl);
    document.body.appendChild(this.popup);

    // ── Selection mirror (single authority = SelectionManager) ──
    this.eventBus.on('selection:changed', (event) => {
      this.selectedId = event.objectId;
      // Re-read from the scene even while closed, so the markup can never
      // describe a selection that has since changed (mouse or CV).
      this.renderList();
      this.updateButtonState();
    });

    this.renderList();
  }

  // ─── Open / close ────────────────────────────────────

  get isOpen(): boolean {
    return this.open;
  }

  toggle(): void {
    if (this.open) this.close();
    else this.openPanel();
  }

  openPanel(): void {
    if (this.open) return;
    this.open = true;

    // Always rebuild from the live scene before showing, so the list can
    // never display stale entries.
    this.renderList();

    this.popup.hidden = false;
    this.button.setAttribute('aria-expanded', 'true');
    this.root.classList.add('manual-module-selector--open');
    this.positionPopup();

    document.addEventListener('pointerdown', this.onDocumentPointerDown, true);
    document.addEventListener('keydown', this.onDocumentKeyDown, true);
    window.addEventListener('resize', this.onViewportChange);
    window.addEventListener('scroll', this.onViewportChange, true);
  }

  close(): void {
    if (!this.open) return;
    this.open = false;

    this.popup.hidden = true;
    this.button.setAttribute('aria-expanded', 'false');
    this.root.classList.remove('manual-module-selector--open');

    document.removeEventListener('pointerdown', this.onDocumentPointerDown, true);
    document.removeEventListener('keydown', this.onDocumentKeyDown, true);
    window.removeEventListener('resize', this.onViewportChange);
    window.removeEventListener('scroll', this.onViewportChange, true);
  }

  /**
   * Re-read the module list from the scene. Called by the application at the
   * same points that already refresh the CV Module Selection grid (module
   * added / removed / duplicated / undo / redo), so both selectors describe
   * the same scene.
   */
  refresh(): void {
    this.renderList();
  }

  // ─── List rendering ──────────────────────────────────

  private renderList(): void {
    // Live read — no cached module list anywhere in this path.
    this.currentItems = this.displayAdapter.getModuleListItems(this.selectedId);

    // Group checks follow the scene: an id that is gone (deleted, undone,
    // hidden) is dropped here, so movement can never target a stale module.
    const liveIds = new Set(this.currentItems.map((item) => item.objectId));
    for (const id of [...this.checkedIds]) {
      if (!liveIds.has(id)) this.checkedIds.delete(id);
    }

    this.listEl.innerHTML = '';

    if (this.currentItems.length === 0) {
      this.emptyEl.style.display = 'flex';
      this.listEl.style.display = 'none';
      return;
    }

    this.emptyEl.style.display = 'none';
    this.listEl.style.display = 'flex';

    // Duplicate display names are legal (duplicated modules) — the entry
    // still carries its stable objectId, and the id is shown as a muted
    // suffix so two same-named rows are distinguishable.
    const nameCounts = new Map<string, number>();
    for (const item of this.currentItems) {
      nameCounts.set(item.displayName, (nameCounts.get(item.displayName) ?? 0) + 1);
    }

    for (const item of this.currentItems) {
      this.listEl.appendChild(this.createRow(item, (nameCounts.get(item.displayName) ?? 0) > 1));
    }
  }

  /**
   * Module ids checked for group movement, intersected with the modules that
   * are actually in the scene right now.
   */
  getCheckedObjectIds(): ObjectId[] {
    const liveIds = new Set(
      this.displayAdapter.getModuleListItems(this.selectedId).map((item) => item.objectId),
    );
    return [...this.checkedIds].filter((id) => liveIds.has(id));
  }

  private createRow(item: ModuleListItem, showId: boolean): HTMLElement {
    // The checkbox is a SIBLING of the row button (never nested inside it), so
    // checking a module never triggers the row's single-selection click.
    const wrap = document.createElement('div');
    wrap.className = 'manual-module-selector__item';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'manual-module-selector__checkbox';
    checkbox.checked = this.checkedIds.has(item.objectId);
    checkbox.dataset.objectId = item.objectId;
    checkbox.title = `Move ${item.displayName} with the other checked modules`;
    checkbox.setAttribute('aria-label', `Move ${item.displayName} with checked modules`);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) this.checkedIds.add(item.objectId);
      else this.checkedIds.delete(item.objectId);
    });
    wrap.appendChild(checkbox);

    const row = document.createElement('button');
    row.type = 'button';
    row.className = `manual-module-selector__row${item.isSelected ? ' manual-module-selector__row--selected' : ''}`;
    row.dataset.objectId = item.objectId;
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(item.isSelected));
    row.title = showId ? `${item.displayName} (${item.objectId})` : item.displayName;

    const name = document.createElement('span');
    name.className = 'manual-module-selector__name';
    name.textContent = item.displayName;
    row.appendChild(name);

    if (showId) {
      const id = document.createElement('span');
      id.className = 'manual-module-selector__id';
      id.textContent = item.objectId;
      row.appendChild(id);
    }

    row.addEventListener('click', () => this.selectModule(item.objectId));
    wrap.appendChild(row);
    return wrap;
  }

  /**
   * Request a selection change through the established pipeline.
   * CommandRouter → SelectionManager is the only write path.
   */
  private selectModule(objectId: ObjectId): void {
    const cmd: SelectionCommand = {
      commandId: `manual-sel-${Date.now()}-${this.commandSeq++}`,
      objectId,
      source: 'OTHER_UI',
    };
    this.eventBus.emit('ui:selection-command', cmd);
  }

  private updateButtonState(): void {
    const selected = this.selectedId
      ? this.currentItems.find((i) => i.objectId === this.selectedId)
      : null;
    this.button.classList.toggle('manual-module-selector__button--has-selection', !!selected);
  }

  // ─── Placement ───────────────────────────────────────

  /**
   * Fixed-position the popup above the trigger, right-aligned to it, sized to
   * the space actually available — it stays inside the application viewport
   * regardless of the Inspector's own scroll container.
   */
  private positionPopup(): void {
    const rect = this.button.getBoundingClientRect();
    const viewportWidth = window.innerWidth || 1024;
    const viewportHeight = window.innerHeight || 768;

    const right = Math.max(8, viewportWidth - (rect.right || viewportWidth - 16));
    const spaceAbove = (rect.top || viewportHeight) - 16;

    this.popup.style.right = `${right}px`;
    this.popup.style.bottom = `${Math.max(8, viewportHeight - (rect.top || 0) + 8)}px`;
    this.popup.style.maxHeight = `${Math.max(160, Math.min(320, spaceAbove))}px`;
  }
}
