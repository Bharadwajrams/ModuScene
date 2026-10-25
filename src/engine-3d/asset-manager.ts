/**
 * Module Builder V1.1 — Asset Manager
 *
 * Owns: GLB/GLTF import catalog, texture resolution, asset registry.
 * Importing a file registers it in the Asset Library catalog.
 * The user must explicitly add an asset to the scene.
 *
 * Source of truth: Doc 01 §14, Doc 02 §6, Doc 05 §11
 */

import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import type { AssetRecord, AssetId, TextureStatus } from '../core/contracts';
import { SceneManager } from './scene-manager';

// ─── Folder texture resolution ───────────────────────────

/** One image entry of the glTF JSON (embedded bufferView or external uri). */
interface GltfImageDef {
  uri?: string;
  bufferView?: number;
}

/** Files available while importing a folder, indexed for resource lookup. */
interface FolderResources {
  /** Lowercased, slash-separated relative path → file. */
  byPath: Map<string, File>;
  /** Lowercased basename → files (fallback when a model's path is off). */
  byName: Map<string, File[]>;
}

/** Result of inspecting every image reference of one model. */
interface TextureAnalysis {
  imageCount: number;
  embeddedCount: number;
  externalCount: number;
  resolvedCount: number;
  /** External image references that could not be resolved in the folder. */
  missing: string[];
}

// ─── Asset Manager ───────────────────────────────────────

export class AssetManager {
  private loader: GLTFLoader;
  private sceneManager: SceneManager;
  private assets = new Map<AssetId, AssetRecord>();
  /** Cache loaded GLTF scenes for re-instantiation */
  private gltfCache = new Map<AssetId, GLTF>();
  /** Built-in basic shapes (Cube / Sphere / Cone) — fresh mesh per instance. */
  private shapeFactories = new Map<AssetId, () => THREE.Mesh>();
  private nextAssetId = 1;
  private warnings: string[] = [];

  constructor(sceneManager: SceneManager) {
    this.loader = new GLTFLoader();
    this.sceneManager = sceneManager;
    this.registerBasicShapes();
  }

  /**
   * Register the built-in basic shapes (Cube / Sphere / Cone) in the catalog.
   * They behave exactly like imported assets in the library: listed, clickable,
   * instantiable via addToScene(). A fresh mesh is built per instance so
   * selection/transform/dispose never share geometry between objects.
   */
  private registerBasicShapes(): void {
    const material = () =>
      new THREE.MeshStandardMaterial({ color: 0x93a7c4, roughness: 0.6, metalness: 0.05 });

    const shapes: Array<[string, string, () => THREE.Mesh]> = [
      ['Cube', 'shape-cube', () => new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material())],
      ['Sphere', 'shape-sphere', () => new THREE.Mesh(new THREE.SphereGeometry(0.6, 32, 24), material())],
      ['Cone', 'shape-cone', () => {
        const cone = new THREE.Mesh(new THREE.ConeGeometry(0.6, 1.2, 32), material());
        cone.position.y = 0.6; // rest on the ground plane like imported modules
        return cone;
      }],
    ];

