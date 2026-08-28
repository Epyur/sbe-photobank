import { App, Modal, Notice } from 'obsidian';

export interface PromptField {
  label: string;
  placeholder?: string;
  /** Имя поля (ключ результата). */
  key: string;
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
    const inputs: Record<string, HTMLInputElement> = {};

    const card = modal.contentEl.createDiv({ cls: 'tn-card' });
    for (const f of fields) {
      card.createDiv({ cls: 'tn-photo-field-label', text: f.label });
      const input = card.createEl('input', {
        attr: { type: 'text', placeholder: f.placeholder || '' },
        cls: 'tn-doc-input',
      });
      inputs[f.key] = input;
    }

    const actions = card.createDiv({ cls: 'tn-photo-detail-actions' });
    const okBtn = actions.createEl('button', { cls: 'tn-btn tn-btn-primary', text: 'ОК' });
    okBtn.addEventListener('click', () => {
      const result: PromptResult = {};
      for (const f of fields) {
        result[f.key] = inputs[f.key].value.trim();
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
    if (lastInput) {
      lastInput.addEventListener('keydown', (ev: KeyboardEvent) => {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          okBtn.click();
        }
      });
    }

    modal.onOpen = () => {
      const first = fields.length > 0 ? inputs[fields[0].key] : undefined;
      if (first) {
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
