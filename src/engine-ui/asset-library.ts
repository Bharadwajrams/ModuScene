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

// ─── Search ──────────────────────────────────────────────

/**
 * Normalize a user query for case-insensitive substring matching.
 * Whitespace-only input normalizes to '' (= unfiltered), so a stray space
 * can never hide the whole catalog.
 */
export function normalizeAssetQuery(query: string): string {
  return query.trim().toLowerCase();
}

/**
 * Assets whose displayed name contains `query` as a case-insensitive
 * substring, in their catalog order.
 *
 * Matching runs on `name`, which is the filename without its `.glb`/`.gltf`
 * extension (see AssetManager.importAsset) — so `Grou` finds
 * `Ground_Tile.glb` and typing the extension is never required. This is a
 * plain in-memory scan: nothing is loaded, cloned or re-parsed to filter.
 */
export function filterAssets(assets: AssetRecord[], query: string): AssetRecord[] {
  const needle = normalizeAssetQuery(query);
  if (needle === '') return assets;
  return assets.filter((asset) => asset.name.toLowerCase().includes(needle));
}

// ─── Asset Library ───────────────────────────────────────

export class AssetLibrary {
  private container: HTMLElement;
  private searchEl: HTMLInputElement;
  private listEl: HTMLElement;
  private emptyEl: HTMLElement;
  private noResultsEl: HTMLElement;
  private assets: AssetRecord[] = [];
  private query = '';
  private onAddToScene: ((assetId: AssetId) => void) | null = null;

  constructor(_eventBus: EventBus, container: HTMLElement) {
    this.container = container;
    this.container.classList.add('asset-library-panel__content');

    // Search field at the top of the panel. It filters this list only — it
    // never touches the scene, the selection or the loaded GLTF cache.
    this.searchEl = document.createElement('input');
    this.searchEl.type = 'search';
    this.searchEl.className = 'asset-library-panel__search';
    this.searchEl.placeholder = 'Search assets...';
    this.searchEl.setAttribute('aria-label', 'Search assets');
    this.searchEl.addEventListener('input', () => {
      this.query = this.searchEl.value;
      this.render();
    });

    this.listEl = document.createElement('div');
    this.listEl.className = 'asset-library-panel__list';

    this.emptyEl = document.createElement('div');
    this.emptyEl.className = 'asset-library-panel__empty';
    this.emptyEl.textContent = 'No assets imported';

    this.noResultsEl = document.createElement('div');
    this.noResultsEl.className = 'asset-library-panel__empty';
    this.noResultsEl.textContent = 'No matching assets found';
    this.noResultsEl.style.display = 'none';

    this.container.appendChild(this.searchEl);
    this.container.appendChild(this.listEl);
    this.container.appendChild(this.emptyEl);
    this.container.appendChild(this.noResultsEl);

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

    // Filter first, then paint: the two sections below keep their existing
    // order and headers, but describe only what matched.
    const matches = filterAssets(this.assets, this.query);
    const searching = normalizeAssetQuery(this.query) !== '';

    // Built-in basic shapes render in their own section above the imports;
    // everything else keeps the existing flat imported list.
    const shapes = matches.filter((a) => a.sourceType === 'PRIMITIVE');
    const imports = matches.filter((a) => a.sourceType !== 'PRIMITIVE');

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
      this.noResultsEl.style.display = 'none';
      this.listEl.style.display = 'none';
      return;
    }

    // A query that matches nothing gets its own message, so it is never
    // confused with an empty catalog.
    if (searching && matches.length === 0) {
      this.emptyEl.style.display = 'none';
      this.noResultsEl.style.display = 'flex';
      this.listEl.style.display = 'none';
      return;
    }

    this.noResultsEl.style.display = 'none';

    // With built-in shapes present the list always has content; the "no
    // assets imported" hint only makes sense when there are no IMPORTS.
    this.emptyEl.style.display = !searching && imports.length === 0 ? 'flex' : 'none';
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
