import { ItemView, WorkspaceLeaf, Notice, TFolder, App, Modal } from 'obsidian';
import type SbePhotobankPlugin from '../main';
import type { PhotoItem, PhotoFolder, PhotoGroup, SchemaField, AiDescribeContext } from '../types/photobank';
import { errorMessage } from '../../../sbe-core/src/utils/errors';
import { promptFields } from './prompt-modal';

export const SBE_PHOTOBANK_VIEW_TYPE = 'sbe-photobank-view';

const KIND_LABELS: Record<string, string> = {
  image: 'Фото',
  video: 'Видео',
  raw: 'RAW',
};

/** Фасад «LogicTEAM.Фотобанк»: сайдбар (дерево папок, фильтры, разделы) + сетка карточек
 *  + карточка файла (метаданные, свои поля, ИИ-описание, комментарии, лайк, ссылка). */
export class PhotobankView extends ItemView {
  private plugin: SbePhotobankPlugin;
  private container!: HTMLElement;
  private state: {
    currentFolderId: number;
    search: string;
    kindFilter: string;
    view: 'all' | 'folder' | 'search' | 'favorites' | 'recent';
    selectedPhotoId: number | null;
  };

  constructor(leaf: WorkspaceLeaf, plugin: SbePhotobankPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.state = {
      currentFolderId: 0,
      search: '',
      kindFilter: '',
      view: 'all',
      selectedPhotoId: null,
    };
  }

  getViewType(): string {
    return SBE_PHOTOBANK_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'LogicTEAM.Фотобанк';
  }

  getIcon(): string {
    return 'image';
  }

  async onOpen(): Promise<void> {
    this.container = this.contentEl;
    this.container.empty();
    this.container.addClass('tn-photo-view');

    try {
      await this.plugin.syncService.getMyPermission();
    } catch (e: unknown) {
      new Notice(`Фотобанк: ${errorMessage(e)}`);
    }

    // Первичная загрузка.
    await this.refreshMeta();
    this.render();
    this.plugin.scheduleBackgroundSync();
  }

  async onClose(): Promise<void> {
    this.container.empty();
  }

  /** Фоновое обновление кэша метаданных. */
  async refreshMeta(): Promise<void> {
    try {
      await this.plugin.syncService.syncAll();
    } catch (e: unknown) {
      console.warn('Фотобанк: фоновый pull не выполнен:', errorMessage(e));
    }
  }

  render(): void {
    this.container.empty();
    const topbar = this.container.createDiv({ cls: 'tn-photo-topbar' });
    topbar.createEl('h3', { text: 'LogicTEAM.Фотобанк' });

    const searchInput = topbar.createEl('input', {
      attr: { type: 'text', placeholder: 'Поиск по банку (свободный ввод)…' },
      cls: 'tn-doc-input',
    });
    searchInput.value = this.state.search;
    searchInput.addEventListener('keydown', async (ev: KeyboardEvent) => {
      if (ev.key === 'Enter') {
        this.state.search = searchInput.value.trim();
        this.state.view = this.state.search ? 'search' : 'all';
        this.render();
      }
    });

    const kindSelect = topbar.createEl('select', { cls: 'tn-doc-select' });
    kindSelect.createEl('option', { value: '', text: 'Все типы' });
    kindSelect.createEl('option', { value: 'image', text: 'Фото' });
    kindSelect.createEl('option', { value: 'video', text: 'Видео' });
    kindSelect.createEl('option', { value: 'raw', text: 'RAW' });
    kindSelect.value = this.state.kindFilter;
    kindSelect.addEventListener('change', () => {
      this.state.kindFilter = kindSelect.value;
      this.render();
    });

    const uploadBtn = topbar.createEl('button', { text: '📥 Загрузить', cls: 'tn-btn tn-btn-primary' });
    uploadBtn.addEventListener('click', () => void this.uploadFiles());

    const importBtn = topbar.createEl('button', { text: '📂 Импорт папки', cls: 'tn-btn tn-btn-ghost' });
    importBtn.addEventListener('click', () => void this.importFolderFlow());

    const syncBtn = topbar.createEl('button', { text: '🔄', cls: 'tn-btn tn-btn-ghost', attr: { title: 'Синхронизировать' } });
    syncBtn.addEventListener('click', async () => {
      try {
        await this.refreshMeta();
        new Notice('Фотобанк: синхронизировано');
        this.render();
      } catch (e: unknown) {
        new Notice(`Фотобанк: ${errorMessage(e)}`);
      }
    });

    const body = this.container.createDiv({ cls: 'tn-photo-body' });
    this.renderSidebar(body);
    this.renderContent(body);
  }

