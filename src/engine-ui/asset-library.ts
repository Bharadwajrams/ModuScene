/**
 * Module Builder V1.1 — Asset Library
 *
 * Displays imported/available modules for reuse.
 * Shows each imported asset and allows adding instances to the scene.
 *
 * Source of truth: Doc 01 §14 ("Maintain an asset library for imported/available modules")
 */

import type { AssetRecord, AssetId } from '../core/contracts';
import { EventBus } from '../core/event-bus';

// ─── Asset Library ───────────────────────────────────────

export class AssetLibrary {
  private container: HTMLElement;
  private listEl: HTMLElement;
  private emptyEl: HTMLElement;
  private assets: AssetRecord[] = [];
  private onAddToScene: ((assetId: AssetId) => void) | null = null;

  constructor(_eventBus: EventBus, container: HTMLElement) {
    this.container = container;
    this.container.classList.add('asset-library-panel__content');

    this.listEl = document.createElement('div');
    this.listEl.className = 'asset-library-panel__list';

    this.emptyEl = document.createElement('div');
    this.emptyEl.className = 'asset-library-panel__empty';
    this.emptyEl.textContent = 'No assets imported';

    this.container.appendChild(this.listEl);
    this.container.appendChild(this.emptyEl);

    // Listen for open/close to show/hide empty state appropriately
    _eventBus.on('asset-library:toggle', (open: boolean) => {
      if (!open && this.assets.length === 0) {
        // When collapsed, hide empty state; it will show when expanded
      }
    });
  }

  /**
   * Register callback for adding an asset instance to the scene.
   */
  onAdd(callback: (assetId: AssetId) => void): void {
    this.onAddToScene = callback;
  }

  /**
   * Refresh the library with current assets.
   */
  refresh(assets: AssetRecord[]): void {
    this.assets = assets;
    this.render();
  }

  private render(): void {
    this.listEl.innerHTML = '';

    // Built-in basic shapes render in their own section above the imports;
    // everything else keeps the existing flat imported list.
    const shapes = this.assets.filter((a) => a.sourceType === 'PRIMITIVE');
    const imports = this.assets.filter((a) => a.sourceType !== 'PRIMITIVE');

    if (shapes.length > 0) {
      const header = document.createElement('div');
      header.className = 'asset-library-panel__section';
      header.textContent = 'Basic Shapes';
      this.listEl.appendChild(header);
      for (const asset of shapes) this.listEl.appendChild(this.createRow(asset));
    }

    if (imports.length > 0) {
      const header = document.createElement('div');
      header.className = 'asset-library-panel__section';
      header.textContent = 'Imported';
      this.listEl.appendChild(header);
      for (const asset of imports) this.listEl.appendChild(this.createRow(asset));
    }

    if (this.assets.length === 0) {
      this.emptyEl.style.display = 'flex';
      this.listEl.style.display = 'none';
      return;
    }

    // With built-in shapes present the list always has content; the "no
    // assets imported" hint only makes sense when there are no IMPORTS.
    this.emptyEl.style.display = imports.length === 0 ? 'flex' : 'none';
    this.listEl.style.display = 'flex';
  }

  /** One asset row: status dot, name, and the add-to-scene button. */
  private createRow(asset: AssetRecord): HTMLElement {
    const row = document.createElement('div');
    row.className = 'asset-library-panel__row';

    const info = document.createElement('div');
    info.className = 'asset-library-panel__info';

    const name = document.createElement('span');
    name.className = 'asset-library-panel__name';
    name.textContent = asset.name;

    const status = document.createElement('span');
    status.className = 'asset-library-panel__status';
    status.textContent = asset.loadStatus === 'AVAILABLE' ? '●' : asset.loadStatus === 'LOADING' ? '○' : '✗';
    status.title = asset.loadStatus;

    info.appendChild(status);
    info.appendChild(name);

    const addBtn = document.createElement('button');
    addBtn.className = 'asset-library-panel__add';
    addBtn.textContent = '+';
    addBtn.title = 'Add instance to scene';
    addBtn.disabled = asset.loadStatus !== 'AVAILABLE';
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.onAddToScene) {
        this.onAddToScene(asset.assetId);
      }
    });

    row.appendChild(info);
    row.appendChild(addBtn);
    return row;
  }
}
