import { requestUrl, RequestUrlParam } from 'obsidian';
import { getService } from '../../../sbe-core/src/bridge';
import { errorMessage } from '../../../sbe-core/src/utils/errors';
import type { PhotobankDatabase } from '../database/photobank-db';
import type {
  PhotoItem, PullResponse, PushResponse, UploadFileResponse,
  MyPermission, PhotoFolder, PhotoFolderPerm, PhotoGroup, SchemaField, PhotoComment,
} from '../types/photobank';

export interface SyncResult {
  pushed: number;
  pulled: number;
}

/** Синхронизация с photo-service через JWT из ЦУП. Сервер — канон, локально — кэш. */
export class PhotobankSyncService {
  private db: PhotobankDatabase;
  private getApiUrl: () => string;

  constructor(db: PhotobankDatabase, getApiUrl: () => string) {
    this.db = db;
    this.getApiUrl = getApiUrl;
  }

  get baseUrl(): string {
    return this.getApiUrl().trim().replace(/\/+$/, '');
  }

  async sync(): Promise<SyncResult> {
    const token = await this.getToken();
    const dirty = this.db.getAllPhotos().filter(p => p.sync_status === 'local');
    let pushed = 0;
    if (dirty.length > 0) {
      const res = await this.push(token, dirty);
      pushed = res.inserted + res.updated;
      for (const p of dirty) p.sync_status = 'synced';
      await this.db.save();
    }
    const pulled = await this.pull(token);
    this.db.mergeFromServer(pulled.photos);
    await this.db.save();
    return { pushed, pulled: pulled.photos.length };
  }

  /** Pull без push (для фонового обновления). */
  async pullAndMerge(): Promise<number> {
    const token = await this.getToken();
    const pulled = await this.pull(token);
    this.db.mergeFromServer(pulled.photos);
    await this.db.save();
    return pulled.photos.length;
  }

  /** Полная синхронизация метаданных: фото + папки + группы + схема. */
  async syncAll(): Promise<SyncResult> {
    const token = await this.getToken();
    const dirty = this.db.getAllPhotos().filter(p => p.sync_status === 'local');
    let pushed = 0;
    if (dirty.length > 0) {
      const res = await this.push(token, dirty);
      pushed = res.inserted + res.updated;
      for (const p of dirty) p.sync_status = 'synced';
    }
    const pulled = await this.pull(token);
    this.db.mergeFromServer(pulled.photos);
    await this.fetchFolders(token);
    await this.fetchGroups(token);
    await this.fetchSchema(token);
    await this.db.save();
    return { pushed, pulled: pulled.photos.length };
  }

  /** Публичный доступ к JWT (для pushLocal отдельных карточек из view). */
  async getToken(): Promise<string> {
    const apstore = await getService('sbe-apstore');
    return apstore.auth.getToken('photo');
  }

  async push(token: string, photos: PhotoItem[]): Promise<PushResponse> {
    const body = JSON.stringify({ photos });
    console.debug('[sbe-photobank][debug] POST /api/photo/sync/push body:', body);
    const res = await this.request({
      url: `${this.baseUrl}/api/photo/sync/push`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body,
    });
    this.assertOk(res);
    try {
      return JSON.parse(res.text) as PushResponse;
    } catch (e: unknown) {
      console.warn('Фотобанк: не JSON в ответе push:', errorMessage(e));
      return { inserted: 0, updated: 0 };
    }
  }