  private renderSidebar(body: HTMLElement): void {
    const sidebar = body.createDiv({ cls: 'tn-photo-sidebar' });
    const inner = sidebar.createDiv({ cls: 'tn-photo-sidebar-inner' });

    inner.createDiv({ cls: 'tn-photo-sidebar-title', text: 'Банк' });

    const allBtn = inner.createEl('button', {
      cls: `tn-photo-nav-btn${this.state.view === 'all' ? ' is-active' : ''}`,
      text: '🗂 Все файлы',
    });
    allBtn.addEventListener('click', () => {
      this.state.view = 'all';
      this.state.search = '';
      this.state.selectedPhotoId = null;
      this.render();
    });

    const favBtn = inner.createEl('button', {
      cls: `tn-photo-nav-btn${this.state.view === 'favorites' ? ' is-active' : ''}`,
      text: '⭐ Избранное',
    });
    favBtn.addEventListener('click', () => {
      this.state.view = 'favorites';
      this.state.search = '';
      this.state.selectedPhotoId = null;
      this.render();
    });

    const recentBtn = inner.createEl('button', {
      cls: `tn-photo-nav-btn${this.state.view === 'recent' ? ' is-active' : ''}`,
      text: '🕒 Недавние',
    });
    recentBtn.addEventListener('click', () => {
      this.state.view = 'recent';
      this.state.search = '';
      this.state.selectedPhotoId = null;
      this.render();
    });

    inner.createDiv({ cls: 'tn-photo-sidebar-title', text: 'Папки' });
    const tree = this.plugin.db.folderTree();
    this.renderFolderTree(inner, tree, 0, 0);

    const adminTools = inner.createDiv();
    const adminBtn = adminTools.createEl('button', { cls: 'tn-photo-nav-btn', text: '⚙️ Папки и права' });
    adminBtn.addEventListener('click', () => void this.openFolderManager());
  }

  private renderFolderTree(parent: HTMLElement, tree: Map<number, PhotoFolder[]>, parentId: number, depth: number): void {
    const children = tree.get(parentId) || [];
    for (const f of children) {
      const row = parent.createDiv({ cls: `tn-photo-folder-row tn-photo-depth-${depth}` });
      const btn = row.createEl('button', {
        cls: `tn-photo-nav-btn tn-photo-folder-name${this.state.currentFolderId === f.id && this.state.view === 'folder' ? ' is-active' : ''}`,
        text: `📁 ${f.name}`,
      });
      btn.addEventListener('click', () => {
        this.state.currentFolderId = f.id;
        this.state.view = 'folder';
        this.state.search = '';
        this.state.selectedPhotoId = null;
        this.render();
      });
      const sub = parent.createDiv({ cls: 'tn-photo-folder-children' });
      this.renderFolderTree(sub, tree, f.id, depth + 1);
    }
  }

  private renderContent(body: HTMLElement): void {
    const content = body.createDiv({ cls: 'tn-photo-content' });

    if (this.state.selectedPhotoId) {
      void this.renderPhotoDetail(content, this.state.selectedPhotoId);
      return;
    }

    let photos: PhotoItem[] = [];
    if (this.state.view === 'favorites') {
      void this.plugin.syncService.favorites().then(p => {
        this.renderGrid(content, p);
      });
      return;
    }
    if (this.state.view === 'recent') {
      void this.plugin.syncService.recent().then(p => {
        this.renderGrid(content, p);
      });
      return;
    }
    if (this.state.view === 'search') {
      void this.runSearch(content);
      return;
    }

    photos = this.plugin.db.getAllPhotos();
    if (this.state.view === 'folder') {
      photos = photos.filter(p => p.folder_id === this.state.currentFolderId);
    }
    if (this.state.kindFilter) {
      photos = photos.filter(p => p.kind === this.state.kindFilter);
    }
    photos.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    this.renderGrid(content, photos);
  }

