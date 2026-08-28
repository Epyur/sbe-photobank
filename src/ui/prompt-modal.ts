import { App, Modal, Notice } from 'obsidian';

export interface PromptField {
  label: string;
  placeholder?: string;
  /** Имя поля (ключ результата). */
  key: string;
  /** Тип поля: text (по умолчанию) или select. */
  type?: 'text' | 'select';
  /** Варианты для type='select'. */
  options?: Array<{ value: string; label: string }>;
}

export interface PromptResult {
  [key: string]: string;
}

/** Модальное окно с одним или несколькими текстовыми полями (замена window.prompt,
 *  который в Obsidian/Electron не поддерживается). Возвращает null при отмене. */
export function promptFields(app: App, title: string, fields: PromptField[]): Promise<PromptResult | null> {
  return new Promise(resolve => {
    const modal = new Modal(app);
    modal.titleEl.setText(title);
    const inputs: Record<string, HTMLInputElement | HTMLSelectElement> = {};

    const card = modal.contentEl.createDiv({ cls: 'tn-card' });
    for (const f of fields) {
      card.createDiv({ cls: 'tn-photo-field-label', text: f.label });
      if (f.type === 'select' && f.options) {
        const select = card.createEl('select', { cls: 'tn-doc-select' });
        for (const o of f.options) {
          select.createEl('option', { value: o.value, text: o.label });
        }
        inputs[f.key] = select;
      } else {
        const input = card.createEl('input', {
          attr: { type: 'text', placeholder: f.placeholder || '' },
          cls: 'tn-doc-input',
        });
        inputs[f.key] = input;
      }
    }

    const actions = card.createDiv({ cls: 'tn-photo-detail-actions' });
    const okBtn = actions.createEl('button', { cls: 'tn-btn tn-btn-primary', text: 'ОК' });
    okBtn.addEventListener('click', () => {
      const result: PromptResult = {};
      for (const f of fields) {
        const el = inputs[f.key];
        result[f.key] = el.value.trim();
      }
      modal.close();
      resolve(result);
    });
    const cancelBtn = actions.createEl('button', { cls: 'tn-btn tn-btn-ghost', text: 'Отмена' });
    cancelBtn.addEventListener('click', () => {
      modal.close();
      resolve(null);
    });

    // Enter в последнем поле = ОК.
    const lastInput = fields.length > 0 ? inputs[fields[fields.length - 1].key] : undefined;
    if (lastInput && lastInput instanceof HTMLInputElement) {
      lastInput.addEventListener('keydown', (ev: KeyboardEvent) => {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          okBtn.click();
        }
      });
    }

    modal.onOpen = () => {
      const first = fields.length > 0 ? inputs[fields[0].key] : undefined;
      if (first && first instanceof HTMLInputElement) {
        window.setTimeout(() => first.focus(), 50);
      }
    };
    modal.open();
  });
}

/** Утилита для случаев, когда нужен одиночный ввод (для Notices/ошибок). */
export function noticeError(e: unknown): void {
  new Notice(e instanceof Error ? e.message : String(e));
}