  async pull(token: string): Promise<PullResponse> {
    const res = await this.request({
      url: `${this.baseUrl}/api/photo/sync/pull`,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    this.assertOk(res);
    try {
      return JSON.parse(res.text) as PullResponse;
    } catch (e: unknown) {
      console.warn('Фотобанк: не JSON в ответе pull:', errorMessage(e));
      return { photos: [] };
    }
  }

  /** Список видимых папок (сервер). */
  async fetchFolders(token: string): Promise<PhotoFolder[]> {
    const res = await this.request({
      url: `${this.baseUrl}/api/photo/folders`,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    this.assertOk(res);
    try {
      const data = JSON.parse(res.text) as { folders?: PhotoFolder[] };
      const folders = Array.isArray(data.folders) ? data.folders : [];
      this.db.setFolders(folders);
      return folders;
    } catch (e: unknown) {
      console.warn('Фотобанк: не JSON в ответе folders:', errorMessage(e));
      return [];
    }
  }

  /** Список групп. */
  async fetchGroups(token: string): Promise<PhotoGroup[]> {
    const res = await this.request({
      url: `${this.baseUrl}/api/photo/groups`,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    this.assertOk(res);
    try {
      const data = JSON.parse(res.text) as { groups?: PhotoGroup[] };
      const groups = Array.isArray(data.groups) ? data.groups : [];
      this.db.setGroups(groups);
      return groups;
    } catch (e: unknown) {
      console.warn('Фотобанк: не JSON в ответе groups:', errorMessage(e));
      return [];
    }
  }

  /** Схема своих полей. */
  async fetchSchema(token: string): Promise<SchemaField[]> {
    const res = await this.request({
      url: `${this.baseUrl}/api/photo/schema`,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    this.assertOk(res);
    try {
      const data = JSON.parse(res.text) as { fields?: SchemaField[] };
      const fields = Array.isArray(data.fields) ? data.fields : [];
      this.db.setSchema(fields);
      return fields;
    } catch (e: unknown) {
      console.warn('Фотобанк: не JSON в ответе schema:', errorMessage(e));
      return [];
    }
  }

  /** Права текущего пользователя. */
  async getMyPermission(): Promise<MyPermission> {
    const token = await this.getToken();
    const res = await this.request({
      url: `${this.baseUrl}/api/photo/permissions/me`,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    this.assertOk(res);
    try {
      return JSON.parse(res.text) as MyPermission;
    } catch (e: unknown) {
      console.warn('Фотобанк: не JSON в ответе permissions/me:', errorMessage(e));
      return { email: '', role: '', hasAccess: false };
    }
  }

  /** Список глобальных ролей (admin). */
  async listPermissions(): Promise<Array<{ email: string; role: string }>> {
    const token = await this.getToken();
    const res = await this.request({
      url: `${this.baseUrl}/api/photo/permissions`,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    this.assertOk(res);
    try {
      const data = JSON.parse(res.text) as { permissions?: Array<{ email: string; role: string }> };
      return Array.isArray(data.permissions) ? data.permissions : [];
    } catch (e: unknown) {
      console.warn('Фотобанк: не JSON в ответе permissions:', errorMessage(e));
      return [];
    }
  }

  /** Устанавливает/отзывает глобальную роль (admin). */
  async setPermission(email: string, role: string): Promise<void> {
    const token = await this.getToken();
    const res = await this.request({
      url: `${this.baseUrl}/api/photo/permissions`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ email, role }),
    });
    this.assertOk(res);
  }

  /** Права папки (admin). */
  async listFolderPerms(folderId: number): Promise<PhotoFolderPerm[]> {
    const token = await this.getToken();
    const res = await this.request({
      url: `${this.baseUrl}/api/photo/folders/${folderId}/permissions`,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    this.assertOk(res);
    try {
      const data = JSON.parse(res.text) as { permissions?: PhotoFolderPerm[] };
      return Array.isArray(data.permissions) ? data.permissions : [];
    } catch (e: unknown) {
      console.warn('Фотобанк: не JSON в ответе folder perms:', errorMessage(e));
      return [];
    }
  }

  /** Назначает доступ на папку (admin). */
  async setFolderPerm(folderId: number, subject: string, role: string): Promise<void> {
    const token = await this.getToken();
    const res = await this.request({
      url: `${this.baseUrl}/api/photo/folders/${folderId}/permissions`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ subject, role }),
    });
    this.assertOk(res);
  }

  /** Включает/выключает «ограниченный доступ» к папке (admin системы или папки). */
  async setFolderLimited(folderId: number, limited: boolean): Promise<void> {
    const token = await this.getToken();
    const res = await this.request({
      url: `${this.baseUrl}/api/photo/folders/${folderId}/limited`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ limited }),
    });
    this.assertOk(res);
  }

  /** Общий уровень доступа («сотрудник» по умолчанию: viewer). */
  async getCommonAccess(): Promise<string> {
    const token = await this.getToken();
    const res = await this.request({
      url: `${this.baseUrl}/api/photo/common-access`,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    this.assertOk(res);
    try {
      const data = JSON.parse(res.text) as { level?: string };
      return data.level || 'viewer';
    } catch (e: unknown) {
      console.warn('Фотобанк: не JSON в ответе common-access:', errorMessage(e));
      return 'viewer';
    }
  }

  /** Устанавливает общий уровень доступа ({level}); "" — закрыть общий доступ. */
  async setCommonAccess(level: string): Promise<void> {
    const token = await this.getToken();
    const res = await this.request({
      url: `${this.baseUrl}/api/photo/common-access`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ level }),
    });
    this.assertOk(res);
  }

  /** Создаёт папку (admin). */
  async createFolder(name: string, parentId: number): Promise<number> {
    const token = await this.getToken();
    const res = await this.request({
      url: `${this.baseUrl}/api/photo/folders`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name, parent_id: parentId }),
    });
    this.assertOk(res);
    try {
      const data = JSON.parse(res.text) as { id?: number };
      return data.id || 0;
    } catch (e: unknown) {
      console.warn('Фотобанк: не JSON в ответе create folder:', errorMessage(e));
      return 0;
    }
  }

  /** Удаляет папку (admin). */
  async deleteFolder(id: number): Promise<void> {
    const token = await this.getToken();
    const res = await this.request({
      url: `${this.baseUrl}/api/photo/folders/${id}`,
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    this.assertOk(res);
  }

  /** Переименовывает папку (admin). */
  async renameFolder(id: number, name: string): Promise<void> {
    const token = await this.getToken();
    const res = await this.request({
      url: `${this.baseUrl}/api/photo/folders/rename`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ id, name }),
    });
    this.assertOk(res);
  }

  /** Создаёт/обновляет группу (admin). */
  async saveGroup(group: PhotoGroup): Promise<void> {
    const token = await this.getToken();
    const res = await this.request({
      url: `${this.baseUrl}/api/photo/groups`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(group),
    });
    this.assertOk(res);
  }

  /** Удаляет группу (admin). */
  async deleteGroup(id: number): Promise<void> {
    const token = await this.getToken();
    const res = await this.request({
      url: `${this.baseUrl}/api/photo/groups/${id}`,
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    this.assertOk(res);
  }

  /** Сохраняет схему своих полей (admin). */
  async setSchema(fields: SchemaField[]): Promise<void> {
    const token = await this.getToken();
    const res = await this.request({
      url: `${this.baseUrl}/api/photo/schema`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ fields }),
    });
    this.assertOk(res);
  }

  /** Свободный поиск (серверный FTS). */
  async search(q: string, folderId?: number, kind?: string): Promise<PhotoItem[]> {
    const token = await this.getToken();
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (folderId && folderId > 0) params.set('folder_id', String(folderId));
    if (kind) params.set('kind', kind);
    const res = await this.request({
      url: `${this.baseUrl}/api/photo/search?${params.toString()}`,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    this.assertOk(res);
    try {
      const data = JSON.parse(res.text) as PullResponse;
      return Array.isArray(data.photos) ? data.photos : [];
    } catch (e: unknown) {
      console.warn('Фотобанк: не JSON в ответе search:', errorMessage(e));
      return [];
    }
  }

  /** Загружает оригинал в S3 через сервис (editor+). Возвращает file_key и миниатюру. */
  async uploadFile(data: ArrayBuffer, fileName: string, folderId: number, kind: string, mimeType: string): Promise<UploadFileResponse> {
    const token = await this.getToken();
    const boundary = '----sbe-photobank-' + Date.now().toString(36);
    const body = this.buildMultipart(data, fileName, folderId, kind, mimeType, boundary);
    const res = await this.request({
      url: `${this.baseUrl}/api/photo/file`,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
    }, 300000);
    this.assertOk(res);
    return JSON.parse(res.text) as UploadFileResponse;
  }

  /** Загружает обложку (пользовательскую) для видео/RAW (editor+). */
  async uploadThumb(data: ArrayBuffer, fileName: string, photoId: number): Promise<{ thumb_key: string }> {
    const token = await this.getToken();
    const boundary = '----sbe-photobank-' + Date.now().toString(36);
    const enc = new TextEncoder();
    const parts: Uint8Array[] = [];
    parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="photo_id"\r\n\r\n${photoId}\r\n`));
    parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
    parts.push(new Uint8Array(data));
    parts.push(enc.encode(`\r\n--${boundary}--\r\n`));
    const out = this.concat(parts);
    const res = await this.request({
      url: `${this.baseUrl}/api/photo/thumb`,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body: out,
    }, 120000);
    this.assertOk(res);
    return JSON.parse(res.text) as { thumb_key: string };
  }

  /** Скачивает файл из S3 через сервис. `view=true` — просмотр превью (не считается
   *  скачиванием, счётчик download_count не растёт); по умолчанию — явное скачивание. */
  async downloadFile(fileKey: string, view = false): Promise<ArrayBuffer> {
    const token = await this.getToken();
    const qs = view ? `?key=${encodeURIComponent(fileKey)}&view=1` : `?key=${encodeURIComponent(fileKey)}`;
    const res = await this.request({
      url: `${this.baseUrl}/api/photo/file${qs}`,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    }, 300000);
    this.assertOk(res);
    return res.arrayBuffer;
  }

  /** Временная публичная ссылка на файл (presigned через rclone). */
  async getFileLink(fileKey: string): Promise<string> {
    const token = await this.getToken();
    const res = await this.request({
      url: `${this.baseUrl}/api/photo/file-link?key=${encodeURIComponent(fileKey)}`,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    }, 60000);
    this.assertOk(res);
    try {
      const data = JSON.parse(res.text) as { url?: string };
      return data.url || '';
    } catch (e: unknown) {
      console.warn('Фотобанк: не JSON в ответе file-link:', errorMessage(e));
      return '';
    }
  }

  /** Комментарии файла. */
  async listComments(photoId: number): Promise<PhotoComment[]> {
    const token = await this.getToken();
    const res = await this.request({
      url: `${this.baseUrl}/api/photo/photos/${photoId}/comments`,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    this.assertOk(res);
    try {
      const data = JSON.parse(res.text) as { comments?: PhotoComment[] };
      return Array.isArray(data.comments) ? data.comments : [];
    } catch (e: unknown) {
      console.warn('Фотобанк: не JSON в ответе comments:', errorMessage(e));
      return [];
    }
  }

  /** Добавляет комментарий (commenter+). */
  async addComment(photoId: number, text: string): Promise<void> {
    const token = await this.getToken();
    const res = await this.request({
      url: `${this.baseUrl}/api/photo/photos/${photoId}/comments`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ text }),
    });
    this.assertOk(res);
  }

  /** Лайк (commenter+). */
  async setLike(photoId: number, liked: boolean): Promise<void> {
    const token = await this.getToken();
    const res = await this.request({
      url: `${this.baseUrl}/api/photo/photos/${photoId}/like`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ liked }),
    });
    this.assertOk(res);
  }

  /** Избранное (commenter+). */
  async setFavorite(photoId: number, favorited: boolean): Promise<void> {
    const token = await this.getToken();
    const res = await this.request({
      url: `${this.baseUrl}/api/photo/photos/${photoId}/favorite`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ favorited }),
    });
    this.assertOk(res);
  }

  /** Избранные фото. */
  async favorites(): Promise<PhotoItem[]> {
    const token = await this.getToken();
    const res = await this.request({
      url: `${this.baseUrl}/api/photo/favorites`,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    this.assertOk(res);
    try {
      const data = JSON.parse(res.text) as PullResponse;
      return Array.isArray(data.photos) ? data.photos : [];
    } catch (e: unknown) {
      console.warn('Фотобанк: не JSON в ответе favorites:', errorMessage(e));
      return [];
    }
  }

  /** Недавно просмотренные. */
  async recent(): Promise<PhotoItem[]> {
    const token = await this.getToken();
    const res = await this.request({
      url: `${this.baseUrl}/api/photo/recent`,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    this.assertOk(res);
    try {
      const data = JSON.parse(res.text) as PullResponse;
      return Array.isArray(data.photos) ? data.photos : [];
    } catch (e: unknown) {
      console.warn('Фотобанк: не JSON в ответе recent:', errorMessage(e));
      return [];
    }
  }

  /** Фиксирует просмотр (для «недавних»). */
  async viewPhoto(photoId: number): Promise<void> {
    const token = await this.getToken();
    const res = await this.request({
      url: `${this.baseUrl}/api/photo/photos/${photoId}/view`,
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    this.assertOk(res);
  }

  /** Точечный override видимости файла (admin). */
  async setVisibilityOverride(photoId: number, override: '' | 'grant' | 'deny', subjects: string[]): Promise<void> {
    const token = await this.getToken();
    const res = await this.request({
      url: `${this.baseUrl}/api/photo/photos/${photoId}/visibility`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ id: photoId, override, subjects }),
    });
    this.assertOk(res);
  }

  /** Текущий override файла (admin). */
  async getVisibilityOverride(photoId: number): Promise<{ override: '' | 'grant' | 'deny'; subjects: string[] }> {
    const token = await this.getToken();
    const res = await this.request({
      url: `${this.baseUrl}/api/photo/photos/${photoId}/visibility`,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    this.assertOk(res);
    try {
      return JSON.parse(res.text) as { override: '' | 'grant' | 'deny'; subjects: string[] };
    } catch (e: unknown) {
      console.warn('Фотобанк: не JSON в ответе visibility:', errorMessage(e));
      return { override: '', subjects: [] };
    }
  }

  /** Удаляет карточку (admin или автор). */
  async deletePhoto(photoId: number): Promise<void> {
    const token = await this.getToken();
    const res = await this.request({
      url: `${this.baseUrl}/api/photo/photos/${photoId}`,
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    this.assertOk(res);
  }

  private buildMultipart(data: ArrayBuffer, fileName: string, folderId: number, kind: string, mimeType: string, boundary: string): ArrayBuffer {
    const enc = new TextEncoder();
    const parts: Uint8Array[] = [];
    parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="folder_id"\r\n\r\n${folderId}\r\n`));
    parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\n${kind}\r\n`));
    parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="mime_type"\r\n\r\n${mimeType}\r\n`));
    parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
    parts.push(new Uint8Array(data));
    parts.push(enc.encode(`\r\n--${boundary}--\r\n`));
    return this.concat(parts);
  }

  private concat(parts: Uint8Array[]): ArrayBuffer {
    let total = 0;
    for (const p of parts) total += p.byteLength;
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.byteLength;
    }
    return out.buffer;
  }

  private assertOk(res: { status: number; text: string }): void {
    if (res.status === 401) throw new Error('Ключ доступа недействителен. Запросите новый ключ в ЦУП.');
    if (res.status === 403) throw new Error('Нет прав доступа к фотобанку. Обратитесь к администратору.');
    if (res.status !== 200) throw new Error(this.errorText(res) || `Сервер вернул HTTP ${res.status}`);
  }

  private errorText(res: { status: number; text: string }): string {
    if (!res.text) return '';
    try {
      const data = JSON.parse(res.text) as { error?: string };
      return data.error || '';
    } catch (e: unknown) {
      console.warn('Фотобанк: ответ сервера не JSON:', errorMessage(e));
      return '';
    }
  }

  /** requestUrl в Obsidian не имеет таймаута — без обёртки зависший сервер не даст ответа никогда.
   *  Дефолт 120 сек: rclone-скачивания миниатюр под параллельной нагрузкой занимают 10+ сек,
   *  при 30-сек лимите pull/комментарии не успевали. */
  private async request(
    param: RequestUrlParam,
    timeoutMs = 120000,
  ): Promise<{ status: number; text: string; arrayBuffer: ArrayBuffer }> {
    let timer: number | undefined;
    try {
      const response = await Promise.race([
        requestUrl({ ...param, throw: false }),
        new Promise<never>((_, reject) => {
          timer = window.setTimeout(
            () => reject(new Error(`Сервер не ответил за ${Math.round(timeoutMs / 1000)} сек`)),
            timeoutMs,
          );
        }),
      ]);
      return { status: response.status, text: response.text, arrayBuffer: response.arrayBuffer };
    } finally {
      if (timer !== undefined) window.clearTimeout(timer);
    }
  }
}
