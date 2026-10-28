/**
 * Module Builder V1.1 — Bottom Inspector
 *
 * Displays: Module Name → Move XYZ → Scale XYZ (+ Scale All) → Rotation XYZ
 * Additional content (Asset Library) accessible via scrolling.
 * Inspector is a presentation/edit surface; it does NOT own Three.js transforms.
 *
 * Source of truth: Doc 02 §8, Doc 05 §9.3
 */

import type {
  ObjectId,
  Vector3Value,
  TransformCommand,
} from '../core/contracts';
import { EventBus } from '../core/event-bus';
import { DisplayAdapter } from '../engine-3d/display-adapter';
import { TransformService } from '../engine-3d/transform-service';

/**
 * Parse what the user typed into an Inspector field.
 * Returns null for empty / non-numeric text so the caller can restore the
 * applied value instead of writing a guessed 0.
 */
export function parseInspectorValue(raw: string): number | null {
  const text = raw.trim();
  if (text === '') return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

// ─── Value Formatting ────────────────────────────────────

/**
 * Format a scene value for an Inspector field.
 *
 * The Inspector used to render every value with `toFixed(2)`, which made the
 * bar LIE about the module: a CV- or import-scale like 1.2345 was stored at
 * full precision but displayed as "1.23", and the next spinner/arrow press
 * then rewrote the real 1.2345 as 1.24. Values are therefore shown at the
 * precision they actually have — the familiar 2-decimal look is kept for
 * values that really sit on that grid.
 *
 * `toFixed(6)` only discards float noise from the radians↔degrees round trip
 * (30.000000000000004 → "30.00"); it never hides a value the scene keeps.
 */
export function formatInspectorValue(value: number): string {
  if (!Number.isFinite(value)) return '0.00';

  const cleaned = Number(value.toFixed(6));
  const onTwoDecimalGrid = Math.abs(cleaned - Math.round(cleaned * 100) / 100) < 1e-9;
  return onTwoDecimalGrid ? cleaned.toFixed(2) : String(cleaned);
}

// ─── Inspector ───────────────────────────────────────────

export class Inspector {
  private eventBus: EventBus;
  private displayAdapter: DisplayAdapter;
  private container: HTMLElement;
  private nameEl: HTMLElement;
  private moveInputs: { x: HTMLInputElement; y: HTMLInputElement; z: HTMLInputElement };
  private scaleInputs: { x: HTMLInputElement; y: HTMLInputElement; z: HTMLInputElement };
  private rotationInputs: { x: HTMLInputElement; y: HTMLInputElement; z: HTMLInputElement };
  private emptyState: HTMLElement;
  private contentEl: HTMLElement;
  private currentObjectId: ObjectId | null = null;
  private transformService: TransformService;

  constructor(eventBus: EventBus, displayAdapter: DisplayAdapter, container: HTMLElement, transformService: TransformService) {
    this.eventBus = eventBus;
    this.displayAdapter = displayAdapter;
    this.transformService = transformService;
    this.container = container;

    // Primary content (selection + transforms)
    this.emptyState = this.createEmptyState();
    this.contentEl = document.createElement('div');
    this.contentEl.className = 'inspector-content';

    this.nameEl = document.createElement('div');
    this.nameEl.className = 'inspector-module-name';
    this.nameEl.textContent = 'No Selection';

    this.moveInputs = this.createTransformGroup('Move', 'position');
    this.scaleInputs = this.createTransformGroup('Scale', 'scale');
    this.rotationInputs = this.createTransformGroup('Rotation', 'rotation');

    // Scale All lives inside the existing Scale group, after X / Y / Z.
    this.scaleInputs.x.parentElement!.parentElement!.appendChild(
      this.createScaleAllControl(),
    );

    const row = document.createElement('div');
    row.className = 'inspector-row';
    row.appendChild(this.nameEl);
    row.appendChild(this.moveInputs.x.parentElement!.parentElement!);
    row.appendChild(this.scaleInputs.x.parentElement!.parentElement!);
    row.appendChild(this.rotationInputs.x.parentElement!.parentElement!);
    this.contentEl.appendChild(row);

    // Assemble into container
    this.container.appendChild(this.emptyState);
    this.container.appendChild(this.contentEl);

    this.eventBus.on('selection:changed', (event) => {
      this.currentObjectId = event.objectId;
      this.refresh();
    });

    this.eventBus.on('transform:changed', (event) => {
      if (event.objectId === this.currentObjectId) {
        this.refreshValues(true);
      }
    });

    this.refresh();
  }

  private createEmptyState(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'inspector-empty';
    el.textContent = 'Select a module to inspect';
    return el;
  }

  private createTransformGroup(
    label: string,
    property: string,
  ): { x: HTMLInputElement; y: HTMLInputElement; z: HTMLInputElement } {
    const group = document.createElement('div');
    group.className = 'inspector-group';

    const groupLabel = document.createElement('span');
    groupLabel.className = 'inspector-group-label';
    groupLabel.textContent = label;
    group.appendChild(groupLabel);

    const makeInput = (axis: string): HTMLInputElement => {
      const wrapper = document.createElement('div');
      wrapper.className = 'inspector-field';

      const axisLabel = document.createElement('span');
      axisLabel.className = 'inspector-field-label';
      axisLabel.textContent = axis.toUpperCase();

      const input = document.createElement('input');
      input.type = 'number';
      input.className = 'inspector-input';
      input.step = '0.01';
      input.dataset.property = property;
      input.dataset.axis = axis;

      // Uncommitted text: keep refreshes from overwriting what is being typed.
      input.addEventListener('input', () => {
        input.dataset.dirty = '1';
      });

      input.addEventListener('change', () => {
        delete input.dataset.dirty;
        if (!this.currentObjectId) return;
        const newValue = parseInspectorValue(input.value);
        if (newValue === null) {
          // Empty or unparseable text is NOT the number 0 — restore the value
          // the module actually has instead of collapsing the axis.
          this.refreshValues();
          return;
        }
        this.emitSetTransformCommand(property, axis, newValue);
      });

      // Blur normalises the field to the value that was really applied.
      input.addEventListener('blur', () => {
        delete input.dataset.dirty;
        this.refreshValues();
      });

      wrapper.appendChild(axisLabel);
      wrapper.appendChild(input);
      group.appendChild(wrapper);

      return input;
    };

    const x = makeInput('x');
    const y = makeInput('y');
    const z = makeInput('z');

    this.contentEl.appendChild(group);

    return { x, y, z };
  }

  /**
   * Compact uniform-scale control: "All −" / "All +".
   * One click applies a fixed multiplier (−10% / +10%) to all three axes.
   */
  private createScaleAllControl(): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'inspector-field inspector-scale-all';

    const label = document.createElement('span');
    label.className = 'inspector-field-label';
    label.textContent = 'All';
    wrapper.appendChild(label);

    const makeButton = (symbol: string, title: string, factor: number): HTMLButtonElement => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'inspector-scale-all__btn';
      button.textContent = symbol;
      button.title = title;
      button.setAttribute('aria-label', title);
      button.addEventListener('click', () => this.emitScaleAllCommand(factor));
      return button;
    };

    wrapper.appendChild(makeButton('−', 'Scale all axes down by 10%', 0.9));
    wrapper.appendChild(makeButton('+', 'Scale all axes up by 10%', 1.1));

    return wrapper;
  }

  /**
   * Apply a uniform multiplier to the current scale of all three axes.
   * Uses SCALE_FACTOR (the same multiplicative operation CV scaling uses),
   * so existing — possibly unequal — X/Y/Z values keep their proportions.
   */
  private emitScaleAllCommand(factor: number): void {
    if (!this.currentObjectId) return;

    const cmd: TransformCommand = {
      commandId: `inspector-scale-all-${Date.now()}`,
      source: 'INSPECTOR',
      objectId: this.currentObjectId,
      operation: 'SCALE_FACTOR',
      property: 'SCALE',
      values: { x: factor, y: factor, z: factor },
      history: 'RECORD',
    };

    this.eventBus.emit('ui:transform-command', cmd);
  }

  /**
   * Emit a SET transform command that preserves unchanged axes.
   * Reads the current scene transform directly from the TransformService
   * so we always have the real-time state, then modifies only the changed axis.
   */
  private emitSetTransformCommand(property: string, axis: string, newValue: number): void {
    if (!this.currentObjectId) return;

    // Read current scene transform — this is always the real-time state
    const sceneTransform = this.transformService.getTransform(this.currentObjectId);
    const values: Vector3Value = { x: 0, y: 0, z: 0 };

    if (property === 'position' && sceneTransform) {
      values.x = sceneTransform.position.x;
      values.y = sceneTransform.position.y;
      values.z = sceneTransform.position.z;
    } else if (property === 'scale' && sceneTransform) {
      values.x = sceneTransform.scale.x;
      values.y = sceneTransform.scale.y;
      values.z = sceneTransform.scale.z;
    } else if (property === 'rotation' && sceneTransform) {
      // Scene stores radians, user types degrees — preserve other axes in radians
      values.x = sceneTransform.rotationRadians.x;
      values.y = sceneTransform.rotationRadians.y;
      values.z = sceneTransform.rotationRadians.z;
    }

    // Set the changed axis (rotation: user types degrees, convert to radians)
    if (property === 'rotation') {
      (values as any)[axis] = newValue * (Math.PI / 180);
    } else {
      (values as any)[axis] = newValue;
    }

    const cmd: TransformCommand = {
      commandId: `inspector-${Date.now()}`,
      source: 'INSPECTOR',
      objectId: this.currentObjectId,
      operation: 'SET',
      property: property.toUpperCase() as 'POSITION' | 'ROTATION' | 'SCALE',
      values,
      history: 'RECORD',
    };

    this.eventBus.emit('ui:transform-command', cmd);
  }

  refresh(): void {
    const hasSelection = this.currentObjectId !== null;
    this.emptyState.style.display = hasSelection ? 'none' : 'flex';
    this.contentEl.style.display = hasSelection ? 'block' : 'none';

    // A selection change ends any edit in progress — drop the uncommitted
    // markers so they cannot suppress a later refresh.
    this.clearDirtyFlags();

    if (hasSelection) {
      try {
        const viewModel = this.displayAdapter.getInspectorViewModel(this.currentObjectId);
        this.nameEl.textContent = viewModel.name || 'Unknown';
      } catch (e) {
        console.error('[Inspector] refresh view model error:', e);
        this.nameEl.textContent = 'Unknown';
      }
      this.refreshValues();
    } else {
      this.nameEl.textContent = 'No Selection';
      this.clearValues();
    }
  }

  /**
   * Write the scene values into the fields.
   *
   * `keepFocused` is used for `transform:changed` refreshes: a field holding
   * uncommitted text is left untouched, so an incoming transform (CV frame,
   * group move, Scale All) can no longer erase half-typed digits. Selection
   * changes, Undo/Redo and committed edits still update every field.
   */
  private refreshValues(keepFocused = false): void {
    if (!this.currentObjectId) return;

    try {
      const viewModel = this.displayAdapter.getInspectorViewModel(this.currentObjectId);

      if (viewModel.move) {
        this.writeValue(this.moveInputs.x, viewModel.move.x, keepFocused);
        this.writeValue(this.moveInputs.y, viewModel.move.y, keepFocused);
        this.writeValue(this.moveInputs.z, viewModel.move.z, keepFocused);
      }

      if (viewModel.scale) {
        this.writeValue(this.scaleInputs.x, viewModel.scale.x, keepFocused);
        this.writeValue(this.scaleInputs.y, viewModel.scale.y, keepFocused);
        this.writeValue(this.scaleInputs.z, viewModel.scale.z, keepFocused);
      }

      if (viewModel.rotationDegrees) {
        this.writeValue(this.rotationInputs.x, viewModel.rotationDegrees.x, keepFocused);
        this.writeValue(this.rotationInputs.y, viewModel.rotationDegrees.y, keepFocused);
        this.writeValue(this.rotationInputs.z, viewModel.rotationDegrees.z, keepFocused);
      }
    } catch (e) {
      console.error('[Inspector] refreshValues error:', e);
    }
  }

  private writeValue(input: HTMLInputElement, value: number, keepFocused: boolean): void {
    // Only text the user has not committed yet is protected — a merely focused
    // field still follows Undo/Redo and CV frames.
    if (keepFocused && input.dataset.dirty === '1') return;
    input.value = formatInspectorValue(value);
  }

  /** Forget "user is still typing" markers on every field. */
  private clearDirtyFlags(): void {
    for (const group of [this.moveInputs, this.scaleInputs, this.rotationInputs]) {
      for (const input of [group.x, group.y, group.z]) {
        delete input.dataset.dirty;
      }
    }
  }

  private clearValues(): void {
    this.clearDirtyFlags();
    this.moveInputs.x.value = '';
    this.moveInputs.y.value = '';
    this.moveInputs.z.value = '';
    this.scaleInputs.x.value = '';
    this.scaleInputs.y.value = '';
    this.scaleInputs.z.value = '';
    this.rotationInputs.x.value = '';
    this.rotationInputs.y.value = '';
    this.rotationInputs.z.value = '';
  }
}
