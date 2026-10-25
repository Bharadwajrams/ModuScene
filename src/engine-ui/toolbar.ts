/**
 * Module Builder V1.1 — Toolbar
 *
 * Provides import, export, duplicate, delete, undo, redo operations.
 * Buttons route through commands and contracts.
 *
 * Source of truth: Doc 01 §7, Doc 02 §9
 */

// ─── Toolbar ─────────────────────────────────────────────

export interface ToolbarCallbacks {
  onImportFiles: (files: FileList) => void;
  onImportFolder: (files: FileList) => void;
  onExport: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onDuplicate?: () => void;
  onDelete?: () => void;
}

export class Toolbar {
  private container: HTMLElement;
  private callbacks: ToolbarCallbacks;
  private fileInput: HTMLInputElement;
  private folderInput: HTMLInputElement;

  constructor(_eventBus: unknown, container: HTMLElement, callbacks: ToolbarCallbacks) {
    this.container = container;
    this.callbacks = callbacks;

    // Hidden file inputs
    this.fileInput = document.createElement('input');
    this.fileInput.type = 'file';
    this.fileInput.accept = '.glb,.gltf';
    this.fileInput.multiple = true;
    this.fileInput.style.display = 'none';
    this.fileInput.addEventListener('change', () => {
      if (this.fileInput.files && this.fileInput.files.length > 0) {
        this.callbacks.onImportFiles(this.fileInput.files);
        this.fileInput.value = '';
      }
    });

    this.folderInput = document.createElement('input');
    this.folderInput.type = 'file';
    this.folderInput.setAttribute('webkitdirectory', '');
    this.folderInput.multiple = true;
    this.folderInput.style.display = 'none';
    this.folderInput.addEventListener('change', () => {
      if (this.folderInput.files && this.folderInput.files.length > 0) {
        this.callbacks.onImportFolder(this.folderInput.files);
        this.folderInput.value = '';
      }
    });

    document.body.appendChild(this.fileInput);
    document.body.appendChild(this.folderInput);

    this.createButtons();
  }

  private createButtons(): void {
    this.container.className = 'toolbar';

    const makeBtn = (label: string, title: string, onClick: () => void): HTMLElement => {
      const btn = document.createElement('button');
      btn.className = 'toolbar-btn';
      btn.textContent = label;
      btn.title = title;
      btn.addEventListener('click', onClick);
      return btn;
    };

    this.container.appendChild(makeBtn('Import', 'Import GLB files', () => this.fileInput.click()));
    this.container.appendChild(makeBtn('Folder', 'Import folder with GLBs + textures', () => this.folderInput.click()));
    this.container.appendChild(makeBtn('Export', 'Export scene as GLB', () => this.callbacks.onExport()));

    // Separator
    const sep = document.createElement('div');
    sep.className = 'toolbar-separator';
    this.container.appendChild(sep);

    this.container.appendChild(makeBtn('Undo', 'Undo last action', () => this.callbacks.onUndo()));
    this.container.appendChild(makeBtn('Redo', 'Redo last undone action', () => this.callbacks.onRedo()));

    // Separator
    const sep2 = document.createElement('div');
    sep2.className = 'toolbar-separator';
    this.container.appendChild(sep2);

    this.container.appendChild(makeBtn('Duplicate', 'Duplicate selected object', () => {
      if (this.callbacks.onDuplicate) {
        this.callbacks.onDuplicate();
      }
    }));

    this.container.appendChild(makeBtn('Delete', 'Delete selected object', () => {
      if (this.callbacks.onDelete) {
        this.callbacks.onDelete();
      }
    }));
  }

  /**
   * Remove hidden file inputs from the DOM.
   */
  dispose(): void {
    this.fileInput.remove();
    this.folderInput.remove();
  }
}
