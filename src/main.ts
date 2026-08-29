import { Plugin, WorkspaceLeaf, Notice } from 'obsidian';
import { PhotobankDatabase } from './database/photobank-db';
import { PhotobankSyncService } from './services/sync.service';
import { AiDescribeService } from './services/ai-describe.service';
import { PhotobankImportService } from './services/import.service';
import { PhotobankView, SBE_PHOTOBANK_VIEW_TYPE } from './ui/photobank-view';
import { PhotobankSettingsTab } from './ui/settings-tab';
import { publishService, unpublishService, getService } from '../../sbe-core/src/bridge';
import type { SbePhotobankApi, PhotobankPhotoMeta } from '../../sbe-core/src/types';
import type { PhotoItem } from './types/photobank';
import { errorMessage } from '../../sbe-core/src/utils/errors';

export interface SbePhotobankSettings {
  apiUrl: string;
  /** Интервал фонового pull метаданных, мс. */
  syncIntervalMs: number;
  /** Модель ИИ для описания и умного поиска (sbe-llm). Пусто — модель LLM-центра по умолчанию. */
  llmModel: string;
  /** Передавать превью изображения в ИИ (vision): описывает реальные цвета/материалы.
   *  Требует vision-модели в chat-формате (например gpt-4o); модели Image API chad
   *  (gemini-*-image, gpt-img-*) для этого не подходят. */
  visionEnabled: boolean;
  /** Пользовательский базовый промпт для ИИ-описания. Пусто — стандартный системный
   *  промпт плагина (что на кадре, композиция, цвета; не фантазировать; title без
   *  технического имени файла). Если задан — заменяет системный промпт плагина. */
  basePrompt: string;
  /** Версия, для которой уже опубликована новость в «Новости» ЦУП. */
  lastAnnouncedVersion: string;
}

const DEFAULT_SETTINGS: SbePhotobankSettings = {
  apiUrl: 'https://epyur.fvds.ru',
  syncIntervalMs: 5 * 60 * 1000,
  llmModel: '',
  visionEnabled: false,
  basePrompt: '',
  lastAnnouncedVersion: '',
};

export default class SbePhotobankPlugin extends Plugin {
  settings!: SbePhotobankSettings;
  db!: PhotobankDatabase;
  syncService!: PhotobankSyncService;
  aiService!: AiDescribeService;
  importService!: PhotobankImportService;
  /** Кэш глобальной роли пользователя (viewer/editor/admin/superadmin) — обновляется view. */
  myRole = '';
  private syncTimer: number | undefined;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.db = new PhotobankDatabase(this.app);
    await this.db.init();
    this.syncService = new PhotobankSyncService(this.db, () => this.settings.apiUrl);
    this.aiService = new AiDescribeService(() => this.settings.llmModel, () => this.settings.basePrompt);
    this.importService = new PhotobankImportService(this.app, this.db, this.syncService, this.aiService);

    this.registerView(
      SBE_PHOTOBANK_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => new PhotobankView(leaf, this),
    );

    this.addSettingTab(new PhotobankSettingsTab(this.app, this));

    publishService<SbePhotobankApi>('sbe-photobank', {
      open: async () => {
        await this.activateView();
      },
      searchPhotos: async (query, opts) => {
        const items = await this.syncService.search(
          query || '',
          opts?.folderId,
          opts?.kind,
        );
        const limit = Math.max(1, Math.min(opts?.limit ?? 20, 200));
        return items.slice(0, limit).map(toPhotoMeta);
      },
      downloadPhotoFile: async (fileKey, view) => {
        return this.syncService.downloadFile(fileKey, view ?? false);
      },
      getPhotoLink: async (fileKey) => {
        return this.syncService.getFileLink(fileKey);
      },
    }, {
      version: this.manifest.version,
      name: this.manifest.name,
    });

    // Новость об обновлении — один раз на версию (канал «Новости» ЦУП).
    void this.announceOnce();
  }

  onunload(): void {
    unpublishService('sbe-photobank');
    if (this.syncTimer !== undefined) {
      window.clearInterval(this.syncTimer);
      this.syncTimer = undefined;
    }
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData() as Partial<SbePhotobankSettings>) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async activateView(): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(SBE_PHOTOBANK_VIEW_TYPE)[0];
    if (existing) {
      workspace.revealLeaf(existing);
      return;
    }
    const leaf = workspace.getLeaf(false);
    await leaf.setViewState({ type: SBE_PHOTOBANK_VIEW_TYPE, active: true });
    workspace.revealLeaf(leaf);
  }

  /** Фоновый pull метаданных по расписанию (после первого вызова из вьюхи). */
  scheduleBackgroundSync(): void {
    if (this.syncTimer !== undefined) return;
    this.syncTimer = window.setInterval(() => {
      void this.syncService.pullAndMerge().catch((e: unknown) => {
        console.warn('Фотобанк: фоновый pull не выполнен:', errorMessage(e));
      });
    }, this.settings.syncIntervalMs);
  }

  /** Публикация новости в канал «Новости» ЦУП — один раз на версию. */
  private async announceOnce(): Promise<void> {
    if (this.settings.lastAnnouncedVersion === this.manifest.version) return;
    try {
      const apstore = await getService('sbe-apstore');
      await apstore.announceUpdate({
        appId: this.manifest.id,
        appName: this.manifest.name,
        version: this.manifest.version,
        summary: 'Фотобанк теперь доступен и другим плагинам: агент «LogicTEAM.007» умеет искать фотографии по вашему запросу, а «Мастер презентаций» может подбирать фото как иллюстрации к слайдам.',
      });
      this.settings.lastAnnouncedVersion = this.manifest.version;
      await this.saveSettings();
    } catch (e: unknown) {
      console.warn('Фотобанк: не удалось опубликовать новость об обновлении:', errorMessage(e));
    }
  }
}

/** Приводит карточку фотобанка к метаданным для внешних потребителей (без внутренних полей). */
function toPhotoMeta(p: PhotoItem): PhotobankPhotoMeta {
  return {
    id: p.id,
    folder_id: p.folder_id,
    folder_name: p.folder_name || '',
    title: p.title,
    description: p.description,
    tags: Array.isArray(p.tags) ? p.tags.slice() : [],
    file_key: p.file_key,
    file_name: p.file_name,
    mime_type: p.mime_type,
    kind: p.kind,
    width: p.width,
    height: p.height,
    thumb_key: p.thumb_key,
    author_email: p.author_email,
    location: p.location,
    created_at: p.created_at,
    updated_at: p.updated_at,
  };
}