  private async runSearch(content: HTMLElement): Promise<void> {
    content.createDiv({ cls: 'tn-photo-empty', text: 'Поиск…' });
    const q = this.state.search;
    let photos = await this.plugin.syncService.search(q);
    if (photos.length < 5) {
      const expanded = await this.plugin.aiService.expandQuery(q);
      if (expanded && expanded.keywords.length > 0) {
        const extra = await this.plugin.syncService.search(expanded.keywords.join(' '));
        const seen = new Set(photos.map(p => p.id));
        for (const p of extra) {
          if (!seen.has(p.id)) {
            seen.add(p.id);
            photos.push(p);
          }
        }
      }
    }
    content.empty();
    this.renderGrid(content, photos);
  }

  private renderGrid(content: HTMLElement, photos: PhotoItem[]): void {
    if (photos.length === 0) {
      content.createDiv({ cls: 'tn-photo-empty', text: 'Файлов пока нет. Загрузите фото или импортируйте папку вольта.' });
      return;
    }
    const grid = content.createDiv({ cls: 'tn-photo-grid' });
    for (const p of photos) {
      const card = grid.createDiv({ cls: 'tn-photo-card' });
      const media = card.createDiv({ cls: 'tn-photo-card-media-placeholder' });
      if (p.thumb_key) {
        void this.loadThumb(p.thumb_key, media);
      } else if (p.kind === 'video') {
        media.setText('🎬');
      } else if (p.kind === 'raw') {
        media.setText('🖼');
      } else {
        media.setText('🖼');
      }
      const bodyEl = card.createDiv({ cls: 'tn-photo-card-body' });
      bodyEl.createDiv({ cls: 'tn-photo-card-title', text: p.title || p.file_name });
      const meta = bodyEl.createDiv({ cls: 'tn-photo-card-meta' });
      meta.createSpan({ cls: 'tn-photo-kind', text: KIND_LABELS[p.kind] || p.kind });
      if (p.tags && p.tags[0]) meta.createSpan({ cls: 'tn-photo-chip', text: p.tags[0] });
      if (p.likes_count > 0) meta.createSpan({ cls: 'tn-photo-chip', text: `♥ ${p.likes_count}` });
      card.addEventListener('click', () => {
        this.state.selectedPhotoId = p.id;
        void this.plugin.syncService.viewPhoto(p.id);
        this.render();
      });
    }
  }

  /** Скачивает миниатюру и показывает как <img>. */
  private async loadThumb(thumbKey: string, container: HTMLElement): Promise<void> {
    try {
      const data = await this.plugin.syncService.downloadFile(thumbKey);
      const blob = new Blob([data]);
      const url = URL.createObjectURL(blob);
      const img = container.createEl('img', { cls: 'tn-photo-card-media' });
      img.src = url;
    } catch (e: unknown) {
      console.warn('Фотобанк: миниатюра недоступна:', errorMessage(e));
    }
  }

