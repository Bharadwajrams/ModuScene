/**
 * Module Builder V1.1 — CV Workspace Shell
 *
 * Shows/hides the CV workspace; positions video and the two tabs.
 * Contains the CV video, Module Selection and Viewport Control tabs,
 * a visual cursor overlay, and a hand skeleton canvas.
 *
 * Source of truth: Doc 02 §3, Doc 04 §11
 */

import type { UITabState, PointerState, CVInteractionState } from '../core/contracts';
import { EventBus } from '../core/event-bus';
import { createGestureInstructionBar } from './gesture-instruction-bar';

// ─── Hand skeleton connection pairs (MediaPipe indices) ────
const SKELETON_CONNECTIONS: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4],       // Thumb
  [0, 5], [5, 6], [6, 7], [7, 8],       // Index
  [0, 9], [9, 10], [10, 11], [11, 12],  // Middle
  [0, 13], [13, 14], [14, 15], [15, 16], // Ring
  [0, 17], [17, 18], [18, 19], [19, 20], // Pinky
  [5, 9], [9, 13], [13, 17],             // Palm
];

interface HandLandmark {
  x: number;
  y: number;
  z: number;
}

// ─── CV Workspace ────────────────────────────────────────

export class CVWorkspace {
  private container: HTMLElement;
  private videoEl: HTMLVideoElement | null = null;
  private tabContainer: HTMLElement;
  private moduleSelectionTab: HTMLElement;
  private viewportControlTab: HTMLElement;
  private moduleSelectionPanel: HTMLElement;
  private viewportControlPanel: HTMLElement;
  private activeTab: UITabState['activeTab'] = null;

  // Visual tracking overlay
  private cursorEl: HTMLElement;
  private skeletonCanvas: HTMLCanvasElement;
  private skeletonCtx: CanvasRenderingContext2D | null = null;

  // Mode indicator (V2.0): circular confirm ring + persistent active-mode badge
  private modeIndicatorEl: HTMLElement;
  private confirmRingCircle: SVGCircleElement;
  private confirmLabelEl: HTMLElement;
  private activeModeEl: HTMLElement;
  private pausedChipEl: HTMLElement;
  private lastConfirmKey: string | null = null;

