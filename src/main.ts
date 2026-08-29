import { Plugin, WorkspaceLeaf, Notice } from 'obsidian';
import { PhotobankDatabase } from './database/photobank-db';
import { PhotobankSyncService } from './services/sync.service';
import { AiDescribeService } from './services/ai-describe.service';
import { PhotobankImportService } from './services/import.service';
import { PhotobankView, SBE_PHOTOBANK_VIEW_TYPE } from './ui/photobank-view';
import { PhotobankSettingsTab } from './ui/settings-tab';
import { publishService, unpublishService, getService } from '../../sbe-core/src/bridge';
import type { SbePhotobankApi } from '../../sbe-core/src/types';
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
        summary: 'Запущен новый плагин «LogicTEAM.Фотобанк»: корпоративное хранилище фото и видео. Загружайте материалы, находите их по свободному описанию (умный поиск с ИИ), собирайте подборки и делитесь ссылками.',
      });
      this.settings.lastAnnouncedVersion = this.manifest.version;
      await this.saveSettings();
    } catch (e: unknown) {
      console.warn('Фотобанк: не удалось опубликовать новость об обновлении:', errorMessage(e));
    }
  }
}