  private async renderPhotoDetail(content: HTMLElement, photoId: number): Promise<void> {
    const p = this.plugin.db.getPhoto(photoId);
    if (!p) {
      content.createDiv({ cls: 'tn-photo-empty', text: 'Файл не найден' });
      return;
    }
    content.empty();
    const backBtn = content.createEl('button', { text: '← Назад', cls: 'tn-btn tn-btn-ghost tn-photo-mb8' });
    backBtn.addEventListener('click', () => {
      this.state.selectedPhotoId = null;
      this.render();
    });

    const detail = content.createDiv({ cls: 'tn-photo-detail' });
    const mediaBox = detail.createDiv({ cls: 'tn-photo-detail-media' });
    void this.loadMainMedia(p, mediaBox);

    const info = detail.createDiv({ cls: 'tn-photo-detail-info' });
    info.createEl('h3', { cls: 'tn-photo-detail-title', text: p.title || p.file_name });
    if (p.description) info.createDiv({ cls: 'tn-photo-detail-desc', text: p.description });

    if (p.tags && p.tags.length > 0) {
      const tags = info.createDiv({ cls: 'tn-photo-detail-tags' });
      for (const t of p.tags) tags.createSpan({ cls: 'tn-photo-chip', text: t });
    }

    const meta = info.createDiv();
    this.metaRow(meta, 'Тип', KIND_LABELS[p.kind] || p.kind);
    this.metaRow(meta, 'Файл', p.file_name);
    this.metaRow(meta, 'Размер', this.fmtSize(p.file_size));
    if (p.width && p.height) this.metaRow(meta, 'Разрешение', `${p.width}×${p.height}`);
    if (p.duration) this.metaRow(meta, 'Длительность', `${Math.round(p.duration)} с`);
    if (p.location) this.metaRow(meta, 'Локация', p.location);
    if (p.shot_at) this.metaRow(meta, 'Дата съёмки', new Date(p.shot_at).toLocaleString('ru-RU'));
    this.metaRow(meta, 'Автор', p.author_email || '—');
    this.metaRow(meta, 'Скачиваний', String(p.download_count));
    this.metaRow(meta, 'Лайки', String(p.likes_count));
    if (p.visibility_override === 'deny') this.metaRow(meta, 'Видимость', 'Скрыт (deny)');
    if (p.visibility_override === 'grant') this.metaRow(meta, 'Видимость', 'Точечный доступ (grant)');

    if (Object.keys(p.custom || {}).length > 0) {
      info.createDiv({ cls: 'tn-photo-sidebar-title', text: 'Свои поля' });
      const customBox = info.createDiv();
      for (const [k, v] of Object.entries(p.custom)) {
        this.metaRow(customBox, k, String(v ?? ''));
      }
    }

    const actions = info.createDiv({ cls: 'tn-photo-detail-actions' });
    const downloadBtn = actions.createEl('button', { text: '⬇ Скачать', cls: 'tn-btn tn-btn-primary' });
    downloadBtn.addEventListener('click', () => void this.downloadPhoto(p));
    const linkBtn = actions.createEl('button', { text: '🔗 Ссылка', cls: 'tn-btn tn-btn-ghost' });
    linkBtn.addEventListener('click', () => void this.getPhotoLink(p));
    const likeBtn = actions.createEl('button', { text: '♥', cls: 'tn-btn tn-btn-ghost' });
    likeBtn.addEventListener('click', async () => {
      try {
        await this.plugin.syncService.setLike(p.id, true);
        p.likes_count += 1;
        this.db().updatePhoto(p.id, { likes_count: p.likes_count });
        await this.db().save();
        this.render();
      } catch (e: unknown) {
        new Notice(`Фотобанк: ${errorMessage(e)}`);
      }
    });

    // Комментарии.
    const commentsBox = info.createDiv({ cls: 'tn-photo-comments' });
    commentsBox.createDiv({ cls: 'tn-photo-sidebar-title', text: 'Комментарии' });
    await this.renderComments(commentsBox, p.id);
  }

  private db(): { updatePhoto(id: number, updates: Partial<PhotoItem>): void; save(): Promise<void> } {
    return this.plugin.db as never;
  }

  private metaRow(parent: HTMLElement, label: string, value: string): void {
    const row = parent.createDiv({ cls: 'tn-photo-field' });
    row.createSpan({ cls: 'tn-photo-field-label', text: `${label}:` });
    row.createSpan({ text: value });
  }

  private async loadMainMedia(p: PhotoItem, box: HTMLElement): Promise<void> {
    const key = p.thumb_key || p.file_key;
    if (!key) {
      box.setText('Нет файла');
      return;
    }
    try {
      const data = await this.plugin.syncService.downloadFile(key);
      const blob = new Blob([data]);
      const url = URL.createObjectURL(blob);
      if (p.kind === 'video') {
        const video = box.createEl('video', { attr: { controls: 'controls' } });
        video.src = url;
      } else {
        const img = box.createEl('img');
        img.src = url;
      }
    } catch (e: unknown) {
      box.setText(`Не удалось открыть файл: ${errorMessage(e)}`);
    }
  }