  constructor(_eventBus: EventBus, container: HTMLElement) {
    this.container = container;

    // Setup CV video
    this.videoEl = this.createVideo();

    // Setup hand skeleton canvas overlay
    this.skeletonCanvas = document.createElement('canvas');
    this.skeletonCanvas.className = 'cv-skeleton-canvas';
    this.skeletonCtx = this.skeletonCanvas.getContext('2d');

    // Setup cursor overlay
    this.cursorEl = document.createElement('div');
    this.cursorEl.className = 'cv-cursor';
    this.cursorEl.style.display = 'none';

    // Setup mode indicator (centered, non-blocking)
    this.modeIndicatorEl = document.createElement('div');
    this.modeIndicatorEl.className = 'cv-mode-indicator';

    const ringSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    ringSvg.classList.add('cv-mode-indicator__ring');
    ringSvg.setAttribute('viewBox', '0 0 44 44');
    this.confirmRingCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    this.confirmRingCircle.setAttribute('cx', '22');
    this.confirmRingCircle.setAttribute('cy', '22');
    this.confirmRingCircle.setAttribute('r', '18');
    this.confirmRingCircle.setAttribute('fill', 'none');
    this.confirmRingCircle.setAttribute('stroke', 'currentColor');
    this.confirmRingCircle.setAttribute('stroke-width', '3.5');
    this.confirmRingCircle.setAttribute('stroke-linecap', 'round');
    this.confirmRingCircle.setAttribute('transform', 'rotate(-90 22 22)');
    ringSvg.appendChild(this.confirmRingCircle);

    this.confirmLabelEl = document.createElement('div');
    this.confirmLabelEl.className = 'cv-mode-indicator__label';

    this.modeIndicatorEl.appendChild(ringSvg);
    this.modeIndicatorEl.appendChild(this.confirmLabelEl);

    // Persistent active-mode badge (top-center of the CV view)
    this.activeModeEl = document.createElement('div');
    this.activeModeEl.className = 'cv-mode-badge';
    this.activeModeEl.textContent = 'NO MODE';

    // Pause chip (visible only while the left palm pauses a transformation)
    this.pausedChipEl = document.createElement('div');
    this.pausedChipEl.className = 'cv-paused-chip';
    this.pausedChipEl.textContent = '⏸ paused — release left palm to re-anchor';

    // Setup tab controls
    this.tabContainer = document.createElement('div');
    this.tabContainer.className = 'cv-tabs';

    this.moduleSelectionTab = this.createTab('Module Selection', 'MODULE_SELECTION');
    this.moduleSelectionTab.classList.add('cv-tab--ms');
    // Two-line label (left-docked vertical placement): \n breaks the line —
    // .cv-tab--vc sets white-space: pre-line. Same button, same listeners.
    this.viewportControlTab = this.createTab('Viewport\nControl', 'VIEWPORT_CONTROL');

    // Viewport Control is docked OUTSIDE the top tab strip: TOP-LEFT corner,
    // so the left index fingertip reaches it without lowering the hand from
    // its natural UI-pointing posture while the right hand rotates the
    // viewport. The modifier class only positions it — size, style and
    // hover behavior come from .cv-tab unchanged, and getTabBounds() reads
    // the live DOM rect, so the pointer hitbox follows automatically.
    this.viewportControlTab.classList.add('cv-tab--vc');

    // Docked to the TOP-RIGHT corner: positioning ONLY via .cv-tab--ms —
    // size, style and hover behavior come from .cv-tab unchanged, and
    // getTabBounds() reads the live DOM rect, so the pointer hitbox follows
    // automatically.
    this.container.appendChild(this.moduleSelectionTab);

    // Setup panels (hidden by default)
    this.moduleSelectionPanel = this.createPanel('module-selection-panel');
    this.viewportControlPanel = this.createPanel('viewport-control-panel');

    // Presentation-only override: the Viewport Control panel carries a small
    // status chip instead of the large instructional block, so the active
    // context is communicated without covering the viewport. The panel
    // element and its open/close wiring (activation, hover, pointer targets)
    // are unchanged.
    this.viewportControlPanel.classList.add('cv-viewport-control--status');
    this.viewportControlPanel.innerHTML =
      '<span class="cv-viewport-control__status">Viewport Control: ON</span>';

    // Assemble
    this.container.appendChild(this.videoEl);
    this.container.appendChild(this.skeletonCanvas);
    this.container.appendChild(this.cursorEl);
    this.container.appendChild(this.tabContainer);
    this.container.appendChild(this.moduleSelectionPanel);
    this.container.appendChild(this.viewportControlPanel);
    // Appended after the panels so the left-docked tab paints above them
    // if a tall panel ever reaches the middle of the frame.
    this.container.appendChild(this.viewportControlTab);
    this.container.appendChild(this.modeIndicatorEl);
    this.container.appendChild(this.activeModeEl);
    this.container.appendChild(this.pausedChipEl);

    // Compact gesture guide along the bottom of the CV workspace. Inert
    // (pointer-events: none, no listeners) — it only explains the controls
    // the interaction controller already implements. Lives inside the CV
    // region, so CV open/close visibility applies to it automatically.
    this.container.appendChild(createGestureInstructionBar());

    // Hook setActiveTab so listeners (UI-context routing) stay in sync
    // regardless of who calls it (pointer hover, click, engine).
    const originalSetActiveTab = this.setActiveTab.bind(this);
    this.setActiveTab = (tab) => {
      originalSetActiveTab(tab);
      for (const listener of this.activeTabListeners) listener(tab);
    };

    // Resize skeleton canvas on window resize
    this.resizeSkeletonCanvas();
    window.addEventListener('resize', () => this.resizeSkeletonCanvas());
  }

  // ─── Visual Cursor ─────────────────────────────────────

