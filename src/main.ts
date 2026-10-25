/**
 * Module Builder V1.1 — Application Entry Point
 *
 * Core/Application: lifecycle, engine construction, wiring,
 * command routing, history coordination.
 *
 * Source of truth: Doc 04 §4, Doc 04 §19
 */

import * as THREE from 'three';
import { EventBus } from './core/event-bus';
import { CommandRouter } from './core/command-router';
import { HistoryManager } from './core/history-manager';
import { TransformHistory } from './core/transform-history';
import { SceneCore } from './engine-3d/scene';
import { SceneManager } from './engine-3d/scene-manager';
import { SelectionManager } from './engine-3d/selection-manager';
import { TransformService } from './engine-3d/transform-service';
import { CameraController } from './engine-3d/camera-controller';
import { DisplayAdapter } from './engine-3d/display-adapter';
import { AssetManager } from './engine-3d/asset-manager';
import { SceneExporter } from './engine-3d/exporter';
import { AppShell } from './engine-ui/app-shell';
import { Inspector } from './engine-ui/inspector';
import { CVWorkspace } from './engine-ui/cv-workspace';
import { ModuleSelection } from './engine-ui/module-selection';
import { ManualModuleSelector } from './engine-ui/manual-module-selector';
import { Toolbar } from './engine-ui/toolbar';
import { AssetLibrary } from './engine-ui/asset-library';
import { CVEngine } from './engine-cv/cv-engine';
import type { HistoryRecord, CVFrameDelta, ObjectId, SelectionCommand, TransformCommand } from './core/contracts';

// ─── Application Bootstrap ────────────────────────────────

class ModuleBuilderApp {
  private eventBus: EventBus;
  private commandRouter: CommandRouter;
  private historyManager: HistoryManager;

  // 3D Engine
  private sceneCore!: SceneCore;
  sceneManager!: SceneManager;
  selectionManager!: SelectionManager;
  private transformService!: TransformService;
  private cameraController!: CameraController;
  private displayAdapter!: DisplayAdapter;
  private assetManager!: AssetManager;
  private exporter!: SceneExporter;
  private cvEngine!: CVEngine;

  // UI Engine
  private appShell!: AppShell;
  private inspector!: Inspector;
  private cvWorkspace!: CVWorkspace;
  private moduleSelection!: ModuleSelection;
  private manualModuleSelector!: ManualModuleSelector;
  private assetLibrary!: AssetLibrary;

  // Transform before/after capture + one undo entry per transform
  private transformHistory!: TransformHistory;

  // Metadata for created/deleted objects (needed for undo/redo of CREATE/DELETE)
  private createdObjectMeta = new Map<string, { name: string; assetId: string }>();
  private deletedObjectMeta = new Map<string, { name: string; object: THREE.Object3D; snapshot: import('./core/contracts').TransformSnapshot }>();

