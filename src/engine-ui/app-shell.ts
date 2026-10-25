/**
 * Module Builder V1.1 — Application Shell
 *
 * Owns the top-level layout: Main Workspace (3D + CV regions)
 * and Bottom Inspector. Handles CV toggle state.
 *
 * Source of truth: Doc 02 §2, Doc 04 §12
 */

import type { CVWorkspaceState } from '../core/contracts';
import { EventBus } from '../core/event-bus';

// ─── Layout Classes ──────────────────────────────────────

const LAYOUT_CLASSES = {
  cvClosed: 'layout--cv-closed',
  cvOpen: 'layout--cv-open',
} as const;

// ─── App Shell ───────────────────────────────────────────

export class AppShell {
  private eventBus: EventBus;
  private root: HTMLElement;
  private workspaceEl!: HTMLElement;
  private viewportRegion!: HTMLElement;
  private cvRegion!: HTMLElement;
  private inspectorRegion!: HTMLElement;
  private cvToggleBtn!: HTMLElement;
  private cvState: CVWorkspaceState = 'CLOSED';
  private assetLibraryToggleBtn!: HTMLElement;
  private assetLibraryPanel!: HTMLElement;
  private assetLibraryContainer!: HTMLElement;
  private assetLibraryOpen = false;

  constructor(eventBus: EventBus, root: HTMLElement) {
    this.eventBus = eventBus;
    this.root = root;
    this.setupLayout();
    this.setupEventListeners();
  }

  private setupLayout(): void {
    // Clear the root
    this.root.innerHTML = '';
    this.root.classList.add('app-root');

    // ── Header / Toolbar ────────────────────────────────
    const header = document.createElement('header');
    header.className = 'app-header';

    const title = document.createElement('h1');
    title.className = 'app-title';
    title.textContent = 'ModuScene';

    this.cvToggleBtn = document.createElement('button');
    this.cvToggleBtn.className = 'cv-toggle-btn';
    this.cvToggleBtn.textContent = 'Enable CV';
    this.cvToggleBtn.title = 'Toggle Computer Vision workspace';
    this.cvToggleBtn.addEventListener('click', () => this.toggleCV());

    header.appendChild(title);
    header.appendChild(this.cvToggleBtn);

    // ── Main Workspace ──────────────────────────────────
    this.workspaceEl = document.createElement('main');
    this.workspaceEl.className = `app-workspace ${LAYOUT_CLASSES.cvClosed}`;

    this.viewportRegion = document.createElement('section');
    this.viewportRegion.className = 'viewport-region';
    this.viewportRegion.id = 'viewport-region';

    // Asset Library panel (left side, over viewport)
    this.assetLibraryPanel = document.createElement('aside');
    this.assetLibraryPanel.className = 'asset-library-panel asset-library-panel--collapsed';
    this.assetLibraryPanel.id = 'asset-library-panel';

    // Toggle button inside the panel (pinned to left edge of viewport)
    this.assetLibraryToggleBtn = document.createElement('button');
    this.assetLibraryToggleBtn.className = 'asset-library-toggle asset-library-toggle--collapsed';
    this.assetLibraryToggleBtn.title = 'Toggle Asset Library';
    this.assetLibraryToggleBtn.innerHTML = `
      <svg class="asset-library-toggle__icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="3" width="7" height="7"/>
        <rect x="14" y="3" width="7" height="7"/>
        <rect x="3" y="14" width="7" height="7"/>
        <rect x="14" y="14" width="7" height="7"/>
      </svg>
      <span class="asset-library-toggle__label">Assets</span>
      <span class="asset-library-toggle__close">&times;</span>
    `;
    this.assetLibraryToggleBtn.addEventListener('click', () => this.toggleAssetLibrary());

    this.assetLibraryContainer = document.createElement('div');
    this.assetLibraryContainer.className = 'asset-library-panel__content';

    this.assetLibraryPanel.appendChild(this.assetLibraryToggleBtn);
    this.assetLibraryPanel.appendChild(this.assetLibraryContainer);

    this.cvRegion = document.createElement('section');
    this.cvRegion.className = 'cv-region';
    this.cvRegion.id = 'cv-region';
    this.cvRegion.style.display = 'none';

    // Asset library overlays the viewport — panel as child of viewport region
    this.viewportRegion.appendChild(this.assetLibraryPanel);

    // Toggle button pinned to viewport region (not the panel) so it's
    // always visible regardless of panel collapsed/expanded state
    this.viewportRegion.appendChild(this.assetLibraryToggleBtn);

    this.workspaceEl.appendChild(this.viewportRegion);
    this.workspaceEl.appendChild(this.cvRegion);

    // ── Bottom Inspector ────────────────────────────────
    this.inspectorRegion = document.createElement('footer');
    this.inspectorRegion.className = 'inspector-region';
    this.inspectorRegion.id = 'inspector-region';

    // ── Assemble ────────────────────────────────────────
    this.root.appendChild(header);
    this.root.appendChild(this.workspaceEl);
    this.root.appendChild(this.inspectorRegion);
  }

