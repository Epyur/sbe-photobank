import { App, Notice, TFile, TFolder } from 'obsidian';
import { errorMessage } from '../../../sbe-core/src/utils/errors';
import { promptFields } from '../ui/prompt-modal';
import type { PhotobankSyncService } from './sync.service';
import type { PhotobankDatabase } from '../database/photobank-db';
import type { AiDescribeService } from './ai-describe.service';
import type { PhotoItem, AiDescribeContext, SchemaField } from '../types/photobank';

export interface ImportResult {
  scanned: number;
  uploaded: number;
  skipped: number;
  created: number;
}

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'svg', 'tif', 'tiff', 'heic', 'heif']);
const VIDEO_EXTS = new Set(['mp4', 'mov', 'avi', 'mkv', 'webm', 'wmv', 'flv', 'm4v', 'mts', 'm2ts']);

/** Импорт папки вольта: рекурсивный обход, подпапки → папки банка, загрузка в S3,
 *  дедуп по SHA-256 (content_hash). ИИ-описание при загрузке (если доступно). */
export class PhotobankImportService {
  private app: App;
  private db: PhotobankDatabase;
  private sync: PhotobankSyncService;
  private ai: AiDescribeService;

  constructor(app: App, db: PhotobankDatabase, sync: PhotobankSyncService, ai: AiDescribeService) {
    this.app = app;
    this.db = db;
    this.sync = sync;
    this.ai = ai;
  }