  constructor() {
    // ── Core Layer ──────────────────────────────────────
    this.eventBus = new EventBus();
    this.commandRouter = new CommandRouter(this.eventBus);
    this.historyManager = new HistoryManager(
      this.eventBus,
      (record) => this.applyHistoryRecord(record),
      (record) => this.revertHistoryRecord(record),
    );

    // ── Build UI Shell First ────────────────────────────
    const root = document.getElementById('app');
    if (!root) throw new Error('Root element #app not found');

    this.appShell = new AppShell(this.eventBus, root);

    // Add toolbar to header
    const header = document.querySelector('.app-header') as HTMLElement;
    const toolbarContainer = document.createElement('div');
    toolbarContainer.className = 'toolbar-container';
    header.insertBefore(toolbarContainer, header.querySelector('.cv-toggle-btn'));

    // ── 3D Engine ───────────────────────────────────────
    const viewportRegion = this.appShell.getViewportRegion();

    const canvas = document.createElement('canvas');
    canvas.className = 'three-canvas';
    viewportRegion.appendChild(canvas);

    this.sceneCore = new SceneCore(canvas);
    this.sceneManager = new SceneManager(this.sceneCore.scene);

    this.selectionManager = new SelectionManager(
      this.eventBus,
      this.sceneCore.scene,
      (id) => this.sceneManager.getObject(id),
      (id) => {
        const obj = this.sceneManager.getObject(id);
        return obj?.name || id;
      },
    );

    this.transformService = new TransformService(this.eventBus, this.sceneManager);

    this.cameraController = new CameraController(
      this.eventBus,
      this.sceneCore.camera as any,
      this.sceneCore.controls as any,
    );

    this.displayAdapter = new DisplayAdapter(this.sceneManager);

    // Captures the pre-transform state before execution. Constructed before
    // any command path can run, so the first Inspector edit is recorded.
    this.transformHistory = new TransformHistory(
      this.eventBus,
      this.historyManager,
      (objectId) => this.transformService.getTransform(objectId),
    );

    this.assetManager = new AssetManager(this.sceneManager);

    this.exporter = new SceneExporter();

    // ── CV Engine ────────────────────────────────────────
    this.cvEngine = new CVEngine(this.eventBus);

    // ── UI Engine ───────────────────────────────────────
    this.inspector = new Inspector(
      this.eventBus,
      this.displayAdapter,
      this.appShell.getInspectorRegion(),
      this.transformService,
    );

    // Mouse-operated module selector, docked at the right end of the
    // Inspector bar. Additive: it shares SelectionManager with the CV
    // Module Selection panel and needs no webcam.
    this.manualModuleSelector = new ManualModuleSelector(
      this.eventBus,
      this.displayAdapter,
      this.appShell.getInspectorRegion(),
    );

    this.cvWorkspace = new CVWorkspace(
      this.eventBus,
      this.appShell.getCVRegion(),
    );

    // Wire CV toggle to start/stop CV engine
    this.eventBus.on('cv:workspace-toggle', async (state) => {
      if (state === 'OPEN') {
        const videoEl = this.cvWorkspace.getVideoElement();
        if (videoEl) {
          await this.cvEngine.start(videoEl);
        }
      } else {
        this.cvEngine.stop();
      }
    });

    // (CV tab changes are wired via cvWorkspace.addActiveTabListener below —
    // tab == UI context: Viewport Control tab → camera control.)

    this.moduleSelection = new ModuleSelection(
      this.eventBus,
      this.displayAdapter,
      this.cvWorkspace.getModuleSelectionPanel(),
    );

    // Viewport Control panel content is set by CVWorkspace (status chip);
    // the former ViewportControl instruction filler was removed (UI-only).

    // Asset Library in left-side collapsible panel
    this.assetLibrary = new AssetLibrary(
      this.eventBus,
      this.appShell.getAssetLibraryContainer(),
    );
    this.assetLibrary.onAdd((assetId) => {
      const objectId = this.assetManager.addToScene(assetId);
      if (objectId) {
        this.selectionManager.select(objectId);
        this.moduleSelection.refresh();
        this.manualModuleSelector.refresh();
      }
    });

    // Initial catalog paint: the built-in basic shapes are registered in the
    // AssetManager constructor, so the library must render once at startup
    // (not only after an import) for them to be listed.
    this.assetLibrary.refresh(this.assetManager.getAllAssets());

    // ── Toolbar ─────────────────────────────────────────
    new Toolbar(this.eventBus, toolbarContainer, {
      onImportFiles: (files) => this.handleImportFiles(files),
      onImportFolder: (files) => this.handleImportFolder(files),
      onExport: () => this.handleExport(),
      onUndo: () => this.handleUndo(),
      onRedo: () => this.handleRedo(),
      onDuplicate: () => this.handleDuplicate(),
      onDelete: () => this.handleDelete(),
    });

    // ── Wire Command Router to 3D Engine ────────────────
    this.commandRouter.onSelection((cmd) => {
      this.selectionManager.select(cmd.objectId);
    });

    this.commandRouter.onTransform((cmd) => {
      this.applyTransformCommand(cmd);
    });

    this.commandRouter.onViewport((intent) => {
      this.cameraController.applyIntent(intent);
    });

    // Wire CV frame deltas → TransformCommand (new interaction model)
    this.eventBus.on('cv:transform-delta', (event) => {
      this.handleCVFrameDelta(event);
    });

    // Wire interaction state → mode indicator UI
    this.eventBus.on('cv:interaction-state', (state) => {
      this.cvWorkspace.updateModeIndicator(state);
    });

    // Provide the camera accessor for VIEWPORT-context control
    this.cvEngine.setCameraAccessor(() => ({
      position: this.cameraController.getCameraPosition(),
      target: this.cameraController.getCameraTarget(),
    }));

    // UI context follows the active tab: Viewport Control tab = camera
    this.cvWorkspace.addActiveTabListener((tab) => {
      this.cvEngine.setUIContext(tab === 'VIEWPORT_CONTROL' ? 'VIEWPORT' : 'MODULE');
    });

    // ── Wire Selection Changes ──────────────────────────
    this.eventBus.on('selection:changed', () => {
      const state = this.selectionManager.getState();
      this.inspector.refresh();
      this.moduleSelection.refreshWithSelection(state.objectId);
    });

    // ── Viewport Click-to-Select ────────────────────────
    this.setupViewportSelection(canvas);

    // ── CV Pointer → Tab Targeting ──────────────────────
    this.setupCVPointerTargeting();

    // ── Visual Cursor & Hand Skeleton ──────────────────
    this.setupVisualTracking();

    // ── Keyboard Shortcuts ─────────────────────────────
    this.setupKeyboardShortcuts();

    // ── Log Ready ───────────────────────────────────────
    console.log('[Module Builder] V1.2 initialized');
  }