  private async downloadPhoto(p: PhotoItem): Promise<void> {
    try {
      const data = await this.plugin.syncService.downloadFile(p.file_key);
      const blob = new Blob([data]);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = p.file_name || 'file';
      document.body.appendChild(a);
      a.click();
      a.remove();
      p.download_count += 1;
      this.db().updatePhoto(p.id, { download_count: p.download_count });
      await this.db().save();
    } catch (e: unknown) {
      new Notice(`Фотобанк: ${errorMessage(e)}`);
    }
  }

  private async getPhotoLink(p: PhotoItem): Promise<void> {
    try {
      const url = await this.plugin.syncService.getFileLink(p.file_key);
      if (!url) { new Notice('Фотобанк: не удалось получить ссылку'); return; }
      await navigator.clipboard.writeText(url);
      new Notice('Ссылка скопирована в буфер обмена');
    } catch (e: unknown) {
      new Notice(`Фотобанк: ${errorMessage(e)}`);
    }
  }

  private async renderComments(box: HTMLElement, photoId: number): Promise<void> {
    try {
      const comments = await this.plugin.syncService.listComments(photoId);
      for (const c of comments) {
        const row = box.createDiv({ cls: 'tn-photo-comment' });
        row.createDiv({ cls: 'tn-photo-comment-author', text: `${c.author_email} · ${new Date(c.created_at).toLocaleString('ru-RU')}` });
        row.createDiv({ text: c.text });
      }
      const input = box.createEl('input', { attr: { type: 'text', placeholder: 'Комментарий…' }, cls: 'tn-doc-input' });
      input.addEventListener('keydown', async (ev: KeyboardEvent) => {
        if (ev.key === 'Enter' && input.value.trim()) {
          try {
            await this.plugin.syncService.addComment(photoId, input.value.trim());
            input.value = '';
            box.empty();
            box.createDiv({ cls: 'tn-photo-sidebar-title', text: 'Комментарии' });
            await this.renderComments(box, photoId);
          } catch (e: unknown) {
            new Notice(`Фотобанк: ${errorMessage(e)}`);
          }
        }
      });
    } catch (e: unknown) {
      console.warn('Фотобанк: комментарии не загружены:', errorMessage(e));
    }
  }

  private async uploadFiles(): Promise<void> {
    const me = await this.plugin.syncService.getMyPermission();
    if (!me.hasAccess || (me.role !== 'editor' && me.role !== 'admin')) {
      new Notice('Фотобанк: загрузка доступна редакторам и администраторам');
      return;
    }
    const folderId = this.state.currentFolderId || 0;
    const schema = this.plugin.db.getSchema();
    const ctx = await this.collectUploadContext();
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.onchange = async () => {
      const files = Array.from(input.files || []);
      for (const file of files) {
        await this.uploadSingle(file, folderId, ctx, schema);
      }
      await this.refreshMeta();
      this.render();
    };
    input.click();
  }

  private async collectUploadContext(): Promise<AiDescribeContext> {
    const result = await promptFields(this.app, 'Контекст для ИИ-описания', [
      { key: 'content', label: 'Что на кадре', placeholder: 'Объект, сцена, детали. Можно пусто.' },
      { key: 'event', label: 'Событие/съёмка', placeholder: 'Например: «съёмка продукции», «корпоратив». Можно пусто.' },
      { key: 'location', label: 'Локация', placeholder: 'Город, объект, цех… Можно пусто.' },
      { key: 'people', label: 'Персоны', placeholder: 'Имена или должности. Можно пусто.' },
      { key: 'purpose', label: 'Цель использования', placeholder: 'Например: «для презентации». Можно пусто.' },
    ]);
    if (!result) {
      return { content: '', event: '', location: '', people: '', purpose: '' };
    }
    return {
      content: (result.content || '').trim(),
      event: (result.event || '').trim(),
      location: (result.location || '').trim(),
      people: (result.people || '').trim(),
      purpose: (result.purpose || '').trim(),
    };
  }