  /** Импортирует папку вольта (рекурсивно). Контекст для ИИ-описания запрашивается
   *  ОДИН раз на папку (фото в папке, как правило, объединены одной темой). */
  async importFolder(folder: TFolder, targetFolderId: number, aiEnabled: boolean): Promise<ImportResult> {
    const result: ImportResult = { scanned: 0, uploaded: 0, skipped: 0, created: 0 };
    const existingHashes = new Set(
      this.db.getAllPhotos().map(p => p.content_hash).filter(h => h),
    );

    // Один общий контекст для ИИ-описания всех файлов папки.
    let aiCtx: AiDescribeContext = { content: '', event: '', location: '', people: '', purpose: '' };
    if (aiEnabled) {
      aiCtx = await this.collectContext(folder.name || 'папка');
    }

    // Создаём папки банка для подпапок вольта: имя подпапки → папка банка в targetFolderId.
    const bankFolderBySub = new Map<string, number>();
    bankFolderBySub.set('', targetFolderId);

    // Сначала пройдёмся по подпапкам (один уровень ниже target), создадим их.
    for (const child of folder.children) {
      if (child instanceof TFolder) {
        const name = child.name.trim();
        if (!name) continue;
        try {
          const created = await this.sync.createFolder(name, targetFolderId);
          bankFolderBySub.set(child.name, created);
        } catch (e: unknown) {
          new Notice(`Фотобанк: не удалось создать папку «${name}»: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }

    for (const child of folder.children) {
      if (child instanceof TFile) {
        await this.importFile(child, targetFolderId, existingHashes, result, aiEnabled, aiCtx);
      }
      if (child instanceof TFolder) {
        // Загружаем файлы подпапки в соответствующую папку банка.
        const bankId = bankFolderBySub.get(child.name) || targetFolderId;
        for (const file of child.children) {
          if (file instanceof TFile) {
            await this.importFile(file, bankId, existingHashes, result, aiEnabled, aiCtx);
          }
        }
      }
    }
    return result;
  }

  private async importFile(
    file: TFile,
    folderId: number,
    existingHashes: Set<string>,
    result: ImportResult,
    aiEnabled: boolean,
    aiCtx: AiDescribeContext,
  ): Promise<void> {
    const ext = file.extension.toLowerCase();
    const kind = this.kindOf(ext);
    if (!kind) return; // не медиа — пропускаем

    result.scanned++;
    try {
      const content = await this.app.vault.adapter.readBinary(file.path);
      const hash = await this.sha256(content);
      result.uploaded++;

      if (existingHashes.has(hash)) {
        result.skipped++;
        new Notice(`Фотобанк: «${file.name}» уже есть в банке — пропущен`);
        return;
      }

      const mime = this.mimeOf(ext);
      const up = await this.sync.uploadFile(content, file.name, folderId, kind, mime);

      const schema = this.db.getSchema();
      const aiResult = aiEnabled ? await this.ai.describe({
        fileName: file.name,
        folderName: this.folderName(folderId),
        kind,
        context: aiCtx,
        schema,
      }) : null;

      const custom: Record<string, unknown> = {};
      if (aiResult) {
        for (const k of Object.keys(aiResult.custom || {})) {
          custom[k] = aiResult.custom[k];
        }
      }

      const now = new Date().toISOString();
      const photo: PhotoItem = {
        id: nextLocalId(),
        folder_id: folderId,
        title: aiResult && aiResult.title ? aiResult.title : this.titleFromName(file.name),
        description: aiResult ? aiResult.description : '',
        tags: aiResult ? aiResult.tags : [],
        custom,
        file_key: up.file_key,
        file_name: file.name,
        file_size: up.file_size,
        content_hash: hash,
        mime_type: mime,
        kind,
        width: up.width || 0,
        height: up.height || 0,
        duration: 0,
        thumb_key: up.thumb_key || '',
        thumb_author: up.thumb_author || '',
        author_email: '',
        shot_at: 0,
        location: aiResult && aiResult.location ? aiResult.location : '',
        visibility_override: '',
        download_count: 0,
        likes_count: 0,
        created_at: now,
        updated_at: now,
        sync_status: 'local',
      };
      this.db.addPhoto(photo);
      existingHashes.add(hash);
      result.created++;
    } catch (e: unknown) {
      result.skipped++;
      console.warn(`Фотобанк: не удалось импортировать «${file.name}»:`, errorMessage(e));
    }
  }

  /** Запрашивает у пользователя контекст для ИИ-описания (модальное окно). */
  private async collectContext(fileName: string): Promise<AiDescribeContext> {
    const result = await promptFields(this.app, `Контекст для ИИ-описания «${fileName}»`, [
      { key: 'content', label: 'Что на кадре', placeholder: 'Объект, сцена, детали. Можно пусто.' },
      { key: 'event', label: 'Событие/съёмка', placeholder: 'Например: «День открытых дверей», «съёмка продукции». Можно пусто.' },
      { key: 'location', label: 'Локация', placeholder: 'Город, объект, цех… Можно пусто.' },
      { key: 'people', label: 'Персоны', placeholder: 'Имена или должности на кадре. Можно пусто.' },
      { key: 'purpose', label: 'Цель использования', placeholder: 'Например: «для отчёта», «для презентации». Можно пусто.' },
    ]);
    if (!result) {
      return { content: '', event: '', location: '', people: '', purpose: '' };
    }
    return {
      content: result.content || '',
      event: result.event || '',
      location: result.location || '',
      people: result.people || '',
      purpose: result.purpose || '',
    };
  }

  private folderName(folderId: number): string {
    const f = this.db.getFolder(folderId);
    return f ? f.name : '';
  }

  private kindOf(ext: string): 'image' | 'video' | 'raw' | null {
    if (IMAGE_EXTS.has(ext)) return 'image';
    if (VIDEO_EXTS.has(ext)) return 'video';
    if (['cr2', 'cr3', 'nef', 'arw', 'orf', 'rw2', 'dng', 'raw'].includes(ext)) return 'raw';
    return null;
  }

  private mimeOf(ext: string): string {
    const map: Record<string, string> = {
      jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
      gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml', tif: 'image/tiff', tiff: 'image/tiff',
      heic: 'image/heic', heif: 'image/heif',
      mp4: 'video/mp4', mov: 'video/quicktime', avi: 'video/x-msvideo', mkv: 'video/x-matroska',
      webm: 'video/webm', wmv: 'video/x-ms-wmv', flv: 'video/x-flv', m4v: 'video/x-m4v',
      mts: 'video/mp2t', m2ts: 'video/mp2t',
      cr2: 'image/x-canon-cr2', cr3: 'image/x-canon-cr3', nef: 'image/x-nikon-nef',
      arw: 'image/x-sony-arw', orf: 'image/x-olympus-orf', rw2: 'image/x-panasonic-rw2',
      dng: 'image/x-adobe-dng', raw: 'image/x-raw',
    };
    return map[ext] || 'application/octet-stream';
  }

  private titleFromName(fileName: string): string {
    const base = fileName.replace(/\.[^.]+$/, '');
    return base.replace(/[-_]+/g, ' ').trim() || fileName;
  }

  /** SHA-256 в hex (для дедупа по содержимому). */
  private async sha256(data: ArrayBuffer): Promise<string> {
    const cryptoObj = window.crypto;
    const digest = await cryptoObj.subtle.digest('SHA-256', data);
    const bytes = new Uint8Array(digest);
    let hex = '';
    for (let i = 0; i < bytes.length; i++) {
      hex += bytes[i].toString(16).padStart(2, '0');
    }
    return hex;
  }
}

/** Уникальный локальный id новой карточки: положительный, не пересекающийся с
 *  серверными BIGSERIAL. Сервер при push сохранит его (id>0 → UPSERT по id),
 *  поэтому pull не создаст дубль. */
export function nextLocalId(): number {
  return Date.now() + Math.floor(Math.random() * 100000);
}