  /**
   * Start the application: render scene and begin render loop.
   */
  start(): void {
    this.sceneCore.start();
    this.sceneCore.updateSize();

    const state = this.selectionManager.getState();
    console.log('[Module Builder] Ready. Selection:', state);
  }

  // ─── Import / Export ───────────────────────────────────

  private async handleImportFiles(files: FileList): Promise<void> {
    for (const file of Array.from(files)) {
      if (file.name.toLowerCase().match(/\.(glb|gltf)$/)) {
        await this.assetManager.importToCatalog(file);
      }
    }
    this.assetLibrary.refresh(this.assetManager.getAllAssets());
  }

  private async handleImportFolder(files: FileList): Promise<void> {
    await this.assetManager.importFolder(files);
    this.assetLibrary.refresh(this.assetManager.getAllAssets());

    // Warn only about genuinely unresolved external textures. Models with
    // embedded, resolved, or no textures import silently.
    const warnings = this.assetManager.getWarnings();
    if (warnings.length > 0) {
      const affected = warnings
        .map((warning) => warning.split(' \u2014 ')[0])
        .join(', ');
      this.appShell.showNotice(
        `Some textures could not be found for ${affected}. Affected models may appear untextured.`,
      );
      this.assetManager.clearWarnings();
    }
  }

  private async handleExport(): Promise<void> {
    await this.exporter.exportGLB(this.sceneCore.scene);
  }

  // ─── Undo / Redo ──────────────────────────────────────

  private handleUndo(): void {
    this.historyManager.undo();
  }

  private handleRedo(): void {
    this.historyManager.redo();
  }

  // ─── Duplicate / Delete with History ──────────────────

  private handleDuplicate(): void {
    const selId = this.selectionManager.selectedId;
    if (!selId) return;

    const cloneId = this.sceneManager.duplicateObject(selId);
    if (cloneId) {
      const afterSnapshot = this.transformService.getTransform(cloneId);

      // Store metadata for undo (remove clone) / redo (re-create clone)
      const originalObj = this.sceneManager.getObject(selId);
      const assetEntry = this.assetManager.getAllAssets().find(
        (a) => a.name === originalObj?.name,
      );
      this.createdObjectMeta.set(cloneId, {
        name: originalObj?.name || 'Duplicate',
        assetId: assetEntry?.assetId || '',
      });

      this.historyManager.recordAction({
        commandId: this.historyManager.generateCommandId(),
        actionType: 'CREATE',
        targetObjectId: cloneId,
        source: 'UI',
        after: afterSnapshot ?? undefined,
        timestamp: this.historyManager.now(),
      });
      this.selectionManager.select(cloneId);
      this.moduleSelection.refresh();
      this.manualModuleSelector.refresh();
    }
  }