    for (const [name, id, factory] of shapes) {
      const assetId = id as AssetId;
      this.assets.set(assetId, {
        assetId,
        name,
        sourceType: 'PRIMITIVE',
        textureStatus: 'NOT_APPLICABLE',
        loadStatus: 'AVAILABLE',
      });
      this.shapeFactories.set(assetId, factory);
    }
  }

  /**
   * Import a GLB/GLTF file into the Asset Library catalog.
   * Does NOT place it in the scene. Returns the asset ID.
   *
   * A single-file import keeps the original behavior (self-contained files
   * only). Folder imports pass the selected files so external textures can
   * be resolved against the folder tree.
   */
  async importToCatalog(file: File): Promise<AssetId | null> {
    return this.importAsset(file, null);
  }

  private async importAsset(file: File, resources: FolderResources | null): Promise<AssetId | null> {
    const assetId = `asset-${this.nextAssetId++}` as AssetId;

    const record: AssetRecord = {
      assetId,
      name: file.name.replace(/\.(glb|gltf)$/i, ''),
      sourceType: file.name.toLowerCase().endsWith('.glb') ? 'GLB' : 'GLTF',
      sourcePath: file.name,
      textureStatus: 'NOT_APPLICABLE',
      loadStatus: 'LOADING',
    };
    this.assets.set(assetId, record);

    try {
      const buffer = await file.arrayBuffer();

      // Inspect each image reference individually (embedded vs external).
      const analysis = resources ? this.analyzeTextures(buffer, file, resources) : null;
      const baseDir = resources ? this.getModelDirectory(file) : '';

      // Folder imports resolve referenced folder files through a per-import
      // loader; single-file imports keep the original loader untouched.
      const folderLoader = resources ? this.createFolderLoader(resources, baseDir) : null;
      let gltf: GLTF;
      try {
        const loader = folderLoader?.loader ?? this.loader;
        gltf = await new Promise<GLTF>((resolve, reject) => {
          loader.parse(buffer, baseDir, (r) => resolve(r), (e) => reject(e));
        });
      } finally {
        folderLoader?.revokeObjectUrls();
      }

      // Cache the loaded GLTF for later instantiation
      this.gltfCache.set(assetId, gltf);

      // Texture status comes from the references when the folder was scanned,
      // otherwise from the loaded materials (original behavior).
      const textureStatus: TextureStatus = analysis
        ? this.textureStatusFromAnalysis(analysis)
        : this.detectTextureStatus(gltf);

      if (analysis && analysis.missing.length > 0) {
        const listed = analysis.missing.slice(0, 3).join(', ');
        const more = analysis.missing.length > 3 ? ` (+${analysis.missing.length - 3} more)` : '';
        this.warnings.push(
          `${record.name} — missing ${analysis.missing.length} texture(s): ${listed}${more}`,
        );
        console.warn(`[AssetManager] Missing textures for ${record.name}: ${analysis.missing.join(', ')}`);
      }

      record.textureStatus = textureStatus;
      record.loadStatus = 'AVAILABLE';

      console.log(`[AssetManager] Imported to catalog: ${record.name} (${textureStatus})`);
      return assetId;
    } catch (error) {
      record.loadStatus = 'FAILED';
      console.error(`[AssetManager] Failed to import: ${file.name}`, error);
      return null;
    }
  }

  /** Collect loaded-material texture status (single-file import path). */
  private detectTextureStatus(gltf: GLTF): TextureStatus {
    let textureStatus: TextureStatus = 'NOT_APPLICABLE';
    gltf.scene.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        const mat = child.material;
        if (mat instanceof THREE.MeshStandardMaterial || mat instanceof THREE.MeshPhongMaterial) {
          if (mat.map) {
            textureStatus = 'EMBEDDED';
          }
        }
      }
    });
    return textureStatus;
  }

  /** Translate a per-image analysis into an asset texture status. */
  private textureStatusFromAnalysis(analysis: TextureAnalysis): TextureStatus {
    if (analysis.imageCount === 0) return 'NOT_APPLICABLE';
    if (analysis.missing.length > 0) return 'MISSING';
    if (analysis.externalCount > 0) return 'RESOLVED';
    return 'EMBEDDED';
  }

  /** Read the glTF JSON chunk (GLB) or the JSON text (.gltf). */
  private readGltfJson(buffer: ArrayBuffer): { images?: GltfImageDef[] } | null {
    try {
      const bytes = new Uint8Array(buffer);
      const view = new DataView(buffer);

      // GLB: 12-byte header, then chunk length + chunk type + JSON chunk.
      if (bytes.byteLength > 20 && view.getUint32(0, true) === 0x46546c67 /* glTF */) {
        const chunkLength = view.getUint32(12, true);
        const chunkType = view.getUint32(16, true);
        if (chunkType !== 0x4e4f534a /* JSON */) return null;
        const text = new TextDecoder().decode(bytes.subarray(20, 20 + chunkLength));
        return JSON.parse(text);
      }

      return JSON.parse(new TextDecoder().decode(bytes));
    } catch (error) {
      console.warn('[AssetManager] Could not read glTF JSON for texture analysis', error);
      return null;
    }
  }

  /**
   * Inspect every image reference of a model individually:
   * embedded (bufferView / data URI) or external (folder-relative uri).
   */
  private analyzeTextures(
    buffer: ArrayBuffer,
    file: File,
    resources: FolderResources,
  ): TextureAnalysis | null {
    const json = this.readGltfJson(buffer);
    if (!json) return null;

    const images: GltfImageDef[] = Array.isArray(json.images) ? json.images : [];
    const analysis: TextureAnalysis = {
      imageCount: images.length,
      embeddedCount: 0,
      externalCount: 0,
      resolvedCount: 0,
      missing: [],
    };
    const baseDir = this.getModelDirectory(file);

    for (const image of images) {
      const uri = typeof image?.uri === 'string' ? image.uri.trim() : '';

      // No uri → stored in the GLB buffer (embedded). A data URI is embedded
      // as well, even when it appears in a .gltf file.
      if (uri === '' || /^data:/i.test(uri)) {
        analysis.embeddedCount++;
        continue;
      }

      analysis.externalCount++;
      if (this.resolveFolderFile(uri, resources, baseDir)) {
        analysis.resolvedCount++;
      } else {
        analysis.missing.push(uri);
      }
    }

    return analysis;
  }

  /** Index every file of the imported folder for external resource lookup. */
  private buildFolderResources(files: File[]): FolderResources {
    const byPath = new Map<string, File>();
    const byName = new Map<string, File[]>();

    for (const file of files) {
      const relativePath =
        (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
      const key = this.normalizeResourcePath(relativePath);
      byPath.set(key, file);

      const name = key.slice(key.lastIndexOf('/') + 1);
      const bucket = byName.get(name);
      if (bucket) bucket.push(file);
      else byName.set(name, [file]);
    }

    return { byPath, byName };
  }

  /** Directory of a model inside the imported folder (trailing slash). */
  private getModelDirectory(file: File): string {
    const relativePath =
      (file as File & { webkitRelativePath?: string }).webkitRelativePath || '';
    const slash = relativePath.lastIndexOf('/');
    return slash >= 0 ? relativePath.slice(0, slash + 1) : '';
  }

  /** Lowercase, slash-separated, query/hash-free resource path. */
  private normalizeResourcePath(path: string): string {
    let cleaned = path.trim();
    try {
      cleaned = decodeURIComponent(cleaned);
    } catch {
      // Keep the raw value for malformed escapes.
    }
    cleaned = cleaned.split('#')[0].split('?')[0].replace(/\\/g, '/');
    return this.joinResourcePath('', cleaned);
  }

  /** Join path segments, collapsing '.' and '..'. */
  private joinResourcePath(baseDir: string, relativePath: string): string {
    const segments = `${baseDir}/${relativePath}`.split('/');
    const parts: string[] = [];
    for (const segment of segments) {
      if (segment === '' || segment === '.') continue;
      if (segment === '..') {
        parts.pop();
        continue;
      }
      parts.push(segment);
    }
    return parts.join('/').toLowerCase();
  }

  /**
   * Find the folder file a glTF resource URI points at.
   * Tries the path as written, then relative to the model, then by basename
   * anywhere in the imported folder tree (covers reorganized exports).
   */
  private resolveFolderFile(
    uri: string,
    resources: FolderResources,
    baseDir: string,
  ): File | undefined {
    if (/^(data:|blob:|https?:|\/\/)/i.test(uri)) return undefined;

    const normalized = this.normalizeResourcePath(uri);
    const candidates = [normalized];
    if (baseDir) candidates.push(this.joinResourcePath(baseDir, normalized));

    for (const candidate of candidates) {
      const file = resources.byPath.get(candidate);
      if (file) return file.size > 0 ? file : undefined;
    }

    const basename = normalized.slice(normalized.lastIndexOf('/') + 1);
    const matches = resources.byName.get(basename);
    if (matches && matches.length > 0) {
      const usable = matches.find((file) => file.size > 0);
      if (usable) return usable;
    }

    return undefined;
  }

  /**
   * Loader for one folder import: resolves every requested resource URI to
   * the matching folder file (as an object URL). Unresolved textures fall
   * through unchanged, so three loads the rest of the model untextured.
   */
  private createFolderLoader(
    resources: FolderResources,
    baseDir: string,
  ): { loader: GLTFLoader; revokeObjectUrls: () => void } {
    const manager = new THREE.LoadingManager();
    const objectUrls: string[] = [];

    manager.setURLModifier((url: string) => {
      if (/^(data:|blob:)/i.test(url)) return url;

      const file = this.resolveFolderFile(url, resources, baseDir);
      if (!file) return url;

      const objectUrl = URL.createObjectURL(file);
      objectUrls.push(objectUrl);
      return objectUrl;
    });

    return {
      loader: new GLTFLoader(manager),
      revokeObjectUrls: () => {
        for (const url of objectUrls) URL.revokeObjectURL(url);
        objectUrls.length = 0;
      },
    };
  }

  /**
   * Add a cached asset instance to the scene.
   * This is the explicit "Add to scene" action.
   */
  addToScene(assetId: AssetId): string | null {
    // Built-in basic shape: build a fresh mesh and add it
    const shapeFactory = this.shapeFactories.get(assetId);
    if (shapeFactory) {
      const record = this.assets.get(assetId);
      const objectId = this.sceneManager.addObject(shapeFactory(), record?.name || 'Shape');
      console.log(`[AssetManager] Added shape to scene: ${record?.name} as ${objectId}`);
      return objectId;
    }

    const gltf = this.gltfCache.get(assetId);
    if (!gltf) return null;

    const record = this.assets.get(assetId);
    const name = record?.name || 'Unnamed';

    // Clone the scene to allow multiple instances
    const clone = gltf.scene.clone(true);
    const objectId = this.sceneManager.addObject(clone, name);

    console.log(`[AssetManager] Added to scene: ${name} as ${objectId}`);
    return objectId;
  }

  /**
   * Import a folder: register all GLB/GLTF files in the catalog.
   * Does NOT auto-place anything in the scene.
   */
  async importFolder(files: FileList | File[]): Promise<AssetId[]> {
    const importedIds: AssetId[] = [];
    const fileList = Array.from(files);

    // Fresh warning set for this folder import.
    this.warnings = [];

    // Index the whole folder (including subfolders) so external textures can
    // be resolved while each model loads.
    const resources = this.buildFolderResources(fileList);

    for (const file of fileList) {
      if (file.name.toLowerCase().match(/\.(glb|gltf)$/)) {
        const id = await this.importAsset(file, resources);
        if (id) importedIds.push(id);
      }
    }

    return importedIds;
  }

  /** True when the catalog asset is a built-in basic shape. */
  isBasicShape(assetId: AssetId): boolean {
    return this.shapeFactories.has(assetId);
  }

  /** Get asset record by ID */
  getAsset(assetId: AssetId): AssetRecord | undefined {
    return this.assets.get(assetId);
  }

  /** Get all catalog assets */
  getAllAssets(): AssetRecord[] {
    return Array.from(this.assets.values());
  }

  /** Get texture warnings */
  getWarnings(): string[] {
    return [...this.warnings];
  }

  /** Clear warnings */
  clearWarnings(): void {
    this.warnings = [];
  }

  /** Asset count */
  get assetCount(): number {
    return this.assets.size;
  }

  /** Dispose */
  dispose(): void {
    this.assets.clear();
    this.gltfCache.clear();
    this.warnings = [];
  }
}
