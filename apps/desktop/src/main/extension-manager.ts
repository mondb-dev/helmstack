import fs from "node:fs";
import path from "node:path";
import { session } from "electron";

export type ExtensionRecord = {
  id: string;
  name: string;
  version: string;
  /** Absolute path to the unpacked extension directory */
  sourcePath: string;
};

type ExtensionIndex = Record<string, string>; // id → sourcePath

/**
 * Manages Chrome/Chromium extensions loaded into the Electron session.
 *
 * Extensions are loaded from `userData/extensions/` on startup.
 * A JSON index file (`extensions-index.json`) maps extension IDs to source
 * paths so they survive app restarts without being bundled.
 *
 * Usage
 * -----
 * 1. Call `loadAllExtensions()` once during app startup (before tabs navigate).
 * 2. Call `loadExtension(path)` at runtime to install an unpacked extension.
 * 3. Call `removeExtension(id)` to unload and forget an extension.
 *
 * Extensions must be unpacked (a directory with manifest.json).
 * CRX files are not supported here — unpack them first.
 */
export class ExtensionManager {
  private readonly partition: string;
  private readonly indexPath: string;

  constructor(userDataPath: string, partition = "persist:default") {
    this.partition = partition;
    this.indexPath = path.join(userDataPath, "extensions-index.json");
  }

  /** Load all previously registered extensions.  Call on app startup. */
  async loadAllExtensions(): Promise<ExtensionRecord[]> {
    const index = this.readIndex();
    const loaded: ExtensionRecord[] = [];

    for (const [, sourcePath] of Object.entries(index)) {
      if (!this.hasManifest(sourcePath)) {
        console.warn(`[ExtensionManager] Skipping ${sourcePath}: no manifest.json`);
        continue;
      }
      try {
        const ext = await this.getSession().loadExtension(sourcePath, { allowFileAccess: true });
        loaded.push({ id: ext.id, name: ext.name, version: ext.version, sourcePath });
        console.log(`[ExtensionManager] Loaded: ${ext.name} (${ext.id})`);
      } catch (err) {
        console.error(`[ExtensionManager] Failed to load ${sourcePath}:`, err);
      }
    }

    return loaded;
  }

  /**
   * Load an unpacked extension from `extensionPath` and register it so it
   * persists across restarts.
   */
  async loadExtension(extensionPath: string): Promise<ExtensionRecord> {
    const resolved = path.resolve(extensionPath);

    if (!this.hasManifest(resolved)) {
      throw new Error(`No manifest.json found at ${resolved}`);
    }

    const ext = await this.getSession().loadExtension(resolved, { allowFileAccess: true });

    // Persist in index
    const index = this.readIndex();
    index[ext.id] = resolved;
    this.writeIndex(index);

    console.log(`[ExtensionManager] Installed: ${ext.name} (${ext.id})`);
    return { id: ext.id, name: ext.name, version: ext.version, sourcePath: resolved };
  }

  /** Unload an extension by ID and remove it from the persistent index. */
  async removeExtension(extensionId: string): Promise<void> {
    await this.getSession().removeExtension(extensionId);

    const index = this.readIndex();
    delete index[extensionId];
    this.writeIndex(index);

    console.log(`[ExtensionManager] Removed extension: ${extensionId}`);
  }

  /** List all extensions currently loaded in the session. */
  async listExtensions(): Promise<ExtensionRecord[]> {
    const index = this.readIndex();
    const loaded = this.getSession().getAllExtensions();

    return loaded.map((ext) => ({
      id: ext.id,
      name: ext.name,
      version: ext.version,
      sourcePath: index[ext.id] ?? ""
    }));
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private getSession() {
    return session.fromPartition(this.partition);
  }

  private hasManifest(dir: string): boolean {
    try {
      return fs.existsSync(path.join(dir, "manifest.json"));
    } catch {
      return false;
    }
  }

  private readIndex(): ExtensionIndex {
    try {
      const raw = fs.readFileSync(this.indexPath, "utf8");
      return JSON.parse(raw) as ExtensionIndex;
    } catch {
      return {};
    }
  }

  private writeIndex(index: ExtensionIndex) {
    fs.writeFileSync(this.indexPath, JSON.stringify(index, null, 2), "utf8");
  }
}