  /**
   * Keyboard shortcuts (additive only — no existing behavior changes).
   *   Delete       → same action as the toolbar Delete button
   *   W / S        → move selected object along +Z / −Z
   *   A / D        → move selected object along −X / +X
   *   ArrowUp / ↓  → move selected object along +Y / −Y
   */
  private setupKeyboardShortcuts(): void {
    document.addEventListener('keydown', (event: KeyboardEvent) => {
      // Never while typing in a form field or contenteditable area
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        target?.isContentEditable
      ) {
        return;
      }

      if (event.key === 'Delete') {
        // Same code path as the Delete toolbar button
        this.handleDelete();
        return;
      }

      // Leave browser/app shortcuts (Ctrl+W, Cmd+W, Alt+…) untouched
      if (event.ctrlKey || event.metaKey || event.altKey) return;

      const values = this.getKeyboardMoveDelta(event.key);
      if (!values) return;

      // Movement requires a selected object; do nothing otherwise.
      const selectedId = this.selectionManager.selectedId;
      if (!selectedId) return;

      // Arrows would otherwise scroll the page / Inspector
      event.preventDefault();

      // Same command route as the Inspector (CommandRouter → TransformService)
      const cmd: TransformCommand = {
        commandId: `keyboard-${Date.now()}`,
        source: 'OTHER_UI',
        objectId: selectedId,
        operation: 'DELTA',
        property: 'POSITION',
        values,
        history: 'NONE',
      };
      this.eventBus.emit('ui:transform-command', cmd);
    });
  }

  /** Map a movement key to its world-space delta (one fixed step per press). */
  private getKeyboardMoveDelta(key: string): { x: number; y: number; z: number } | null {
    const step = 0.1;

    switch (key) {
      case 'w':
      case 'W':
        return { x: 0, y: 0, z: step };
      case 's':
      case 'S':
        return { x: 0, y: 0, z: -step };
      case 'a':
      case 'A':
        return { x: -step, y: 0, z: 0 };
      case 'd':
      case 'D':
        return { x: step, y: 0, z: 0 };
      case 'ArrowUp':
        return { x: 0, y: step, z: 0 };
      case 'ArrowDown':
        return { x: 0, y: -step, z: 0 };
      default:
        return null;
    }
  }

  private handleDelete(): void {
    const selId = this.selectionManager.selectedId;
    if (!selId) return;

    // Capture before state for undo (re-add object)
    const beforeSnapshot = this.transformService.getTransform(selId);

    // Detach WITHOUT disposing: undo restores this exact instance (geometry,
    // textures, materials, name) instead of rebuilding a placeholder.
    const detached = this.sceneManager.detachObject(selId);

    if (beforeSnapshot && detached) {
      this.deletedObjectMeta.set(selId, {
        name: detached.name || 'Deleted Object',
        object: detached,
        snapshot: beforeSnapshot,
      });
    }

    this.selectionManager.select(null);

    this.historyManager.recordAction({
      commandId: this.historyManager.generateCommandId(),
      actionType: 'DELETE',
      targetObjectId: selId,
      source: 'UI',
      before: beforeSnapshot ?? undefined,
      timestamp: this.historyManager.now(),
    });

    this.moduleSelection.refresh();
    this.manualModuleSelector.refresh();
  }

  private applyHistoryRecord(record: HistoryRecord): void {
    if (record.actionType === 'CREATE') {
      // Redo CREATE: re-add the cloned object
      const meta = this.createdObjectMeta.get(record.targetObjectId);
      if (meta && record.after) {
        // Clone the original object from the scene
        const original = this.sceneManager.getAllObjects().find(
          (o) => o.name === meta.name,
        );
        if (original) {
          const originalObj = this.sceneManager.getObject(original.objectId);
          if (originalObj) {
            const clone = originalObj.clone(true);
            const newId = this.sceneManager.addObject(clone, meta.name);
            this.transformService.setTransform(newId, record.after);
            this.selectionManager.select(newId);
          }
        }
      }
    } else if (record.actionType === 'DELETE') {
      // Redo DELETE: detach the object so Undo can restore the same instance
      // (never removeObject — that would dispose its geometry and textures).
      this.sceneManager.detachObject(record.targetObjectId);
      this.selectionManager.select(null);
    } else if (record.group && record.group.length > 0) {
      // GROUP movement: every affected module returns to its previous
      // position in ONE undo step (each keeps its own id and transform).
      for (const member of record.group) {
        this.transformService.setTransform(member.objectId, member.after);
      }
      this.selectionManager.select(record.targetObjectId);
    } else if (record.after) {
      // TRANSFORM: restore the transform
      this.transformService.setTransform(record.targetObjectId, record.after);
      this.selectionManager.select(record.targetObjectId);
    }
    this.moduleSelection.refresh();
    this.manualModuleSelector.refresh();
  }

  private revertHistoryRecord(record: HistoryRecord): void {
    if (record.actionType === 'CREATE') {
      // Undo CREATE: remove the cloned object
      this.sceneManager.removeObject(record.targetObjectId);
      this.selectionManager.select(null);
    } else if (record.actionType === 'DELETE') {
      // Undo DELETE: re-attach the ORIGINAL instance (appearance, textures,
      // name preserved) under its ORIGINAL id, so the matching redo still
      // finds it.
      const meta = this.deletedObjectMeta.get(record.targetObjectId);
      if (meta && record.before) {
        const restoredId = this.sceneManager.addObject(meta.object, meta.name, record.targetObjectId);
        this.transformService.setTransform(restoredId, record.before);
        this.selectionManager.select(restoredId);
      }
    } else if (record.group && record.group.length > 0) {
      // GROUP movement: restore every affected module's previous position.
      for (const member of record.group) {
        this.transformService.setTransform(member.objectId, member.before);
      }
      this.selectionManager.select(record.targetObjectId);
    } else if (record.before) {
      // TRANSFORM: restore the previous transform
      this.transformService.setTransform(record.targetObjectId, record.before);
      this.selectionManager.select(record.targetObjectId);
    }
    this.moduleSelection.refresh();
    this.manualModuleSelector.refresh();
  }

  // ─── Module row hover highlight ───────────────────────

  private highlightModuleRow(objectId: string | null): void {
    const panel = this.cvWorkspace.getModuleSelectionPanel();
    panel.querySelectorAll('.cv-module-row').forEach((el) => {
      el.classList.toggle(
        'cv-module-row--hovered',
        objectId !== null && (el as HTMLElement).dataset.objectId === objectId,
      );
    });
  }

  // ─── CV Pointer → Tab Targeting ──────────────────────

  private setupCVPointerTargeting(): void {
    const pointerProc = this.cvEngine.getPointerProcessor();

    pointerProc.setEventHandlers({
      // Tab hover = immediate open (no confirmation per spec §6/§7/§8)
      onTabEnter: (tabId) => {
        this.cvWorkspace.setActiveTab(tabId);
        // The panel just appeared — refresh targets so it is hoverable.
        requestAnimationFrame(() => this.updatePointerTargets());
      },
      // Leaving BOTH the tab and its open panel collapses it.
      onTabLeave: () => {
        this.cvWorkspace.setActiveTab(null);
        this.highlightModuleRow(null);
        this.cvWorkspace.setModuleHoldProgress(null, 0);
        requestAnimationFrame(() => this.updatePointerTargets());
      },
      // Module row hover = highlight only (selection needs the 1 s hold)
      onModuleHover: (objectId) => this.highlightModuleRow(objectId),
      // 1-second hold satisfied = select the module
      onModuleSelect: (objectId) => {
        const cmd: SelectionCommand = {
          commandId: `cv-sel-${Date.now()}`,
          objectId,
          source: 'MODULE_SELECTION_UI',
        };
        this.eventBus.emit('ui:selection-command', cmd);
      },
      onModuleHoldProgress: (objectId, progress) =>
        this.cvWorkspace.setModuleHoldProgress(objectId, progress),
    });

    // THE single trigger set for target refresh (previously two competing
    // update paths raced and could drop targets).
    this.eventBus.on('cv:workspace-toggle', (state) => {
      if (state === 'OPEN') {
        setTimeout(() => this.updatePointerTargets(), 200);
      }
    });
    this.eventBus.on('selection:changed', () => this.updatePointerTargets());
  }

  /**
   * Rebuild ALL pointer targets: tabs + open panels + module rows.
   * This is the ONE registration path.
   */
  private updatePointerTargets(): void {
    const pointerProc = this.cvEngine.getPointerProcessor();
    const targets: Array<{
      id: string;
      type: 'tab' | 'panel' | 'module-row';
      x: number;
      y: number;
      width: number;
      height: number;
    }> = [];

    const msTab = this.cvWorkspace.getTabBounds('MODULE_SELECTION');
    if (msTab) targets.push({ id: 'tab:MODULE_SELECTION', type: 'tab', ...msTab });
    const vcTab = this.cvWorkspace.getTabBounds('VIEWPORT_CONTROL');
    if (vcTab) targets.push({ id: 'tab:VIEWPORT_CONTROL', type: 'tab', ...vcTab });

    // Open panels belong to their tab's context area. The panel target is
    // STRETCHED UP to the tab's bottom edge so the two rects overlap/abut:
    // the finger crossing from the tab to the list never crosses dead space,
    // so the panel cannot collapse mid-traversal (the "dropdown closes when
    // moving from tab to list" bug).
    const msPanel = this.cvWorkspace.getPanelBounds('MODULE_SELECTION');
    if (msPanel && msTab) {
      // The Module Selection tab is TOP-RIGHT-docked while its panel opens in
      // the flow below the (now empty) top strip — they no longer abut. Use
      // the true bounding box of tab ∪ panel so the band between them is
      // covered too: the finger crossing from the tab to the list never
      // crosses dead space, so the panel cannot collapse mid-traversal (the
      // "dropdown closes when moving from tab to list" bug).
      const x0 = Math.min(msPanel.x, msTab.x);
      const y0 = Math.min(msPanel.y, msTab.y);
      const right = Math.max(msPanel.x + msPanel.width, msTab.x + msTab.width);
      const bottom = Math.max(msPanel.y + msPanel.height, msTab.y + msTab.height);
      targets.push({
        id: 'panel:MODULE_SELECTION',
        type: 'panel',
        x: x0,
        y: y0,
        width: right - x0,
        height: bottom - y0,
      });
    }
    const vcPanel = this.cvWorkspace.getPanelBounds('VIEWPORT_CONTROL');
    if (vcPanel && vcTab) {
      // The Viewport Control tab is LEFT-DOCKED (mid-height), while its panel
      // opens in the top flow strip — they no longer abut. Use the true
      // bounding box of tab ∪ panel so the gap between them is covered too:
      // a finger travelling from the tab to the panel never crosses dead
      // space, preserving the original no-collapse continuity behavior.
      // (The MODULE_SELECTION union above keeps its original math — tab and
      // panel still abut there.)
      const x0 = Math.min(vcPanel.x, vcTab.x);
      const y0 = Math.min(vcPanel.y, vcTab.y);
      const right = Math.max(vcPanel.x + vcPanel.width, vcTab.x + vcTab.width);
      const bottom = Math.max(vcPanel.y + vcPanel.height, vcTab.y + vcTab.height);
      targets.push({
        id: 'panel:VIEWPORT_CONTROL',
        type: 'panel',
        x: x0,
        y: y0,
        width: right - x0,
        height: bottom - y0,
      });
    }

    for (const item of this.displayAdapter.getModuleListItems(
      this.selectionManager.selectedId,
    )) {
      const bounds = this.cvWorkspace.getModuleRowBounds(item.objectId);
      if (bounds) {
        targets.push({ id: `module:${item.objectId}`, type: 'module-row', ...bounds });
      }
    }

    pointerProc.setTargets(targets);
  }

  // ─── CV Frame Deltas → TransformCommand ─────────────

  private handleCVFrameDelta(event: CVFrameDelta): void {
    const objectId = event.objectId;
    if (!objectId) return;

    // Validate the delta defensively — a bad frame must never reach the scene.
    if (
      !Number.isFinite(event.delta.position.x) ||
      !Number.isFinite(event.delta.position.y) ||
      !Number.isFinite(event.delta.position.z) ||
      !Number.isFinite(event.delta.rotation.x) ||
      !Number.isFinite(event.delta.rotation.y) ||
      !Number.isFinite(event.delta.rotation.z) ||
      !Number.isFinite(event.delta.scale.x) ||
      !Number.isFinite(event.delta.scale.y) ||
      !Number.isFinite(event.delta.scale.z)
    ) {
      console.warn('[ModuleBuilder] CV delta with non-finite values dropped');
      return;
    }

    // History: capture the before-state ONCE per session (BEGIN), not per
    // frame — otherwise every gesture floods the undo stack with entries.
    // Checked modules are captured too, so the session records ONE entry
    // covering the whole group movement.
    if (event.phase === 'BEGIN') {
      this.transformHistory.begin(objectId, this.getGroupMoveIds(objectId));
      return;
    }
    if (event.phase === 'END') {
      // The final 'transform:changed' event (from the last UPDATE) records
      // the history entry; nothing to apply for END itself.
      return;
    }

    const { position, rotation, scale } = event.delta;
    const isTranslation = position.x !== 0 || position.y !== 0 || position.z !== 0;
    const isRotation = rotation.x !== 0 || rotation.y !== 0 || rotation.z !== 0;
    const isScale = scale.x !== 1 || scale.y !== 1 || scale.z !== 1;
    if (!isTranslation && !isRotation && !isScale) return;

    const values = isTranslation ? position : isRotation ? rotation : scale;
    const cmd: TransformCommand = {
      commandId: `cv-delta-${event.sessionId}-${event.timestamp}`,
      source: 'CV',
      objectId,
      operation: isScale ? 'SCALE_FACTOR' : 'DELTA',
      property: isTranslation ? 'POSITION' : isRotation ? 'ROTATION' : 'SCALE',
      values,
      history: 'RECORD',
    };

    this.applyTransformCommand(cmd);
  }

  // ─── Group Movement ─────────────────────────────────

  /**
   * Apply a transform command, expanding POSITION movements to the modules
   * checked in the Inspector's Manual Module Selector.
   *
   * With nothing checked (or for rotation/scale) this is exactly the old
   * single-object path. Everything still executes through TransformService.
   */
  private applyTransformCommand(cmd: TransformCommand): void {
    const targets = this.getMovementTargets(cmd);
    if (targets.length <= 1) {
      // Capture-before-execute lives in TransformHistory, so the last (and
      // first) Inspector edit is always undoable.
      this.transformHistory.apply(cmd, (command) => this.transformService.apply(command));
      return;
    }

    // The command's values describe the primary module (the selection), so an
    // absolute SET is turned into the same OFFSET for the other modules. The
    // pre-move position has to be read before the first apply.
    const before = cmd.operation === 'SET'
      ? this.transformService.getTransform(cmd.objectId)
      : null;

    // The whole group executes as ONE history transaction: a single Undo
    // restores every affected module to its previous position.
    this.transformHistory.applyGroup(cmd, targets, () => {
      targets.forEach((objectId, index) => {
        if (index === 0) {
          this.transformService.apply(cmd);
          return;
        }

        const groupCmd: TransformCommand = {
          ...cmd,
          commandId: `${cmd.commandId}-group-${index}`,
          objectId,
        };

        if (cmd.operation === 'SET') {
          if (!before) return;
          groupCmd.operation = 'DELTA';
          groupCmd.values = {
            x: cmd.values.x - before.position.x,
            y: cmd.values.y - before.position.y,
            z: cmd.values.z - before.position.z,
          };
        }

        this.transformService.apply(groupCmd);
      });
    });
  }

  /**
   * Movement targets: the selected module (unchanged behaviour) plus every
   * module checked for group movement. Rotation and scale stay single-object.
   */
  private getMovementTargets(cmd: TransformCommand): ObjectId[] {
    if (cmd.property !== 'POSITION') return [cmd.objectId];

    const group = this.getGroupMoveIds(cmd.objectId);
    return group.length > 0 ? [cmd.objectId, ...group] : [cmd.objectId];
  }

  /** Live modules checked for group movement (excludes the primary). */
  private getGroupMoveIds(primaryId: ObjectId): ObjectId[] {
    const checked = this.manualModuleSelector.getCheckedObjectIds();
    const ids: ObjectId[] = [];
    for (const id of checked) {
      if (id !== primaryId && this.sceneManager.getObject(id)) ids.push(id);
    }
    return ids;
  }

  // ─── Visual Cursor & Hand Skeleton ──────────────────

  private setupVisualTracking(): void {
    // Wire pointer events → visual cursor
    this.eventBus.on('cv:pointer', (pointer) => {
      this.cvWorkspace.updateCursor(pointer);
    });

    // Wire hand landmarks → skeleton overlay
    this.cvEngine.onHandLandmarksUpdate((right, left) => {
      this.cvWorkspace.drawHandSkeleton(right, left);
    });

    // (Pointer-target refresh is centralized in setupCVPointerTargeting /
    // updatePointerTargets — the old duplicate registration path is gone.)
  }

  // ─── Viewport Click-to-Select ─────────────────────────

  private setupViewportSelection(canvas: HTMLCanvasElement): void {
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();

    // Track pointer movement to distinguish clicks from drags.
    // OrbitControls fires synthetic click events after a drag,
    // which would incorrectly deselect objects.
    let pointerDownPos: { x: number; y: number } | null = null;
    const DRAG_THRESHOLD = 4; // pixels

    canvas.addEventListener('pointerdown', (event) => {
      pointerDownPos = { x: event.clientX, y: event.clientY };
    });

    canvas.addEventListener('pointerup', (event) => {
      if (!pointerDownPos) return;

      const dx = event.clientX - pointerDownPos.x;
      const dy = event.clientY - pointerDownPos.y;
      const moved = Math.sqrt(dx * dx + dy * dy);
      pointerDownPos = null;

      // If the pointer moved more than the threshold, this was a drag (orbit),
      // not a click — skip selection to avoid deselect.
      if (moved > DRAG_THRESHOLD) return;

      const rect = canvas.getBoundingClientRect();
      mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

      raycaster.setFromCamera(mouse, this.sceneCore.camera);

      // Get all selectable objects (exclude ground, grid, highlights)
      const selectableObjects: THREE.Object3D[] = [];
      this.sceneCore.scene.traverse((child) => {
        if (
          child instanceof THREE.Mesh &&
          child.name !== '__ground__' &&
          !child.name.startsWith('__highlight_')
        ) {
          selectableObjects.push(child);
        }
      });

      const intersects = raycaster.intersectObjects(selectableObjects, true);

      if (intersects.length > 0) {
        // Find the top-level parent that is in our scene manager
        let hitObject = intersects[0].object;
        while (hitObject.parent && hitObject.parent !== this.sceneCore.scene) {
          hitObject = hitObject.parent;
        }

        // Find the ObjectId for this object
        const records = this.sceneManager.getAllObjects();
        const match = records.find((r) => {
          const obj = this.sceneManager.getObject(r.objectId);
          return obj === hitObject;
        });

        if (match) {
          this.selectionManager.select(match.objectId);
        }
      } else {
        // Click on empty space — deselect
        this.selectionManager.select(null);
      }
    });

    // Cancel selection if pointer leaves canvas during a potential click
    canvas.addEventListener('pointerleave', () => {
      pointerDownPos = null;
    });
  }

  // ─── Public API ───────────────────────────────────────

  getSceneManager(): SceneManager {
    return this.sceneManager;
  }

  getEventBus(): EventBus {
    return this.eventBus;
  }

  dispose(): void {
    this.cvEngine.stop();
    this.sceneCore.dispose();
    this.selectionManager.dispose();
    this.commandRouter.dispose();
    this.inspector.refresh();
    this.createdObjectMeta.clear();
    // Free meshes held only for an undo that can no longer happen.
    for (const [id, meta] of this.deletedObjectMeta) {
      if (meta.object && !this.sceneManager.hasObject(id)) {
        meta.object.traverse((child) => {
          if (child instanceof THREE.Mesh) {
            child.geometry?.dispose();
            if (Array.isArray(child.material)) {
              child.material.forEach((m) => m.dispose());
            } else {
              child.material?.dispose();
            }
          }
        });
      }
    }
    this.deletedObjectMeta.clear();
    this.transformHistory.dispose();
    this.eventBus.clear();
  }
}

// ─── DOM Ready ────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  const app = new ModuleBuilderApp();
  (window as any).__moduleBuilderApp = app;
  app.start();
});