  /**
   * Update the visual cursor position from CV pointer state.
   * Coordinates are normalized [0..1], mapped to CV container space.
   */
  updateCursor(pointer: PointerState | null): void {
    if (!pointer || !pointer.active) {
      this.cursorEl.style.display = 'none';
      return;
    }

    // Pointer arrives in DISPLAY space (producer mirrors camera X so the
    // pointer matches the scaleX(-1) video). Hit-testing, bounds, and the
    // cursor all share this one coordinate space — the previous split
    // (raw pointer vs mirrored cursor) inverted the tab mapping.
    const containerRect = this.container.getBoundingClientRect();
    const px = pointer.x * containerRect.width;
    const py = pointer.y * containerRect.height;

    this.cursorEl.style.display = 'block';
    this.cursorEl.style.left = `${px}px`;
    this.cursorEl.style.top = `${py}px`;
  }

  // ─── Hand Skeleton Drawing ─────────────────────────────

  /**
   * Draw hand skeleton overlay from MediaPipe-style landmarks.
   * Called each frame from the CV engine processing loop.
   */
  drawHandSkeleton(
    rightLandmarks: HandLandmark[] | null,
    leftLandmarks: HandLandmark[] | null,
  ): void {
    if (!this.skeletonCtx) return;

    const canvas = this.skeletonCanvas;
    const ctx = this.skeletonCtx;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Muted tracking colors (visual pass): right hand = soft teal,
    // left hand = soft amber — readable over video without neon glow.
    if (rightLandmarks && rightLandmarks.length === 21) {
      this.drawHand(ctx, rightLandmarks, '#4f9e8e', canvas.width, canvas.height);
    }

    if (leftLandmarks && leftLandmarks.length === 21) {
      this.drawHand(ctx, leftLandmarks, '#d9975c', canvas.width, canvas.height);
    }
  }

