import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type SbePhotobankPlugin from '../main';
import { errorMessage } from '../../../sbe-core/src/utils/errors';
import { promptFields } from './prompt-modal';

const ROLE_LABELS: Record<string, string> = {
  viewer: 'Просмотр',
  commenter: 'Просмотр + комментарии',
  editor: 'Редактор',
  admin: 'Администратор',
};

export class PhotobankSettingsTab extends PluginSettingTab {
  plugin: SbePhotobankPlugin;

  constructor(app: App, plugin: SbePhotobankPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setHeading()
      .setName('Сервер');

    new Setting(containerEl)
      .setName('Адрес сервера (apiUrl)')
      .setDesc('База URL photo-service, например https://epyur.fvds.ru. JWT берётся из ЦУП СБЕ — отдельный токен не нужен.')
      .addText(text => text
        .setPlaceholder('https://epyur.fvds.ru')
        .setValue(this.plugin.settings.apiUrl)
        .onChange(async (value) => {
          this.plugin.settings.apiUrl = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setHeading()
      .setName('ИИ (LLM-центр)');

    new Setting(containerEl)
      .setName('Модель ИИ')
      .setDesc('Модель для ИИ-описания при загрузке и умного поиска. Используется через плагин «SBE LLM Center» (sbe-llm). Пусто — модель по умолчанию LLM-центра.')
      .addText(text => text
        .setPlaceholder('deepseek-v4-pro')
        .setValue(this.plugin.settings.llmModel)
        .onChange(async (value) => {
          this.plugin.settings.llmModel = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setHeading()
      .setName('Права доступа');

    const permsDiv = containerEl.createDiv({ cls: 'tn-doc-meta' });
    permsDiv.setText('Загрузка…');
    void this.renderPermissions(permsDiv);

    new Setting(containerEl)
      .setHeading()
      .setName('Группы');

    const groupsDiv = containerEl.createDiv({ cls: 'tn-doc-meta' });
    groupsDiv.setText('Загрузка…');
    void this.renderGroups(groupsDiv);

    new Setting(containerEl)
      .setHeading()
      .setName('Схема своих полей');

    const schemaDiv = containerEl.createDiv({ cls: 'tn-doc-meta' });
    schemaDiv.setText('Загрузка…');
    void this.renderSchema(schemaDiv);
  }

  private async renderPermissions(container: HTMLElement): Promise<void> {
    try {
      const me = await this.plugin.syncService.getMyPermission();
      if (!me.hasAccess) {
        container.setText('Нет доступа к серверу. Запросите ключ в ЦУП и получите доступ у администратора.');
        return;
      }
      if (me.role !== 'admin') {
        container.setText(`Ваша роль: ${ROLE_LABELS[me.role] || me.role}. Только администратор может управлять правами.`);
        return;
      }
      container.empty();
      const perms = await this.plugin.syncService.listPermissions();
      const table = container.createEl('table', { cls: 'tn-table' });
      const thead = table.createEl('thead');
      const hr = thead.createEl('tr');
      hr.createEl('th').setText('Email');
      hr.createEl('th').setText('Роль');
      hr.createEl('th').setText('Действия');
      const tbody = table.createEl('tbody');
      for (const p of perms) {
        const row = tbody.createEl('tr');
        row.createEl('td').setText(p.email);
        const roleCell = row.createEl('td');
        const isOwner = p.email === me.email;
        if (isOwner) {
          roleCell.setText(`${ROLE_LABELS[p.role] || p.role} (это вы)`);
        } else {
          const roleSelect = roleCell.createEl('select', { cls: 'tn-doc-select' });
          roleSelect.createEl('option', { value: 'viewer', text: 'Просмотр' });
          roleSelect.createEl('option', { value: 'commenter', text: 'Просмотр + комментарии' });
          roleSelect.createEl('option', { value: 'editor', text: 'Редактор' });
          roleSelect.createEl('option', { value: 'admin', text: 'Администратор' });
          roleSelect.value = p.role;
          roleSelect.addEventListener('change', async () => {
            try {
              await this.plugin.syncService.setPermission(p.email, roleSelect.value);
              new Notice(`Роль ${p.email} обновлена`);
            } catch (e: unknown) {
              new Notice(`Ошибка: ${errorMessage(e)}`);
            }
          });
        }
        const actionsCell = row.createEl('td');
        if (!isOwner) {
          const removeBtn = actionsCell.createEl('button', { text: '✖ Убрать', cls: 'tn-btn tn-btn-ghost' });
          removeBtn.addEventListener('click', async () => {
            try {
              await this.plugin.syncService.setPermission(p.email, '');
              new Notice(`Доступ ${p.email} отозван`);
              container.empty();
              container.setText('Загрузка…');
              void this.renderPermissions(container);
            } catch (e: unknown) {
              new Notice(`Ошибка: ${errorMessage(e)}`);
            }
          });
        }
      }
      const addRow = tbody.createEl('tr');
      const emailCell = addRow.createEl('td');
      const emailInput = emailCell.createEl('input', { attr: { type: 'text', placeholder: 'email@tn.ru' }, cls: 'tn-doc-input' });
      const roleCell = addRow.createEl('td');
      const roleSelect = roleCell.createEl('select', { cls: 'tn-doc-select' });
      roleSelect.createEl('option', { value: 'viewer', text: 'Просмотр' });
      roleSelect.createEl('option', { value: 'commenter', text: 'Просмотр + комментарии' });
      roleSelect.createEl('option', { value: 'editor', text: 'Редактор' });
      roleSelect.createEl('option', { value: 'admin', text: 'Администратор' });
      const actionCell = addRow.createEl('td');
      const addBtn = actionCell.createEl('button', { text: '➕ Добавить', cls: 'tn-btn tn-btn-primary' });
      addBtn.addEventListener('click', async () => {
        const email = emailInput.value.trim();
        if (!email) { new Notice('Введите email'); return; }
        try {
          await this.plugin.syncService.setPermission(email, roleSelect.value);
          new Notice(`Доступ выдан: ${email}`);
          container.empty();
          container.setText('Загрузка…');
          void this.renderPermissions(container);
        } catch (e: unknown) {
          new Notice(`Ошибка: ${errorMessage(e)}`);
        }
      });
    } catch (e: unknown) {
      container.setText(`Не удалось загрузить права: ${errorMessage(e)}`);
    }
  }

  private async renderGroups(container: HTMLElement): Promise<void> {
    try {
      const me = await this.plugin.syncService.getMyPermission();
      if (!me.hasAccess) {
        container.setText('Нет доступа к серверу.');
        return;
      }
      if (me.role !== 'admin') {
        container.setText('Управление группами доступно только администратору.');
        return;
      }
      container.empty();
      await this.plugin.syncService.fetchGroups('');
      const groups = this.plugin.db.getGroups();
      for (const g of groups) {
        const row = container.createDiv({ cls: 'tn-doc-mb8' });
        const nameEl = row.createEl('input', { attr: { type: 'text', placeholder: 'Название группы' }, cls: 'tn-doc-input' });
        nameEl.value = g.name;
        const membersEl = row.createEl('input', { attr: { type: 'text', placeholder: 'email@tn.ru, …' }, cls: 'tn-doc-input' });
        membersEl.value = (g.members || []).join(', ');
        const saveBtn = row.createEl('button', { text: '💾', cls: 'tn-btn tn-btn-ghost' });
        saveBtn.addEventListener('click', async () => {
          try {
            await this.plugin.syncService.saveGroup({
              id: g.id,
              name: nameEl.value.trim(),
              members: membersEl.value.split(',').map(s => s.trim()).filter(Boolean),
            });
            new Notice('Группа сохранена');
          } catch (e: unknown) {
            new Notice(`Ошибка: ${errorMessage(e)}`);
          }
        });
        const delBtn = row.createEl('button', { text: '✖', cls: 'tn-btn tn-btn-ghost' });
        delBtn.addEventListener('click', async () => {
          try {
            await this.plugin.syncService.deleteGroup(g.id);
            new Notice('Группа удалена');
            container.empty();
            container.setText('Загрузка…');
            void this.renderGroups(container);
          } catch (e: unknown) {
            new Notice(`Ошибка: ${errorMessage(e)}`);
          }
        });
      }
      const addBtn = container.createEl('button', { text: '➕ Создать группу', cls: 'tn-btn tn-btn-primary' });
      addBtn.addEventListener('click', async () => {
        const result = await promptFields(this.app, 'Новая группа', [
          { key: 'name', label: 'Название группы' },
        ]);
        if (!result) return;
        const name = (result.name || '').trim();
        if (!name) return;
        try {
          await this.plugin.syncService.saveGroup({ id: 0, name, members: [] });
          new Notice('Группа создана');
          container.empty();
          container.setText('Загрузка…');
          void this.renderGroups(container);
        } catch (e: unknown) {
          new Notice(`Ошибка: ${errorMessage(e)}`);
        }
      });
    } catch (e: unknown) {
      container.setText(`Не удалось загрузить группы: ${errorMessage(e)}`);
    }
  }

  private async renderSchema(container: HTMLElement): Promise<void> {
    try {
      const me = await this.plugin.syncService.getMyPermission();
      if (!me.hasAccess) {
        container.setText('Нет доступа к серверу.');
        return;
      }
      if (me.role !== 'admin') {
        container.setText('Настройка схемы доступна только администратору.');
        return;
      }
      container.empty();
      await this.plugin.syncService.fetchSchema('');
      const fields = this.plugin.db.getSchema().map(f => ({ ...f }));

      const render = (): void => {
        container.empty();
        for (const [i, f] of fields.entries()) {
          const row = container.createDiv({ cls: 'tn-doc-mb8 tn-doc-flex' });
          const keyEl = row.createEl('input', { attr: { type: 'text', placeholder: 'ключ' }, cls: 'tn-doc-input' });
          keyEl.value = f.key;
          keyEl.addEventListener('change', () => { f.key = keyEl.value.trim(); });
          const typeEl = row.createEl('select', { cls: 'tn-doc-select' });
          for (const t of ['text', 'list', 'date', 'number', 'bool']) {
            typeEl.createEl('option', { value: t, text: t });
          }
          typeEl.value = f.type;
          typeEl.addEventListener('change', () => { f.type = typeEl.value as SchemaType; });
          const labelEl = row.createEl('input', { attr: { type: 'text', placeholder: 'Название' }, cls: 'tn-doc-input' });
          labelEl.value = f.label;
          labelEl.addEventListener('change', () => { f.label = labelEl.value.trim(); });
          const reqEl = row.createEl('input', { attr: { type: 'checkbox' } });
          reqEl.checked = f.required;
          reqEl.addEventListener('change', () => { f.required = reqEl.checked; });
          const delBtn = row.createEl('button', { text: '✖', cls: 'tn-btn tn-btn-ghost' });
          delBtn.addEventListener('click', () => {
            fields.splice(i, 1);
            render();
          });
        }
        const addBtn = container.createEl('button', { text: '➕ Добавить поле', cls: 'tn-btn tn-btn-ghost' });
        addBtn.addEventListener('click', () => {
          fields.push({ key: '', type: 'text', label: '', required: false });
          render();
        });
        const saveBtn = container.createEl('button', { text: '💾 Сохранить схему', cls: 'tn-btn tn-btn-primary' });
        saveBtn.addEventListener('click', async () => {
          try {
            const cleaned = fields.filter(f => f.key.trim() !== '');
            await this.plugin.syncService.setSchema(cleaned);
            this.plugin.db.setSchema(cleaned);
            await this.plugin.db.save();
            new Notice('Схема сохранена');
          } catch (e: unknown) {
            new Notice(`Ошибка: ${errorMessage(e)}`);
          }
        });
      };
      render();
    } catch (e: unknown) {
      container.setText(`Не удалось загрузить схему: ${errorMessage(e)}`);
    }
  }
}

type SchemaType = 'text' | 'list' | 'date' | 'number' | 'bool';
