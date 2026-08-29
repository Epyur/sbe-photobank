import { ItemView, WorkspaceLeaf, Notice, TFolder, App, Modal } from 'obsidian';
import type SbePhotobankPlugin from '../main';
import type { PhotoItem, PhotoFolder, PhotoGroup, SchemaField, AiDescribeContext } from '../types/photobank';
import { errorMessage } from '../../../sbe-core/src/utils/errors';
import { promptFields } from './prompt-modal';
import { PhotobankHelpModal } from './help-modal';
import { nextLocalId } from '../services/import.service';

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
    /** Множественный выбор карточек. */
    selectionMode: boolean;
    selectedPhotoIds: Set<number>;
    /** Сайдбар свёрнут (паттерн фасада LogicTEAM, как в sbe-documents). */
    sidebarCollapsed: boolean;
    /** Развёрнутые папки в дереве (по умолчанию пусто — все свёрнуты). */
    expandedFolders: Set<number>;
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
      selectionMode: false,
      selectedPhotoIds: new Set(),
      sidebarCollapsed: false,
      expandedFolders: new Set(),
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
      const me = await this.plugin.syncService.getMyPermission();
      this.plugin.myRole = me.hasAccess ? me.role : '';
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
    this.container.toggleClass('tn-photo-collapsed', this.state.sidebarCollapsed);

    // Топбар по паттерну фасада LogicTEAM.
    const topbar = this.container.createDiv({ cls: 'tn-photo-topbar' });
    topbar.createDiv({ cls: 'tn-photo-module-title', text: 'LogicTEAM.Фотобанк' });

    const searchInput = topbar.createEl('input', {
      attr: { type: 'text', placeholder: 'Поиск по банку (свободный ввод)…' },
      cls: 'tn-doc-input tn-photo-topbar-search',
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

    const spacer = topbar.createDiv({ cls: 'tn-photo-spacer' });
    spacer.empty();

    const uploadBtn = topbar.createEl('button', { text: '📥 Загрузить', cls: 'tn-btn tn-btn-primary' });
    uploadBtn.addEventListener('click', () => void this.uploadFiles());

    const importBtn = topbar.createEl('button', { text: '📂 Импорт папки', cls: 'tn-btn tn-btn-ghost' });
    importBtn.addEventListener('click', () => void this.importFolderFlow());

    const selectBtn = topbar.createEl('button', {
      text: this.state.selectionMode ? '☑ Завершить выбор' : '☑ Выбрать',
      cls: 'tn-btn tn-btn-ghost',
    });
    selectBtn.addEventListener('click', () => {
      this.state.selectionMode = !this.state.selectionMode;
      this.state.selectedPhotoIds = new Set();
      this.render();
    });

    const moveBtn = topbar.createEl('button', { text: '📁 Перенести в папку', cls: 'tn-btn tn-btn-ghost' });
    moveBtn.disabled = this.state.selectedPhotoIds.size === 0;
    moveBtn.addEventListener('click', () => void this.moveSelectedToFolder());

    const deleteSelBtn = topbar.createEl('button', { text: '🗑 Удалить выбранные', cls: 'tn-btn tn-btn-ghost' });
    deleteSelBtn.disabled = this.state.selectedPhotoIds.size === 0;
    deleteSelBtn.addEventListener('click', () => void this.deleteSelected());

    const body = this.container.createDiv({ cls: 'tn-photo-body' });
    this.renderSidebar(body);
    this.renderContent(body);
  }

  private renderSidebar(body: HTMLElement): void {
    const sidebar = body.createDiv({ cls: 'tn-photo-sidebar' });

    // Кнопка сворачивания сайдбара.
    const collapseBtn = sidebar.createDiv({ cls: 'tn-photo-collapse' });
    collapseBtn.createSpan({ text: '▧' });
    const collapseLabel = collapseBtn.createSpan({ cls: 'tn-photo-collapse-lbl', text: this.state.sidebarCollapsed ? 'Развернуть' : 'Свернуть' });
    collapseBtn.addEventListener('click', () => {
      this.state.sidebarCollapsed = !this.state.sidebarCollapsed;
      this.render();
    });

    const nav = sidebar.createDiv({ cls: 'tn-photo-nav' });

    // Группа «Банк».
    const bankGroup = nav.createEl('button', { cls: 'tn-photo-grp' });
    bankGroup.createSpan({ cls: 'tn-photo-grp-ico', text: '🗂' });
    bankGroup.createSpan({ cls: 'tn-photo-grp-lbl', text: 'Банк' });
    bankGroup.createSpan({ cls: 'tn-photo-grp-chev', text: '▶' });
    bankGroup.classList.add('open');
    const bankSub = nav.createDiv({ cls: 'tn-photo-submenu' });
    const mkItem = (text: string, icon: string, cls: string, onClick: () => void): void => {
      const item = bankSub.createEl('button', { cls: `tn-photo-nav-item${cls}`, attr: { title: text } });
      item.createSpan({ cls: 'tn-photo-nav-ico', text: icon });
      item.createSpan({ cls: 'tn-photo-nav-lbl', text });
      item.addEventListener('click', onClick);
    };
    mkItem('Все файлы', '🗂', this.state.view === 'all' ? ' active' : '', () => {
      this.state.view = 'all';
      this.state.search = '';
      this.state.selectedPhotoId = null;
      this.render();
    });
    mkItem('Избранное', '⭐', this.state.view === 'favorites' ? ' active' : '', () => {
      this.state.view = 'favorites';
      this.state.search = '';
      this.state.selectedPhotoId = null;
      this.render();
    });
    mkItem('Недавние', '🕒', this.state.view === 'recent' ? ' active' : '', () => {
      this.state.view = 'recent';
      this.state.search = '';
      this.state.selectedPhotoId = null;
      this.render();
    });

    // Группа «Папки» — дерево.
    const folderGroup = nav.createEl('button', { cls: 'tn-photo-grp' });
    folderGroup.createSpan({ cls: 'tn-photo-grp-ico', text: '📁' });
    folderGroup.createSpan({ cls: 'tn-photo-grp-lbl', text: 'Папки' });
    folderGroup.createSpan({ cls: 'tn-photo-grp-chev', text: '▶' });
    folderGroup.classList.add('open');
    const folderSub = nav.createDiv({ cls: 'tn-photo-submenu' });

    // Корень — фото без папки (folder_id=0).
    const rootBtn = folderSub.createEl('button', {
      cls: `tn-photo-nav-item tn-photo-folder-name${this.state.currentFolderId === 0 && this.state.view === 'folder' ? ' active' : ''}`,
      attr: { title: 'Корень' },
    });
    rootBtn.createSpan({ cls: 'tn-photo-nav-ico', text: '📁' });
    rootBtn.createSpan({ cls: 'tn-photo-nav-lbl', text: 'Корень' });
    rootBtn.addEventListener('click', () => {
      this.state.currentFolderId = 0;
      this.state.view = 'folder';
      this.state.search = '';
      this.state.selectedPhotoId = null;
      this.render();
    });

    const tree = this.plugin.db.folderTree();
    this.renderFolderTree(folderSub, tree, 0, 0);

    // Низ сайдбара — управление.
    const actions = sidebar.createDiv({ cls: 'tn-photo-sidebar-actions' });

    const syncBtn = actions.createEl('button', { cls: 'tn-photo-nav-action' });
    syncBtn.createSpan({ text: '🔄' });
    syncBtn.createSpan({ cls: 'tn-photo-nav-lbl', text: 'Синхронизация' });
    syncBtn.addEventListener('click', async () => {
      try {
        await this.refreshMeta();
        new Notice('Фотобанк: синхронизировано');
        this.render();
      } catch (e: unknown) {
        new Notice(`Фотобанк: ${errorMessage(e)}`);
      }
    });

    const createFolderBtn = actions.createEl('button', { cls: 'tn-photo-nav-action' });
    createFolderBtn.createSpan({ text: '➕' });
    createFolderBtn.createSpan({ cls: 'tn-photo-nav-lbl', text: 'Создать папку' });
    createFolderBtn.addEventListener('click', () => void this.openCreateFolder());

    const helpBtn = actions.createEl('button', { cls: 'tn-photo-nav-action' });
    helpBtn.createSpan({ text: '❓' });
    helpBtn.createSpan({ cls: 'tn-photo-nav-lbl', text: 'Справка' });
    helpBtn.addEventListener('click', () => void this.openHelp());
  }

  /** Открывает модальное окно «Справка» с инструкцией по работе с фотобанком. */
  private openHelp(): void {
    const modal = new PhotobankHelpModal(this.app);
    modal.open();
  }

  private renderFolderTree(parent: HTMLElement, tree: Map<number, PhotoFolder[]>, parentId: number, depth: number): void {
    const children = tree.get(parentId) || [];
    for (const f of children) {
      const kids = tree.get(f.id) || [];
      const hasChildren = kids.length > 0;
      const expanded = this.state.expandedFolders.has(f.id);

      const row = parent.createDiv({ cls: `tn-photo-folder-row tn-photo-depth-${depth}` });

      // Шеврон раскрытия/сворачивания (только у папок с вложенными).
      if (hasChildren) {
        const chev = row.createEl('button', {
          cls: 'tn-photo-folder-chev',
          text: expanded ? '▾' : '▸',
          attr: { title: expanded ? 'Свернуть' : 'Развернуть' },
        });
        chev.addEventListener('click', (ev: MouseEvent) => {
          ev.stopPropagation();
          if (expanded) {
            this.state.expandedFolders.delete(f.id);
          } else {
            this.state.expandedFolders.add(f.id);
          }
          this.render();
        });
      } else {
        row.createSpan({ cls: 'tn-photo-folder-chev tn-photo-folder-chev-empty' });
      }

      // Имя папки (значок + подпись слева).
      const btn = row.createEl('button', {
        cls: `tn-photo-nav-item tn-photo-folder-name${this.state.currentFolderId === f.id && this.state.view === 'folder' ? ' active' : ''}`,
        attr: { title: f.name },
      });
      btn.createSpan({ cls: 'tn-photo-nav-ico', text: '📁' });
      btn.createSpan({ cls: 'tn-photo-nav-lbl', text: f.name });
      btn.addEventListener('click', () => {
        this.state.currentFolderId = f.id;
        this.state.view = 'folder';
        this.state.search = '';
        this.state.selectedPhotoId = null;
        this.render();
      });

      // Карандаш — «Свойства папки» (переименование, доступы, удаление).
      const editBtn = row.createEl('button', {
        cls: 'tn-photo-folder-edit',
        text: '✏️',
        attr: { title: 'Свойства папки' },
      });
      editBtn.addEventListener('click', (ev: MouseEvent) => {
        ev.stopPropagation();
        void this.openFolderSettings(f);
      });

      // Дочерние папки — только если развёрнута.
      if (hasChildren && expanded) {
        const sub = parent.createDiv({ cls: 'tn-photo-folder-children' });
        this.renderFolderTree(sub, tree, f.id, depth + 1);
      }
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
      const folder = this.state.currentFolderId === 0 ? undefined : this.plugin.db.getFolder(this.state.currentFolderId);
      const head = content.createDiv({ cls: 'tn-photo-page-head' });
      head.createEl('h2', { cls: 'tn-photo-page-title', text: folder?.name || 'Корень' });
      head.createSpan({ cls: 'tn-photo-page-count', text: `${photos.length} файл(ов)` });
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
      if (this.state.selectionMode) {
        card.addClass('tn-photo-card-selectable');
        if (this.state.selectedPhotoIds.has(p.id)) {
          card.addClass('is-selected');
        }
      }
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
      const titleRow = bodyEl.createDiv({ cls: 'tn-photo-card-title-row' });
      if (this.state.selectionMode) {
        const cb = titleRow.createEl('input', { attr: { type: 'checkbox' }, cls: 'tn-photo-card-cb' });
        cb.checked = this.state.selectedPhotoIds.has(p.id);
        cb.addEventListener('click', (ev: MouseEvent) => ev.stopPropagation());
        cb.addEventListener('change', () => {
          if (cb.checked) {
            this.state.selectedPhotoIds.add(p.id);
          } else {
            this.state.selectedPhotoIds.delete(p.id);
          }
          this.render();
        });
      }
      titleRow.createDiv({ cls: 'tn-photo-card-title', text: p.title || p.file_name });
      const meta = bodyEl.createDiv({ cls: 'tn-photo-card-meta' });
      meta.createSpan({ cls: 'tn-photo-kind', text: KIND_LABELS[p.kind] || p.kind });
      if (p.tags && p.tags[0]) meta.createSpan({ cls: 'tn-photo-chip', text: p.tags[0] });
      if (p.likes_count > 0) meta.createSpan({ cls: 'tn-photo-chip', text: `♥ ${p.likes_count}` });
      card.addEventListener('click', () => {
        if (this.state.selectionMode) {
          if (this.state.selectedPhotoIds.has(p.id)) {
            this.state.selectedPhotoIds.delete(p.id);
          } else {
            this.state.selectedPhotoIds.add(p.id);
          }
          this.render();
          return;
        }
        this.state.selectedPhotoId = p.id;
        void this.plugin.syncService.viewPhoto(p.id);
        this.render();
      });
    }
  }

  /** Скачивает миниатюру и показывает как <img>. Просмотр превью не считается скачиванием. */
  private async loadThumb(thumbKey: string, container: HTMLElement): Promise<void> {
    try {
      const data = await this.plugin.syncService.downloadFile(thumbKey, true);
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
    const editBtn = actions.createEl('button', { text: '✎ Изменить', cls: 'tn-btn tn-btn-ghost' });
    editBtn.addEventListener('click', () => void this.editPhoto(p));
    const aiBtn = actions.createEl('button', { text: '♻️ ИИ-описание', cls: 'tn-btn tn-btn-ghost' });
    aiBtn.addEventListener('click', () => void this.rewriteAiDescription(p));
    const delBtn = actions.createEl('button', { text: '🗑 Удалить', cls: 'tn-btn tn-btn-ghost' });
    delBtn.addEventListener('click', () => void this.deletePhoto(p));
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
    const favBtn = actions.createEl('button', { text: '⭐ В избранное', cls: 'tn-btn tn-btn-ghost' });
    favBtn.addEventListener('click', () => void this.toggleFavorite(p, favBtn));

    // Комментарии.
    const commentsBox = info.createDiv({ cls: 'tn-photo-comments' });
    commentsBox.createDiv({ cls: 'tn-photo-sidebar-title', text: 'Комментарии' });
    await this.renderComments(commentsBox, p.id);
  }

  /** Переключатель избранного: проверяет статус и добавляет/убирает из избранного. */
  private async toggleFavorite(p: PhotoItem, btn: HTMLButtonElement): Promise<void> {
    try {
      const favs = await this.plugin.syncService.favorites();
      const isFav = favs.some(f => f.id === p.id);
      await this.plugin.syncService.setFavorite(p.id, !isFav);
      new Notice(isFav ? 'Фотобанк: убрано из избранного' : 'Фотобанк: добавлено в избранное');
      btn.setText(isFav ? '⭐ В избранное' : '⭐ В избранном');
      this.render();
    } catch (e: unknown) {
      new Notice(`Фотобанк: ${errorMessage(e)}`);
    }
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
      const data = await this.plugin.syncService.downloadFile(key, true);
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

  /** Редактирование метаданных карточки (отображаемое имя, описание, теги, локация, папка). */
  private async editPhoto(p: PhotoItem): Promise<void> {
    const folders = this.plugin.db.getFolders();
    const folderOptions = [
      { value: '0', label: 'Корень (без папки)' },
      ...folders.map(f => ({ value: String(f.id), label: f.name })),
    ];
    const result = await promptFields(this.app, `Редактирование «${p.title || p.file_name}»`, [
      { key: 'title', label: 'Отображаемое имя (в стоке)', placeholder: 'Короткое, ёмкое название' },
      { key: 'description', label: 'Описание', placeholder: 'Расширенное описание' },
      { key: 'tags', label: 'Теги (через запятую)', placeholder: 'тег1, тег2' },
      { key: 'location', label: 'Локация', placeholder: 'Город, объект…' },
      { key: 'folder', label: 'Папка', type: 'select', options: folderOptions },
    ]);
    if (!result) return;
    try {
      const updates: Partial<PhotoItem> = {
        title: result.title || p.title,
        description: result.description || p.description,
        tags: result.tags ? result.tags.split(',').map(t => t.trim()).filter(Boolean) : p.tags,
        location: result.location || p.location,
        folder_id: parseInt(result.folder || String(p.folder_id), 10) || p.folder_id,
        updated_at: new Date().toISOString(),
        sync_status: 'local',
      };
      this.plugin.db.updatePhoto(p.id, updates);
      await this.plugin.db.save();
      await this.pushLocal(p.id);
      new Notice('Фотобанк: карточка обновлена');
      this.render();
    } catch (e: unknown) {
      new Notice(`Фотобанк: ${errorMessage(e)}`);
    }
  }

  /** Перезапрос ИИ-описания: контекст → sbe-llm → обновление title/description/тегов/своих полей. */
  private async rewriteAiDescription(p: PhotoItem): Promise<void> {
    if (!(await this.plugin.aiService.isAvailable())) {
      new Notice('Фотобанк: LLM-центр недоступен (sbe-llm не настроен)');
      return;
    }
    const ctx = await this.collectUploadContext();
    await this.rewriteOne(p, ctx);
  }

  /** Переописывает одну карточку через ИИ (общая логика для одиночного и массового). */
  private async rewriteOne(p: PhotoItem, ctx: AiDescribeContext): Promise<boolean> {
    try {
      const imageUrl = this.plugin.settings.visionEnabled && p.kind === 'image'
        ? await this.getImageHttpUrl(p.thumb_key || p.file_key)
        : undefined;
      const aiResult = await this.plugin.aiService.describe({
        fileName: p.file_name,
        folderPath: this.plugin.db.folderPath(p.folder_id),
        kind: p.kind,
        context: ctx,
        schema: this.plugin.db.getSchema(),
        imageUrl,
      });
      if (!aiResult) return false;
      const custom: Record<string, unknown> = { ...p.custom };
      for (const [k, v] of Object.entries(aiResult.custom || {})) {
        custom[k] = v;
      }
      const updates: Partial<PhotoItem> = {
        title: aiResult.title || p.title,
        description: aiResult.description || p.description,
        tags: aiResult.tags.length > 0 ? aiResult.tags : p.tags,
        location: aiResult.location || p.location,
        custom,
        shot_at: aiResult.shot_at || p.shot_at,
        updated_at: new Date().toISOString(),
        sync_status: 'local',
      };
      this.plugin.db.updatePhoto(p.id, updates);
      await this.pushLocal(p.id);
      return true;
    } catch (e: unknown) {
      console.warn(`Фотобанк: не удалось переописать «${p.file_name}»:`, errorMessage(e));
      return false;
    }
  }

  /** Массовое переописание всех карточек через ИИ (последовательно, с учётом vision). */
  /** Переописание всех карточек указанной папки через ИИ (последовательно, с учётом vision). */
  private async rewriteFolderAiDescriptions(folderId: number): Promise<void> {
    if (!(await this.plugin.aiService.isAvailable())) {
      new Notice('Фотобанк: LLM-центр недоступен (sbe-llm не настроен)');
      return;
    }
    const folder = this.plugin.db.getFolder(folderId);
    const all = this.plugin.db.getAllPhotos().filter(p => p.folder_id === folderId);
    if (all.length === 0) {
      new Notice(`Фотобанк: в папке «${folder?.name || '?'}» нет карточек для переописания`);
      return;
    }
    const ctx: AiDescribeContext = { content: '', event: '', location: '', people: '', purpose: '' };
    new Notice(`Фотобанк: переописываю ${all.length} файлов в «${folder?.name || '?'}»…`);
    let ok = 0;
    for (const p of all) {
      if (await this.rewriteOne(p, ctx)) ok++;
    }
    await this.db().save();
    new Notice(`Фотобанк: переописано ${ok} из ${all.length}`);
    this.render();
  }

  /** Удаление карточки и файла (admin или автор). */
  private async deletePhoto(p: PhotoItem): Promise<void> {
    const confirmed = window.confirm ? window.confirm(`Удалить «${p.title || p.file_name}» из фотобанка?`) : true;
    if (!confirmed) return;
    try {
      await this.plugin.syncService.deletePhoto(p.id);
      this.plugin.db.deletePhoto(p.id);
      await this.plugin.db.save();
      new Notice('Фотобанк: файл удалён');
      this.state.selectedPhotoId = null;
      this.render();
    } catch (e: unknown) {
      new Notice(`Фотобанк: ${errorMessage(e)}`);
    }
  }

  /** Отправляет одну локальную карточку на сервер (push) и помечает синхронизированной. */
  private async pushLocal(id: number): Promise<void> {
    const p = this.plugin.db.getPhoto(id);
    if (!p || p.sync_status !== 'local') return;
    const token = await this.plugin.syncService.getToken();
    await this.plugin.syncService.push(token, [p]);
    p.sync_status = 'synced';
    await this.plugin.db.save();
  }

  /** Переносит выделенные карточки в выбранную папку (множественный выбор). */
  private async moveSelectedToFolder(): Promise<void> {
    const ids = Array.from(this.state.selectedPhotoIds);
    if (ids.length === 0) return;
    const folders = this.plugin.db.getFolders();
    const options = [
      { value: '0', label: 'Корень (без папки)' },
      ...folders.map(f => ({ value: String(f.id), label: f.name })),
    ];
    const result = await promptFields(this.app, `Перенести файлов: ${ids.length}`, [
      { key: 'folder', label: 'Папка назначения', type: 'select', options },
    ]);
    if (!result) return;
    const folderId = parseInt(result.folder || '0', 10);
    try {
      const token = await this.plugin.syncService.getToken();
      const toPush: PhotoItem[] = [];
      for (const id of ids) {
        const p = this.plugin.db.getPhoto(id);
        if (!p) continue;
        p.folder_id = folderId;
        p.updated_at = new Date().toISOString();
        p.sync_status = 'local';
        toPush.push(p);
      }
      if (toPush.length > 0) {
        await this.plugin.syncService.push(token, toPush);
        for (const p of toPush) p.sync_status = 'synced';
      }
      await this.plugin.db.save();
      this.state.selectedPhotoIds = new Set();
      this.state.selectionMode = false;
      new Notice(`Фотобанк: перенесено файлов: ${toPush.length}`);
      this.render();
    } catch (e: unknown) {
      new Notice(`Фотобанк: ${errorMessage(e)}`);
    }
  }

  /** Удаляет выбранные фотографии (админ или автор) — последовательно через deletePhoto. */
  private async deleteSelected(): Promise<void> {
    const ids = Array.from(this.state.selectedPhotoIds);
    if (ids.length === 0) return;
    const confirmed = window.confirm
      ? window.confirm(`Удалить выбранных файлов: ${ids.length}? Это действие необратимо.`)
      : true;
    if (!confirmed) return;
    let ok = 0;
    for (const id of ids) {
      const p = this.plugin.db.getPhoto(id);
      if (!p) continue;
      try {
        await this.plugin.syncService.deletePhoto(p.id);
        this.plugin.db.deletePhoto(p.id);
        ok++;
      } catch (e: unknown) {
        console.warn(`Фотобанк: не удалось удалить «${p.file_name}»:`, errorMessage(e));
      }
    }
    await this.plugin.db.save();
    this.state.selectedPhotoIds = new Set();
    this.state.selectionMode = false;
    new Notice(`Фотобанк: удалено файлов: ${ok} из ${ids.length}`);
    this.render();
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
    const canUpload = me.hasAccess && ['editor', 'admin', 'superadmin'].includes(me.role);
    if (!canUpload) {
      new Notice('Фотобанк: загрузка доступна редакторам и администраторам');
      return;
    }
    let folderId = this.state.currentFolderId;
    // Если папка не выбрана в сайдбаре (вид не «folder» или корень) — спросить.
    if (this.state.view !== 'folder' || !folderId) {
      const chosen = await this.chooseTargetFolder('Загрузка файлов');
      if (chosen === null) return;
      folderId = chosen;
    }
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
      const wantVision = this.plugin.settings.visionEnabled && kind === 'image';
      console.debug('[sbe-photobank][debug] uploadSingle:', {
        file: file.name,
        aiEnabled,
        visionEnabled: this.plugin.settings.visionEnabled,
        wantVision,
        up: { file_key: up.file_key, thumb_key: up.thumb_key, width: up.width, height: up.height },
      });
      const imageUrl = aiEnabled && wantVision
        ? await this.getImageHttpUrl(up.thumb_key || up.file_key)
        : undefined;
      console.debug('[sbe-photobank][debug] uploadSingle imageUrl:', imageUrl);
      const aiResult = aiEnabled ? await this.plugin.aiService.describe({
        fileName: file.name,
        folderPath: this.plugin.db.folderPath(folderId),
        kind,
        context: ctx,
        schema,
        imageUrl,
      }) : null;
      const now = new Date().toISOString();
      const photo: PhotoItem = {
        id: nextLocalId(),
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

  /** Возвращает временную https-ссылку на файл (presigned через rclone link) для vision-описания. */
  private async getImageHttpUrl(key: string): Promise<string | undefined> {
    console.debug('[sbe-photobank][debug] getImageHttpUrl key:', key);
    if (!key) return undefined;
    try {
      const url = await this.plugin.syncService.getFileLink(key);
      console.debug('[sbe-photobank][debug] getImageHttpUrl link:', url);
      if (!url || !/^https?:\/\//.test(url)) return undefined;
      return url;
    } catch (e: unknown) {
      console.warn('Фотобанк: не удалось получить ссылку на превью для vision:', errorMessage(e));
      return undefined;
    }
  }

  private async importFolderFlow(): Promise<void> {
    const me = await this.plugin.syncService.getMyPermission();
    if (!me.hasAccess || !['editor', 'admin', 'superadmin'].includes(me.role)) {
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
    let targetFolderId = this.state.currentFolderId;
    if (this.state.view !== 'folder' || !targetFolderId) {
      const chosen = await this.chooseTargetFolder('Импорт: папка назначения');
      if (chosen === null) return;
      targetFolderId = chosen;
    }
    const aiEnabled = await this.plugin.aiService.isAvailable();
    new Notice('Фотобанк: импорт начат…');
    const importRes = await this.plugin.importService.importFolder(folder, targetFolderId, aiEnabled, this.plugin.settings.visionEnabled);
    await this.refreshMeta();
    this.render();
    new Notice(`Фотобанк: импорт завершён — просмотрено ${importRes.scanned}, создано ${importRes.created}, пропущено ${importRes.skipped}`);
  }

  /** Выбор целевой папки банка (для загрузки/импорта). Возвращает folder_id или null при отмене. */
  private async chooseTargetFolder(prefix: string): Promise<number | null> {
    const folders = this.plugin.db.getFolders();
    const options = [
      { value: '0', label: 'Корень (без папки)' },
      ...folders.map(f => ({ value: String(f.id), label: f.name })),
    ];
    const result = await promptFields(this.app, prefix, [
      { key: 'folder', label: 'Папка назначения', type: 'select', options },
    ]);
    if (!result) return null;
    return parseInt(result.folder || '0', 10);
  }

  private async openCreateFolder(): Promise<void> {
    const me = await this.plugin.syncService.getMyPermission();
    if (!['admin', 'superadmin'].includes(me.role)) {
      new Notice('Фотобанк: создание папок доступно администратору системы');
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

    const modal = new SimpleModal(this.app, modalHtml);
    modal.open();
  }

  /** «Свойства папки»: переименование, ограниченный доступ, права, удаление (admin системы или папки). */
  private async openFolderSettings(folder: PhotoFolder): Promise<void> {
    const me = await this.plugin.syncService.getMyPermission();
    const globalAdmin = ['admin', 'superadmin'].includes(me.role);
    if (!globalAdmin) {
      // Возможно, админ этой папки — сервер проверит; показываем модал (сервер 403 на действия).
      new Notice('Фотобанк: свойства папок доступны администратору');
      return;
      return;
    }
    const modal = new FolderSettingsModal(this.app, this.plugin, folder, () => {
      void this.refreshMeta().then(() => this.render());
    }, (folderId) => {
      void this.rewriteFolderAiDescriptions(folderId);
    });
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

/** Простое модальное окно с произвольным содержимым. */
class SimpleModal extends Modal {
  private content: HTMLElement;

  constructor(app: App, content: HTMLElement) {
    super(app);
    this.content = content;
  }

  override onOpen(): void {
    this.contentEl.empty();
    this.contentEl.appendChild(this.content);
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

/** «Свойства папки»: переименование, права доступа (email/группы), переописание, удаление (admin). */
class FolderSettingsModal extends Modal {
  private plugin: SbePhotobankPlugin;
  private folder: PhotoFolder;
  private onChanged: () => void;
  private onRedescribe: (folderId: number) => void;

  constructor(
    app: App,
    plugin: SbePhotobankPlugin,
    folder: PhotoFolder,
    onChanged: () => void,
    onRedescribe: (folderId: number) => void,
  ) {
    super(app);
    this.plugin = plugin;
    this.folder = folder;
    this.onChanged = onChanged;
    this.onRedescribe = onRedescribe;
  }

  override onOpen(): void {
    this.contentEl.empty();
    this.titleEl.setText(`Свойства папки: ${this.folder.name}`);
    this.render();
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private render(): void {
    this.contentEl.empty();
    const box = this.contentEl.createDiv({ cls: 'tn-card' });

    // Переименование.
    box.createDiv({ cls: 'tn-photo-sidebar-title', text: 'Переименование' });
    const nameInput = box.createEl('input', { attr: { type: 'text' }, cls: 'tn-doc-input' });
    nameInput.value = this.folder.name;
    const renameBtn = box.createEl('button', { text: '💾 Переименовать', cls: 'tn-btn tn-btn-primary tn-photo-mb8' });
    renameBtn.addEventListener('click', async () => {
      const name = nameInput.value.trim();
      if (!name) { new Notice('Введите название'); return; }
      try {
        await this.plugin.syncService.renameFolder(this.folder.id, name);
        new Notice('Папка переименована');
        this.onChanged();
        this.folder.name = name;
        this.titleEl.setText(`Свойства папки: ${name}`);
      } catch (e: unknown) {
        new Notice(`Фотобанк: ${errorMessage(e)}`);
      }
    });

    // Ограниченный доступ: папка скрыта от общего просмотра, видна только по ролям.
    box.createDiv({ cls: 'tn-photo-sidebar-title', text: 'Ограниченный доступ' });
    const limRow = box.createDiv({ cls: 'tn-photo-field tn-photo-mb8' });
    const limLabel = limRow.createSpan({ cls: 'tn-photo-field-label', text: 'Видна только по ролям (не всем сотрудникам):' });
    const limCb = limRow.createEl('input', { attr: { type: 'checkbox' }, cls: 'tn-doc-cb' });
    limCb.checked = !!this.folder.limited;
    limCb.addEventListener('change', async () => {
      try {
        await this.plugin.syncService.setFolderLimited(this.folder.id, limCb.checked);
        this.folder.limited = limCb.checked;
        new Notice('Ограниченный доступ обновлён');
        this.onChanged();
      } catch (e: unknown) {
        new Notice(`Фотобанк: ${errorMessage(e)}`);
      }
    });

    // Права доступа.
    box.createDiv({ cls: 'tn-photo-sidebar-title', text: 'Права доступа' });
    const permsBox = box.createDiv({ cls: 'tn-photo-mb8' });
    void this.renderPerms(permsBox);

    // Переописание карточек этой папки через ИИ.
    box.createDiv({ cls: 'tn-photo-sidebar-title', text: 'ИИ-описание' });
    const redescribeBtn = box.createEl('button', {
      text: '♻️ Переописать фотографии папки',
      cls: 'tn-btn tn-btn-ghost tn-photo-mb8',
    });
    redescribeBtn.addEventListener('click', () => {
      this.onRedescribe(this.folder.id);
    });

    // Удаление.
    box.createDiv({ cls: 'tn-photo-sidebar-title', text: 'Удаление' });
    const delBtn = box.createEl('button', { text: '🗑 Удалить папку', cls: 'tn-btn tn-btn-danger' });
    delBtn.addEventListener('click', async () => {
      const confirmed = window.confirm ? window.confirm(`Удалить папку «${this.folder.name}» и все её файлы?`) : true;
      if (!confirmed) return;
      try {
        await this.plugin.syncService.deleteFolder(this.folder.id);
        new Notice('Папка удалена');
        this.onChanged();
        this.close();
      } catch (e: unknown) {
        new Notice(`Фотобанк: ${errorMessage(e)}`);
      }
    });
  }

  private async renderPerms(box: HTMLElement): Promise<void> {
    box.empty();
    try {
      const perms = await this.plugin.syncService.listFolderPerms(this.folder.id);
      for (const perm of perms) {
        const pRow = box.createDiv({ cls: 'tn-photo-field tn-photo-mb8' });
        pRow.createSpan({ text: `${perm.subject}: ${perm.role}` });
        const rm = pRow.createEl('button', { text: '✖', cls: 'tn-btn tn-btn-ghost' });
        rm.addEventListener('click', async () => {
          try {
            await this.plugin.syncService.setFolderPerm(this.folder.id, perm.subject, '');
            await this.renderPerms(box);
          } catch (e: unknown) {
            new Notice(`Фотобанк: ${errorMessage(e)}`);
          }
        });
      }
      const addRow = box.createDiv({ cls: 'tn-photo-field tn-photo-mb8' });
      const subjectInput = addRow.createEl('input', { attr: { type: 'text', placeholder: 'email или группа' }, cls: 'tn-doc-input' });
      const roleSelect = addRow.createEl('select', { cls: 'tn-doc-select' });
      roleSelect.createEl('option', { value: 'viewer', text: 'Сотрудник (просмотр)' });
      roleSelect.createEl('option', { value: 'editor', text: 'Редактор' });
      roleSelect.createEl('option', { value: 'admin', text: 'Администратор папки' });
      const add = addRow.createEl('button', { text: '➕', cls: 'tn-btn tn-btn-ghost' });
      add.addEventListener('click', async () => {
        const subject = subjectInput.value.trim();
        if (!subject) { new Notice('Введите email или группу'); return; }
        try {
          await this.plugin.syncService.setFolderPerm(this.folder.id, subject, roleSelect.value);
          await this.renderPerms(box);
        } catch (e: unknown) {
          new Notice(`Фотобанк: ${errorMessage(e)}`);
        }
      });
    } catch (e: unknown) {
      box.createDiv({ cls: 'tn-photo-empty', text: `Не удалось загрузить права: ${errorMessage(e)}` });
    }
  }
}