  private async uploadSingle(file: File, folderId: number, ctx: AiDescribeContext, schema: SchemaField[]): Promise<void> {
    const ext = file.name.split('.').pop()?.toLowerCase() || '';
    const kind = this.kindOf(ext);
    if (!kind) { new Notice(`Фотобанк: «${file.name}» — не медиа, пропущен`); return; }
    try {
      const data = await file.arrayBuffer();
      const up = await this.plugin.syncService.uploadFile(data, file.name, folderId, kind, this.mimeOf(ext));
      const aiEnabled = await this.plugin.aiService.isAvailable();
      const aiResult = aiEnabled ? await this.plugin.aiService.describe({
        fileName: file.name,
        folderName: this.folderName(folderId),
        kind,
        context: ctx,
        schema,
      }) : null;
      const now = new Date().toISOString();
      const photo: PhotoItem = {
        id: 0,
        folder_id: folderId,
        title: aiResult?.title || this.titleFromName(file.name),
        description: aiResult?.description || '',
        tags: aiResult?.tags || [],
        custom: aiResult?.custom || {},
        file_key: up.file_key,
        file_name: file.name,
        file_size: up.file_size,
        content_hash: '',
        mime_type: this.mimeOf(ext),
        kind,
        width: up.width || 0,
        height: up.height || 0,
        duration: 0,
        thumb_key: up.thumb_key || '',
        thumb_author: up.thumb_author || '',
        author_email: '',
        shot_at: aiResult?.shot_at || 0,
        location: aiResult?.location || ctx.location || '',
        visibility_override: '',
        download_count: 0,
        likes_count: 0,
        created_at: now,
        updated_at: now,
        sync_status: 'local',
      };
      this.plugin.db.addPhoto(photo);
      await this.plugin.db.save();
      new Notice(`Фотобанк: загружен «${file.name}»`);
    } catch (e: unknown) {
      new Notice(`Фотобанк: «${file.name}» — ${errorMessage(e)}`);
    }
  }

  private async importFolderFlow(): Promise<void> {
    const me = await this.plugin.syncService.getMyPermission();
    if (!me.hasAccess || (me.role !== 'editor' && me.role !== 'admin')) {
      new Notice('Фотобанк: импорт доступен редакторам и администраторам');
      return;
    }
    const result = await promptFields(this.app, 'Импорт папки вольта', [
      { key: 'path', label: 'Папка вольта', placeholder: 'Например: Фото/Мероприятия (подпапка vault)' },
    ]);
    if (!result) return;
    const folderName = (result.path || '').trim();
    if (!folderName) return;
    const folder = this.app.vault.getAbstractFileByPath(folderName) as TFolder | null;
    if (!folder || !(folder instanceof TFolder)) {
      new Notice(`Фотобанк: папка «${folderName}» не найдена в вольте`);
      return;
    }
    const targetFolderId = this.state.currentFolderId || 0;
    const aiEnabled = await this.plugin.aiService.isAvailable();
    new Notice('Фотобанк: импорт начат…');
    const importRes = await this.plugin.importService.importFolder(folder, targetFolderId, aiEnabled);
    await this.refreshMeta();
    this.render();
    new Notice(`Фотобанк: импорт завершён — просмотрено ${importRes.scanned}, создано ${importRes.created}, пропущено ${importRes.skipped}`);
  }

  private async openFolderManager(): Promise<void> {
    const me = await this.plugin.syncService.getMyPermission();
    if (me.role !== 'admin') {
      new Notice('Фотобанк: управление папками доступно администратору');
      return;
    }
    const modalHtml = document.createElement('div');
    modalHtml.createDiv({ cls: 'tn-photo-sidebar-title', text: 'Создать папку' });
    const nameInput = modalHtml.createEl('input', { attr: { type: 'text', placeholder: 'Название' }, cls: 'tn-doc-input' });
    const parentSelect = modalHtml.createEl('select', { cls: 'tn-doc-select' });
    parentSelect.createEl('option', { value: '0', text: 'Корень' });
    for (const f of this.plugin.db.getFolders()) {
      parentSelect.createEl('option', { value: String(f.id), text: f.name });
    }
    const createBtn = modalHtml.createEl('button', { text: '➕ Создать', cls: 'tn-btn tn-btn-primary' });
    createBtn.addEventListener('click', async () => {
      const name = nameInput.value.trim();
      if (!name) { new Notice('Введите название'); return; }
      try {
        await this.plugin.syncService.createFolder(name, parseInt(parentSelect.value, 10));
        new Notice('Папка создана');
        await this.refreshMeta();
        this.render();
      } catch (e: unknown) {
        new Notice(`Фотобанк: ${errorMessage(e)}`);
      }
    });

    const modal = new FolderManagerModal(this.app, modalHtml, this.plugin);
    modal.open();
  }

