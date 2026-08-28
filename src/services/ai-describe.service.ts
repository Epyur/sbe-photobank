import { getService } from '../../../sbe-core/src/bridge';
import { errorMessage } from '../../../sbe-core/src/utils/errors';
import type { AiDescribeContext, AiDescribeResult, SchemaField } from '../types/photobank';

/** ИИ-описание при загрузке через sbe-llm (клиент). Vision у центра нет — описание
 *  строится из контекста пользователя + имени файла + авто-метаданных. */
export class AiDescribeService {
  private getModel: () => string;

  constructor(getModel: () => string) {
    this.getModel = getModel;
  }

  private model(): string | undefined {
    const m = this.getModel().trim();
    return m ? m : undefined;
  }

  /** Готов ли LLM-центр. */
  async isAvailable(): Promise<boolean> {
    try {
      const llm = await getService('sbe-llm');
      return llm.getStatus().configured;
    } catch {
      return false;
    }
  }

  /** Формирует расширенное описание/теги/категорию/свои поля. Возвращает null, если
   *  ИИ недоступен — вызывающий переходит на ручное заполнение (graceful degradation). */
  async describe(input: {
    fileName: string;
    folderName: string;
    kind: string;
    context: AiDescribeContext;
    schema: SchemaField[];
  }): Promise<AiDescribeResult | null> {
    let llm;
    try {
      llm = await getService('sbe-llm');
    } catch (e: unknown) {
      console.warn('Фотобанк: LLM недоступен, ИИ-описание пропущено:', errorMessage(e));
      return null;
    }
    if (!llm.getStatus().configured) return null;

    const schemaBlock = input.schema.length > 0
      ? '\nПоля схемы (их тоже заполни, если подходит контексту): ' + input.schema.map(f => `${f.key} (${f.type}, ${f.required ? 'обязательное' : 'необязательное'})`).join(', ')
      : '\nСвои поля не настроены.';

    const system = 'Ты — помощник по каталогизации корпоративного сток-фотобанка. ' +
      'По контексту пользователя, имени файла и типу медиа составь краткое, точное расширенное описание ' +
      'и метаданные для поиска. Текст на русском. Верни ТОЛЬКО JSON без пояснений: ' +
      '{"title": "короткое название (≤60 симв.)", "description": "2-4 предложения: что на кадре, детали, атмосфера", ' +
      '"tags": ["3-7 коротких тегов"], "category": "категория (если угадывается)", "location": "локация", "shot_at": 0, ' +
      '"custom": {ключи своих полей из схемы — только если подходят}}';

    const user = `Имя файла: ${input.fileName}
Папка: ${input.folderName}
Тип медиа: ${input.kind}
${schemaBlock}
Контекст пользователя:
- Что на кадре: ${input.context.content || 'не указано'}
- Событие/съёмка: ${input.context.event || 'не указано'}
- Локация: ${input.context.location || 'не указано'}
- Персоны: ${input.context.people || 'не указано'}
- Цель использования: ${input.context.purpose || 'не указано'}`;

    try {
      const result = await llm.completeJson<Partial<AiDescribeResult>>(system, user, { temperature: 0.4, model: this.model() });
      return {
        title: (result.title || '').trim().slice(0, 120) || '',
        description: (result.description || '').trim() || '',
        tags: Array.isArray(result.tags)
          ? result.tags.map(t => String(t).trim()).filter(Boolean).slice(0, 10)
          : [],
        category: (result.category || '').trim() || undefined,
        location: (result.location || '').trim() || undefined,
        shot_at: typeof result.shot_at === 'number' && result.shot_at > 0 ? result.shot_at : 0,
        custom: result.custom && typeof result.custom === 'object' ? result.custom as Record<string, unknown> : {},
      };
    } catch (e: unknown) {
      console.warn('Фотобанк: ИИ-описание не удалось:', errorMessage(e));
      return null;
    }
  }

  /** LLM-fallback поиска: свободный запрос → набор тегов/полей → повторный FTS. */
  async expandQuery(q: string): Promise<{ keywords: string[] } | null> {
    let llm;
    try {
      llm = await getService('sbe-llm');
    } catch {
      return null;
    }
    if (!llm.getStatus().configured) return null;

    const system = 'Ты помогаешь искать фото в корпоративном фотобанке. По свободному запросу пользователя ' +
      'верни ТОЛЬКО JSON: {"keywords": ["3-6 ключевых слов/тегов для полнотекстового поиска"]}. Слова — на русском, краткие.';
    try {
      const result = await llm.completeJson<{ keywords?: unknown }>(system, `Запрос: ${q}`, { temperature: 0.3, model: this.model() });
      const keywords = Array.isArray(result.keywords)
        ? result.keywords.map(k => String(k).trim()).filter(Boolean).slice(0, 8)
        : [];
      if (keywords.length === 0) return null;
      return { keywords };
    } catch (e: unknown) {
      console.warn('Фотобанк: расширение запроса не удалось:', errorMessage(e));
      return null;
    }
  }
}
