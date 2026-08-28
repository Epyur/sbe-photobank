import { App } from 'obsidian';
import type { PhotobankDbData, PhotoFolder, PhotoItem, PhotoGroup, SchemaField } from '../types/photobank';
import { errorMessage } from '../../../sbe-core/src/utils/errors';

const DB_DIR = 'yourbase/sbe_photobank';
const DB_PATH = 'yourbase/sbe_photobank/photos_data.json';

const EMPTY: PhotobankDbData = { folders: [], photos: [], groups: [], schema: [] };

/** Локальная БД фотобанка (кэш метаданных; сервер — каноническое хранилище). */
export class PhotobankDatabase {
  private app: App;
  private data: PhotobankDbData = { folders: [], photos: [], groups: [], schema: [] };

  constructor(app: App) {
    this.app = app;
  }

  async init(): Promise<void> {
    const adapter = this.app.vault.adapter;
    try {
      const exists = await adapter.exists(DB_PATH);
      if (exists) {
        const content = await adapter.read(DB_PATH);
        const parsed = JSON.parse(content) as Partial<PhotobankDbData>;
        this.data = {
          folders: Array.isArray(parsed.folders) ? parsed.folders : [],
          photos: Array.isArray(parsed.photos) ? parsed.photos : [],
          groups: Array.isArray(parsed.groups) ? parsed.groups : [],
          schema: Array.isArray(parsed.schema) ? parsed.schema : [],
        };
      }
    } catch (e: unknown) {
      console.error('Фотобанк: не удалось прочитать БД:', errorMessage(e));
    }
  }

  private async ensureDataDir(): Promise<void> {
    const adapter = this.app.vault.adapter;
    const exists = await adapter.exists(DB_DIR);
    if (!exists) {
      await adapter.mkdir(DB_DIR);
    }
  }

  async save(): Promise<void> {
    try {
      await this.ensureDataDir();
      await this.app.vault.adapter.write(DB_PATH, JSON.stringify(this.data, null, 2));
    } catch (e: unknown) {
      console.error('Фотобанк: не удалось сохранить БД:', errorMessage(e));
    }
  }

  getAllPhotos(): PhotoItem[] {
    return this.data.photos;
  }

  getPhoto(id: number): PhotoItem | undefined {
    return this.data.photos.find(p => p.id === id);
  }

  getFolders(): PhotoFolder[] {
    return this.data.folders;
  }

  getFolder(id: number): PhotoFolder | undefined {
    return this.data.folders.find(f => f.id === id);
  }

  /** Дерево папок: {parent_id: [folders]}. */
  folderTree(): Map<number, PhotoFolder[]> {
    const tree = new Map<number, PhotoFolder[]>();
    for (const f of this.data.folders) {
      const arr = tree.get(f.parent_id) || [];
      arr.push(f);
      tree.set(f.parent_id, arr);
    }
    return tree;
  }

  getGroups(): PhotoGroup[] {
    return this.data.groups;
  }

  getSchema(): SchemaField[] {
    return this.data.schema;
  }

  addPhoto(photo: PhotoItem): void {
    const idx = this.data.photos.findIndex(p => p.id === photo.id);
    if (idx !== -1) {
      this.data.photos[idx] = photo;
    } else {
      this.data.photos.push(photo);
    }
  }

  updatePhoto(id: number, updates: Partial<PhotoItem>): void {
    const idx = this.data.photos.findIndex(p => p.id === id);
    if (idx !== -1) {
      this.data.photos[idx] = { ...this.data.photos[idx], ...updates };
    }
  }

  deletePhoto(id: number): void {
    this.data.photos = this.data.photos.filter(p => p.id !== id);
  }

  setFolders(folders: PhotoFolder[]): void {
    this.data.folders = folders;
  }

  addFolder(folder: PhotoFolder): void {
    const idx = this.data.folders.findIndex(f => f.id === folder.id);
    if (idx !== -1) {
      this.data.folders[idx] = folder;
    } else {
      this.data.folders.push(folder);
    }
  }

  deleteFolder(id: number): void {
    this.data.folders = this.data.folders.filter(f => f.id !== id);
    this.data.photos = this.data.photos.filter(p => p.folder_id !== id);
  }

  setGroups(groups: PhotoGroup[]): void {
    this.data.groups = groups;
  }

  setSchema(schema: SchemaField[]): void {
    this.data.schema = schema;
  }

  /** Слияние фото с сервера (канон). Сервер авторитетен при равном/новом updated_at. */
  mergeFromServer(serverPhotos: PhotoItem[]): void {
    for (const s of serverPhotos) {
      // Дедуп: локальная карточка с id<=0 (не синхронизированная) и тем же
      // content_hash, что у серверной — устаревший дубль (сервер назначил свой id
      // при push). Убираем его, серверная запись становится каноном.
      if (s.content_hash) {
        const dupe = this.data.photos.find(
          p => p !== undefined && p.content_hash === s.content_hash && p.id !== s.id,
        );
        if (dupe && dupe.id <= 0) {
          this.deletePhoto(dupe.id);
        }
      }
      const local = this.getPhoto(s.id);
      if (!local) {
        this.addPhoto({ ...s, sync_status: 'synced' });
        continue;
      }
      if (this.compareTime(s.updated_at, local.updated_at) >= 0) {
        const idx = this.data.photos.indexOf(local);
        this.data.photos[idx] = { ...s, sync_status: 'synced' };
      }
    }
  }

  /** Удаляет локальные карточки, которых нет на сервере (сервер — канон). */
  pruneMissing(serverIds: Set<number>): number {
    const before = this.data.photos.length;
    this.data.photos = this.data.photos.filter(p => serverIds.has(p.id));
    return before - this.data.photos.length;
  }

  private compareTime(a: string, b: string): number {
    const ta = new Date(a).getTime();
    const tb = new Date(b).getTime();
    if (Number.isNaN(ta) || Number.isNaN(tb)) return 0;
    return ta === tb ? 0 : ta > tb ? 1 : -1;
  }

  /** Возвращает объект с данными (для тестов/отладки). */
  get raw(): PhotobankDbData {
    return this.data;
  }
}

export { EMPTY };