  private drawHand(
    ctx: CanvasRenderingContext2D,
    landmarks: HandLandmark[],
    color: string,
    w: number,
    h: number,
  ): void {
    // Draw connections
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.7;

    for (const [a, b] of SKELETON_CONNECTIONS) {
      const la = landmarks[a];
      const lb = landmarks[b];
      if (!la || !lb) continue;

      // Mirror X because video is scaleX(-1)
      ctx.beginPath();
      ctx.moveTo((1 - la.x) * w, la.y * h);
      ctx.lineTo((1 - lb.x) * w, lb.y * h);
      ctx.stroke();
    }

    // Draw landmark dots
    ctx.fillStyle = color;
    ctx.globalAlpha = 1.0;
    for (let i = 0; i < landmarks.length; i++) {
      const lm = landmarks[i];
      const x = (1 - lm.x) * w;
      const y = lm.y * h;
      const radius = i === 0 ? 5 : (i === 4 || i === 8) ? 4 : 3;

      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.globalAlpha = 1.0;
  }

  private resizeSkeletonCanvas(): void {
    const rect = this.container.getBoundingClientRect();
    this.skeletonCanvas.width = rect.width;
    this.skeletonCanvas.height = rect.height;
  }

  // ─── Mode Indicator (V2.0) ─────────────────────────────

  /**
   * Reflect the interaction state: 1-second confirm ring while a mode
   * change is pending, persistent badge for the active mode, pause chip
   * while the left palm freezes the transformation.
   */
  updateModeIndicator(state: CVInteractionState): void {
    // ── Confirm ring: driven EXACTLY by per-frame progress ──
    const key = state.confirm ? `${state.confirm.gesture}:${state.confirm.mode}` : null;
    if (state.confirm) {
      this.modeIndicatorEl.classList.add('cv-mode-indicator--visible');
      if (key !== this.lastConfirmKey) {
        this.lastConfirmKey = key;
        this.confirmRingCircle.style.stroke = this.modeColor(state.confirm.mode);
        this.confirmLabelEl.textContent = this.modeLabel(state.confirm.mode);
      }
      const circumference = 2 * Math.PI * 18;
      const p = Math.max(0, Math.min(1, state.confirm.progress));
      // Direct dashoffset = real remaining fraction. No transitions, no drift.
      this.confirmRingCircle.style.transition = 'none';
      this.confirmRingCircle.style.strokeDasharray = `${circumference}`;
      this.confirmRingCircle.style.strokeDashoffset = `${circumference * (1 - p)}`;
    } else {
      this.modeIndicatorEl.classList.remove('cv-mode-indicator--visible');
      this.lastConfirmKey = null;
    }

    // ── Persistent active-mode badge (context-aware) ──
    const modeKey = `${state.context}:${state.mode}:${state.paused ? 'p' : ''}`;
    if (modeKey !== this.lastModeKey) {
      this.lastModeKey = modeKey;
      const label =
        state.mode === 'NONE'
          ? state.context === 'VIEWPORT' ? 'VIEWPORT' : 'NO MODE'
          : `${this.modeLabel(state.mode)}${state.paused ? ' — PAUSED' : ''}`;
      this.activeModeEl.textContent = label;
      this.activeModeEl.style.setProperty('--mode-color', this.modeColor(state.mode));
      this.activeModeEl.classList.toggle('cv-mode-badge--active', state.mode !== 'NONE');
      this.activeModeEl.classList.toggle('cv-mode-badge--viewport', state.context === 'VIEWPORT');
    }

    // ── Pause chip ──
    this.pausedChipEl.style.display = state.paused ? 'block' : 'none';
  }

  private modeLabel(mode: string): string {
    switch (mode) {
      case 'MOVE': return 'MOVE';
      case 'ROTATE': return 'ROTATE';
      case 'SCALE': return 'SCALE';
      default: return 'NO MODE';
    }
  }

  /** Functional mode accents (visual identity only): MOVE = soft blue,
   *  ROTATE = soft teal, SCALE = soft green — matches the token system in
   *  main.css (:root). Presentation only; no interaction semantics. */
  private modeColor(mode: string): string {
    switch (mode) {
      case 'MOVE': return 'var(--color-accent-blue, #4a7dbf)';
      case 'ROTATE': return 'var(--color-accent-teal, #2f9d84)';
      case 'SCALE': return 'var(--color-accent-green, #34a37f)';
      default: return 'var(--color-text-secondary, #66748c)';
    }
  }

  // ─── Module hold progress ──────────────────────────────

  /**
   * Show the 1-second selection-hold progress on a module row.
   * progress = null clears the ring.
   */
  setModuleHoldProgress(objectId: string | null, progress: number): void {
    if (objectId === null) {
      // Clear every row's ring (used when the pointer leaves the list).
      this.moduleSelectionPanel.querySelectorAll('.cv-module-row').forEach((el) => {
        const row = el as HTMLElement;
        const ring = row.querySelector('.cv-module-row__holdring') as HTMLElement | null;
        if (ring) ring.style.setProperty('--hold-progress', '0');
        row.classList.remove('cv-module-row--holding');
      });
      return;
    }
    const rows = this.moduleSelectionPanel.querySelectorAll('.cv-module-row');
    rows.forEach((el) => {
      const row = el as HTMLElement;
      const isTarget = row.dataset.objectId === objectId;
      let ring = row.querySelector('.cv-module-row__holdring') as HTMLElement | null;
      if (!isTarget) {
        if (ring) ring.style.setProperty('--hold-progress', '0');
        return;
      }
      row.classList.add('cv-module-row--holding');
      if (!ring) {
        ring = document.createElement('div');
        ring.className = 'cv-module-row__holdring';
        row.appendChild(ring);
      }
      ring.style.setProperty('--hold-progress', String(Math.max(0, Math.min(1, progress))));
      if (progress >= 1) {
        row.classList.remove('cv-module-row--holding');
        ring.style.setProperty('--hold-progress', '0');
      }
    });
  }

  /** Register a listener for active-tab changes (UI-context routing). */
  addActiveTabListener(listener: (tab: UITabState['activeTab']) => void): void {
    this.activeTabListeners.push(listener);
  }

  // ─── Tab Management ────────────────────────────────────

  private activeTabListeners: Array<(tab: UITabState['activeTab']) => void> = [];
  private lastModeKey: string | null = null;

  private createVideo(): HTMLVideoElement {
    const video = document.createElement('video');
    video.className = 'cv-video';
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.setAttribute('playsinline', 'true');
    return video;
  }

  private createTab(label: string, tabId: UITabState['activeTab']): HTMLElement {
    const tab = document.createElement('button');
    tab.className = 'cv-tab';
    tab.textContent = label;
    tab.dataset.tab = tabId || '';

    tab.addEventListener('click', () => {
      if (this.activeTab === tabId) {
        this.setActiveTab(null);
      } else {
        this.setActiveTab(tabId);
      }
    });

    return tab;
  }

  private createPanel(panelId: string): HTMLElement {
    const panel = document.createElement('div');
    panel.className = 'cv-panel';
    panel.id = panelId;
    panel.style.display = 'none';
    return panel;
  }

  /**
   * Set the active CV tab. Only one panel can be expanded at a time.
   */
  setActiveTab(tabId: UITabState['activeTab']): void {
    this.activeTab = tabId;

    this.moduleSelectionTab.classList.toggle('cv-tab--active', tabId === 'MODULE_SELECTION');
    this.viewportControlTab.classList.toggle('cv-tab--active', tabId === 'VIEWPORT_CONTROL');

    this.moduleSelectionPanel.style.display = tabId === 'MODULE_SELECTION' ? 'block' : 'none';
    this.viewportControlPanel.style.display = tabId === 'VIEWPORT_CONTROL' ? 'block' : 'none';
  }

  /**
   * Get the normalized bounds of a tab element (for pointer processor hit-testing).
   * Returns bounds in normalized CV-space coordinates [0..1].
   */
  getTabBounds(tabId: UITabState['activeTab']): { x: number; y: number; width: number; height: number } | null {
    const tabEl = tabId === 'MODULE_SELECTION' ? this.moduleSelectionTab :
                  tabId === 'VIEWPORT_CONTROL' ? this.viewportControlTab : null;
    if (!tabEl) return null;

    const containerRect = this.container.getBoundingClientRect();
    const tabRect = tabEl.getBoundingClientRect();

    return {
      x: (tabRect.left - containerRect.left) / containerRect.width,
      y: (tabRect.top - containerRect.top) / containerRect.height,
      width: tabRect.width / containerRect.width,
      height: tabRect.height / containerRect.height,
    };
  }

  /**
   * Get normalized bounds of a module row element (for pointer processor hit-testing).
   */
  getModuleRowBounds(objectId: string): { x: number; y: number; width: number; height: number } | null {
    const row = this.moduleSelectionPanel.querySelector(`[data-object-id="${objectId}"]`) as HTMLElement;
    if (!row) return null;

    const containerRect = this.container.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();

    return {
      x: (rowRect.left - containerRect.left) / containerRect.width,
      y: (rowRect.top - containerRect.top) / containerRect.height,
      width: rowRect.width / containerRect.width,
      height: rowRect.height / containerRect.height,
    };
  }

  /**
   * Get normalized bounds of an OPEN panel (context area for the pointer).
   * Returns null when the panel is hidden.
   */
  getPanelBounds(tabId: UITabState['activeTab']): { x: number; y: number; width: number; height: number } | null {
    const panelEl = tabId === 'MODULE_SELECTION' ? this.moduleSelectionPanel :
                    tabId === 'VIEWPORT_CONTROL' ? this.viewportControlPanel : null;
    if (!panelEl || panelEl.style.display === 'none') return null;

    const containerRect = this.container.getBoundingClientRect();
    const panelRect = panelEl.getBoundingClientRect();

    return {
      x: (panelRect.left - containerRect.left) / containerRect.width,
      y: (panelRect.top - containerRect.top) / containerRect.height,
      width: panelRect.width / containerRect.width,
      height: panelRect.height / containerRect.height,
    };
  }

  /** Get the module selection panel */
  getModuleSelectionPanel(): HTMLElement {
    return this.moduleSelectionPanel;
  }

  /** Get the viewport control panel */
  getViewportControlPanel(): HTMLElement {
    return this.viewportControlPanel;
  }

  /** Get the video element */
  getVideoElement(): HTMLVideoElement | null {
    return this.videoEl;
  }

  /** Get the active tab state */
  getActiveTab(): UITabState['activeTab'] {
    return this.activeTab;
  }

  /** Get the container element */
  getContainer(): HTMLElement {
    return this.container;
  }
}