  private setupEventListeners(): void {
    this.eventBus.on('cv:workspace-toggle', (state) => {
      this.setCVState(state);
    });
  }

  /**
   * Toggle CV workspace open/closed.
   */
  toggleCV(): void {
    const newState: CVWorkspaceState = this.cvState === 'CLOSED' ? 'OPEN' : 'CLOSED';
    this.setCVState(newState);
    this.eventBus.emit('cv:workspace-toggle', newState);
  }

  /**
   * Set CV workspace state programmatically.
   */
  setCVState(state: CVWorkspaceState): void {
    this.cvState = state;

    if (state === 'OPEN') {
      this.workspaceEl.classList.remove(LAYOUT_CLASSES.cvClosed);
      this.workspaceEl.classList.add(LAYOUT_CLASSES.cvOpen);
      this.cvRegion.style.display = 'flex';
      this.updateCVToggleText();
    } else {
      this.workspaceEl.classList.remove(LAYOUT_CLASSES.cvOpen);
      this.workspaceEl.classList.add(LAYOUT_CLASSES.cvClosed);
      this.cvRegion.style.display = 'none';
      this.updateCVToggleText();
    }

    // Notify 3D engine to update renderer size after layout change
    // A small delay to allow CSS to settle
    requestAnimationFrame(() => {
      window.dispatchEvent(new Event('resize'));
    });
  }

  private updateCVToggleText(): void {
    this.cvToggleBtn.textContent = this.cvState === 'CLOSED' ? 'Enable CV' : 'Disable CV';
    this.cvToggleBtn.classList.toggle('cv-toggle-btn--active', this.cvState === 'OPEN');
  }

  /** Get references to layout regions */
  getViewportRegion(): HTMLElement {
    return this.viewportRegion;
  }

  getCVRegion(): HTMLElement {
    return this.cvRegion;
  }

  toggleAssetLibrary(): void {
    this.assetLibraryOpen = !this.assetLibraryOpen;
    this.setAssetLibraryOpen(this.assetLibraryOpen);
  }

  setAssetLibraryOpen(open: boolean): void {
    this.assetLibraryOpen = open;
    this.assetLibraryPanel.classList.toggle('asset-library-panel--collapsed', !open);
    this.assetLibraryPanel.classList.toggle('asset-library-panel--expanded', open);
    this.assetLibraryToggleBtn.classList.toggle('asset-library-toggle--collapsed', !open);
    this.assetLibraryToggleBtn.classList.toggle('asset-library-toggle--expanded', open);
    this.eventBus.emit('asset-library:toggle', open);
    // Panel is position:absolute overlay — does not affect viewport layout,
    // so no resize dispatch needed. Pointer events toggled for content.
    this.assetLibraryContainer.style.pointerEvents = open ? 'auto' : 'none';
  }

  isAssetLibraryOpen(): boolean {
    return this.assetLibraryOpen;
  }

  getAssetLibraryContainer(): HTMLElement {
    return this.assetLibraryContainer;
  }

  getInspectorRegion(): HTMLElement {
    return this.inspectorRegion;
  }

  /**
   * Small, non-blocking notice (e.g. unresolved textures after a folder
   * import). Auto-dismisses; never blocks the workspace.
   */
  showNotice(message: string, timeoutMs = 9000): void {
    // One notice at a time — a new message replaces the previous one.
    this.root.querySelectorAll('.app-notice').forEach((el) => el.remove());

    const notice = document.createElement('div');
    notice.className = 'app-notice';
    notice.setAttribute('role', 'status');

    const text = document.createElement('span');
    text.className = 'app-notice__text';
    text.textContent = message;

    const close = document.createElement('button');
    close.className = 'app-notice__close';
    close.type = 'button';
    close.title = 'Dismiss';
    close.textContent = '\u00d7';
    close.addEventListener('click', () => notice.remove());

    notice.appendChild(text);
    notice.appendChild(close);
    this.root.appendChild(notice);

    window.setTimeout(() => notice.remove(), timeoutMs);
  }

  /** Get current CV state */
  getCVState(): CVWorkspaceState {
    return this.cvState;
  }
}