  private kindOf(ext: string): 'image' | 'video' | 'raw' | null {
    if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'svg', 'tif', 'tiff', 'heic', 'heif'].includes(ext)) return 'image';
    if (['mp4', 'mov', 'avi', 'mkv', 'webm', 'wmv', 'flv', 'm4v', 'mts', 'm2ts'].includes(ext)) return 'video';
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
    };
    return map[ext] || 'application/octet-stream';
  }

  private titleFromName(fileName: string): string {
    const base = fileName.replace(/\.[^.]+$/, '');
    return base.replace(/[-_]+/g, ' ').trim() || fileName;
  }

  private folderName(folderId: number): string {
    const f = this.plugin.db.getFolder(folderId);
    return f ? f.name : '';
  }

  private fmtSize(bytes: number): string {
    if (!bytes) return '0 Б';
    if (bytes < 1024) return `${bytes} Б`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} ГБ`;
  }
}

/** Простое модальное окно для управления папками (создание + права на папки). */
class FolderManagerModal extends Modal {
  private content: HTMLElement;
  private plugin: SbePhotobankPlugin;

  constructor(app: App, content: HTMLElement, plugin: SbePhotobankPlugin) {
    super(app);
    this.content = content;
    this.plugin = plugin;
  }

  override onOpen(): void {
    this.contentEl.empty();
    this.contentEl.appendChild(this.content);
    const permsBox = this.contentEl.createDiv({ cls: 'tn-photo-sidebar-title', text: 'Права папок' });
    void this.renderFolderPerms(permsBox);
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private async renderFolderPerms(box: HTMLElement): Promise<void> {
    const groups = this.plugin.db.getGroups();
    for (const f of this.plugin.db.getFolders()) {
      const row = box.createDiv({ cls: 'tn-doc-mb8' });
      row.createDiv({ cls: 'tn-photo-field-label', text: `📁 ${f.name}` });
      try {
        const perms = await this.plugin.syncService.listFolderPerms(f.id);
        for (const perm of perms) {
          const pRow = row.createDiv({ cls: 'tn-photo-field' });
          pRow.createSpan({ text: `${perm.subject}: ${perm.role}` });
          const rm = pRow.createEl('button', { text: '✖', cls: 'tn-btn tn-btn-ghost' });
          rm.addEventListener('click', async () => {
            try {
              await this.plugin.syncService.setFolderPerm(f.id, perm.subject, '');
              await this.renderFolderPerms(box);
            } catch (e: unknown) {
              new Notice(`Фотобанк: ${errorMessage(e)}`);
            }
          });
        }
        const addRow = row.createDiv({ cls: 'tn-photo-field' });
        const subjectInput = addRow.createEl('input', { attr: { type: 'text', placeholder: 'email или группа' }, cls: 'tn-doc-input' });
        const roleSelect = addRow.createEl('select', { cls: 'tn-doc-select' });
        roleSelect.createEl('option', { value: 'viewer', text: 'Просмотр' });
        roleSelect.createEl('option', { value: 'commenter', text: 'Просмотр + комментарии' });
        roleSelect.createEl('option', { value: 'editor', text: 'Редактор' });
        const add = addRow.createEl('button', { text: '➕', cls: 'tn-btn tn-btn-ghost' });
        add.addEventListener('click', async () => {
          const subject = subjectInput.value.trim();
          if (!subject) { new Notice('Введите email или группу'); return; }
          try {
            await this.plugin.syncService.setFolderPerm(f.id, subject, roleSelect.value);
            await this.renderFolderPerms(box);
          } catch (e: unknown) {
            new Notice(`Фотобанк: ${errorMessage(e)}`);
          }
        });
      } catch (e: unknown) {
        console.warn('Фотобанк: права папки не загружены:', errorMessage(e));
      }
    }
  }
}
