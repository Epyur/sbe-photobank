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

  /** LLM-вызов с моделью из настроек; при HTTP 400 «model not recognized» — повтор
   *  без model (модель LLM-центра по умолчанию). Слишком строгий ответ (HTTP 429/504)
   *  и клиентские ошибки не ретраим. */
  private async completeJsonWithFallback<T>(
    llm: { completeJson<T>(system: string, user: string, opts?: { model?: string; temperature?: number }): Promise<T> },
    system: string,
    user: string,
  ): Promise<T> {
    const model = this.model();
    const opts = model ? { temperature: 0.4, model } : { temperature: 0.4 };
    try {
      return await llm.completeJson<T>(system, user, opts);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      // Нераспознанная модель — повторяем с моделью центра по умолчанию.
      if (model && msg.includes('HTTP 400')) {
        console.warn('Фотобанк: модель ИИ не распознана сервером, использую модель по умолчанию:', errorMessage(e));
        return llm.completeJson<T>(system, user, { temperature: 0.4 });
      }
      throw e;
    }
  }

  /** Формирует расширенное описание/теги/категорию/свои поля. Возвращает null, если
   *  ИИ недоступен — вызывающий переходит на ручное заполнение (graceful degradation).
   *  Если передан imageDataUrl (data URL превью файла), используется vision-запрос —
   *  ИИ видит изображение и описывает реальные цвета/материалы/композицию. */
  async describe(input: {
    fileName: string;
    folderPath: string;
    kind: string;
    context: AiDescribeContext;
    schema: SchemaField[];
    imageDataUrl?: string;
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

    // Промпт для vision (есть изображение) — просим описывать РЕАЛЬНО видимое на кадре.
    const systemVision = 'Ты — помощник по каталогизации корпоративного сток-фотобанка. ' +
      'Тебе дано изображение (превью) и контекст пользователя. Внимательно рассмотри картинку: ' +
      'опиши, что на ней реально видно (объекты, материалы, фактуру, сцену), композицию и угол съёмки, ' +
      'а ОСОБЕННО цветовую схему и цвета материалов (оттенки, покрытия, палитру). Учитывай контекст пользователя. ' +
      'Текст на русском. Верни ТОЛЬКО JSON без пояснений: ' +
      '{"title": "ОТОБРАЖАЕМОЕ В СТОКЕ ИМЯ файла — короткое, ёмкое, продающее (≤60 симв.), по которому файл показывается в сетке и поиске", ' +
      '"description": "3-5 предложений: что на кадре (по факту изображения), композиция и угол съёмки, цветовая схема и цвета материалов", ' +
      '"tags": ["3-7 коротких тегов, включая признаки кадра/цвета/материала"], "category": "категория (если угадывается)", "location": "локация", "shot_at": 0, ' +
      '"custom": {ключи своих полей из схемы — только если подходят}}';

    // Промпт без изображения — описание по контексту и имени.
    const systemText = 'Ты — помощник по каталогизации корпоративного сток-фотобанка. ' +
      'По контексту пользователя, имени файла и типу медиа составь краткое, точное расширенное описание ' +
      'и метаданные для поиска. В описание обязательно включи, что именно на кадре (объекты, сцена, действие), ' +
      'композицию и угол съёмки (крупный/общий план, ракурс, перспектива), цветовую схему и атмосферу ' +
      '(палитра, свет, тон), а также любые детали, которые упомянул пользователь в контексте. ' +
      'Текст на русском. Верни ТОЛЬКО JSON без пояснений: ' +
      '{"title": "ОТОБРАЖАЕМОЕ В СТОКЕ ИМЯ файла — короткое, ёмкое, продающее (≤60 симв.), по которому файл показывается в сетке и поиске", ' +
      '"description": "3-5 предложений: что на кадре, композиция и угол съёмки, цветовая схема и свет, детали из контекста", ' +
      '"tags": ["3-7 коротких тегов, включая признаки кадра/палитры"], "category": "категория (если угадывается)", "location": "локация", "shot_at": 0, ' +
      '"custom": {ключи своих полей из схемы — только если подходят}}';

    const system = input.imageDataUrl ? systemVision : systemText;

    const user = `Имя файла: ${input.fileName}
Путь в банке: ${input.folderPath || 'корень'}
Тип медиа: ${input.kind}
${schemaBlock}
Контекст пользователя:
- Что на кадре: ${input.context.content || 'не указано'}
- Событие/съёмка: ${input.context.event || 'не указано'}
- Локация: ${input.context.location || 'не указано'}
- Персоны: ${input.context.people || 'не указано'}
- Цель использования: ${input.context.purpose || 'не указано'}`;

    try {
      let result: Partial<AiDescribeResult>;
      if (input.imageDataUrl) {
        result = await this.completeVisionJson<Partial<AiDescribeResult>>(llm, system, user, input.imageDataUrl);
      } else {
        result = await this.completeJsonWithFallback<Partial<AiDescribeResult>>(llm, system, user);
      }
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

  /** Vision-запрос с извлечением JSON; при HTTP 400 (текстовая модель / неверная модель)
   *  — падаем (не повторяем без изображения: иначе вернём описание «вслепую»). */
  private async completeVisionJson<T>(
    llm: { completeVision(system: string, user: string, imageUrl: string, opts?: { model?: string; temperature?: number }): Promise<string> },
    system: string,
    user: string,
    imageDataUrl: string,
  ): Promise<T> {
    const model = this.model();
    const opts = model ? { temperature: 0.4, model } : { temperature: 0.4 };
    const text = await llm.completeVision(system, user, imageDataUrl, opts);
    let parsed: unknown;
    try {
      parsed = this.extractJson(text);
    } catch (firstErr: unknown) {
      console.warn('Фотобанк: первый vision-ответ не JSON, повторный запрос:', errorMessage(firstErr));
      const retry = await llm.completeVision(
        system,
        'Предыдущий ответ не был валидным JSON. Верни ТОЛЬКО JSON по той же схеме.',
        imageDataUrl,
        opts,
      );
      parsed = this.extractJson(retry);
    }
    return parsed as T;
  }

  private extractJson(text: string): unknown {
    let cleaned = text.trim();
    const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) cleaned = fence[1].trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1 || end < start) throw new Error('JSON не найден в ответе LLM');
    return JSON.parse(cleaned.substring(start, end + 1));
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
      const result = await this.completeJsonWithFallback<{ keywords?: unknown }>(llm, system, `Запрос: ${q}`);
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
