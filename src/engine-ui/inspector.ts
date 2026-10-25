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
        this.refreshValues();
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

      input.addEventListener('change', () => {
        if (!this.currentObjectId) return;
        const newValue = parseFloat(input.value) || 0;
        this.emitSetTransformCommand(property, axis, newValue);
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

  private refreshValues(): void {
    if (!this.currentObjectId) return;

    try {
      const viewModel = this.displayAdapter.getInspectorViewModel(this.currentObjectId);

      if (viewModel.move) {
        this.moveInputs.x.value = viewModel.move.x.toFixed(2);
        this.moveInputs.y.value = viewModel.move.y.toFixed(2);
        this.moveInputs.z.value = viewModel.move.z.toFixed(2);
      }

      if (viewModel.scale) {
        this.scaleInputs.x.value = viewModel.scale.x.toFixed(2);
        this.scaleInputs.y.value = viewModel.scale.y.toFixed(2);
        this.scaleInputs.z.value = viewModel.scale.z.toFixed(2);
      }

      if (viewModel.rotationDegrees) {
        this.rotationInputs.x.value = viewModel.rotationDegrees.x.toFixed(2);
        this.rotationInputs.y.value = viewModel.rotationDegrees.y.toFixed(2);
        this.rotationInputs.z.value = viewModel.rotationDegrees.z.toFixed(2);
      }
    } catch (e) {
      console.error('[Inspector] refreshValues error:', e);
    }
  }

  private clearValues(): void {
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
