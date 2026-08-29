# specification.md — sbe-photobank (LogicTEAM.Фотобанк)

## 1. Идентификация

- `manifest.id`: `sbe-photobank`
- Имя: LogicTEAM.Фотобанк
- Версия: 0.1.16
- Автор: Полищук Евгений (polishchuk@tn.ru)
- Зависимость от `sbe-core` (при сборке), `sbe-llm` (ИИ-описание/поиск), `sbe-apstore`
  (JWT, новости)
- Сервер: photo-service (Go, БД `photo`, S3 `sbe-photo`), деплой `/opt/mailers/photo-service/`

## 2. Публикуемый сервис (мост `window.SBE`)

Идентификатор сервиса: `sbe-photobank` (тип `SbePhotobankApi` в `sbe-core/src/types.ts`).

| Метод | Сигнатура | Описание |
|---|---|---|
| `open` | `() => Promise<void>` | Открыть фасад «LogicLAB.Фотобанк» (из ЦУП) |

## 3. Авторизация

Все запросы к photo-service — JWT Bearer. JWT берётся из ЦУП СБЕ:
`getService('sbe-apstore').auth.getToken('photo')`. При 401 — «Ключ доступа
недействителен», при 403 — «Нет прав доступа».

## 4. Модель (PhotoItem / Folder / Group / Schema)

```jsonc
{
  "id": 1786...,                 // int64; новые локальные = 0 (сервер назначает id)
  "folder_id": 12,               // папка банка (0 = без папки)
  "title": "Цех розлива…",
  "description": "…",            // расширенное описание (ИИ + ручное)
  "tags": ["цех", "розлив"],
  "custom": { "obekt": "…" },    // значения своих полей (JSONB)
  "file_key": "photo/<uuid>/original-<name>",  // S3-ключ оригинала
  "file_name": "…", "file_size": 123,
  "content_hash": "sha256-hex",  // дедуп при импорте
  "mime_type": "image/jpeg",
  "kind": "image|video|raw",
  "width": 4000, "height": 3000, // image (0 иначе)
  "duration": 0,                 // видео, сек
  "thumb_key": "photo/…/thumb-…",// миниатюра/обложка ("" = нет)
  "thumb_author": "auto|user",   // auto — серверная миниатюра image; user — обложка видео/RAW
  "author_email": "polishchuk@tn.ru",
  "shot_at": 1723420800000,      // дата съёмки, мс (0 = нет)
  "location": "Москва",
  "visibility_override": "|grant|deny",  // точечный override видимости
  "download_count": 5, "likes_count": 2,
  "created_at": "…", "updated_at": "…",  // ISO8601; LWW по updated_at
  "sync_status": "local | synced"        // только локально
}
```

- `PhotoFolder`: `{id, name, parent_id, owner_email, limited, created_at, updated_at}` —
  `limited` = «ограниченный доступ» (папка скрыта от общего просмотра).
- `PhotoGroup`: `{id, name, members[]}` — субъект доступа (email или имя группы).
- `SchemaField`: `{key, type(text|list|date|number|bool), label, required, options?}`.

Локальная БД: `yourbase/sbe_photobank/photos_data.json` →
`{"folders": [...], "photos": [...], "groups": [...], "schema": [...]}`.
Файлы/превью — только по требованию из S3 через сервис (бакет `sbe-photo` приватный).

## 5. Endpoints (photo-service)

### POST /api/photo/sync/push — приём/обновление карточек (editor+)
- Тело: `{"photos": [PhotoItem, ...]}`. `id>0` → UPDATE по `updated_at < $N`; `id=0` → INSERT.
- Ответ: `{"inserted": N, "updated": M}`.

### GET /api/photo/sync/pull — выгрузка видимых карточек (viewer+)
- Ответ: `{"photos": [PhotoItem, ...]}`. Видимость: папка видна пользователю (или его группе)
  напрямую или через предка; **limited-папка скрыта от общего просмотра** (видна только по
  назначенным ролям); grant-override добавляет файл; deny скрывает от всех, кроме admin.

### POST /api/photo/file — загрузка оригинала в S3 (editor+)
- `multipart/form-data`: `file` + `folder_id` + `kind` + `mime_type`.
- Для `kind=image` сервер сам создаёт миниатюру ≤800×800 (jpeg, `thumb_author=auto`).
- Ответ: `{file_key, file_name, file_size, file_url, thumb_key, thumb_author, width, height}`.

### POST /api/photo/thumb — загрузка обложки для видео/RAW (editor+)
- `multipart/form-data`: `file` + `photo_id`. Ответ: `{thumb_key, thumb_author:"user"}`.

### GET /api/photo/file?key=...&view=1 — скачивание файла из S3 (viewer+, в рамках видимого)
- `view=1` — просмотр превью/миниатюры, `download_count` НЕ растёт.
- Без `view` — явное скачивание, `download_count` +1.

### GET /api/photo/file-link?key=... — временная публичная ссылка (viewer+)
- `rclone link --expire 7d`; ответ `{"url": ...}`.

### GET /api/photo/search?q=...&folder_id=&kind= — свободный поиск (viewer+)
- Полнотекст `to_tsvector('russian')` по `title/description/tags/custom/location` +
  **путь папок** (рекурсивно имя папки и предков) в пределах видимого; сортировка
  `updated_at DESC`, лимит 500.
- Многословный запрос разбивается на слова и объединяется **OR** (не AND), чтобы найти
  запись, где совпало хотя бы одно слово (напр. «Красный фальц» находит по «фальц»).
  LLM-fallback — на клиенте (sbe-llm).

### Папки и права
- `GET /api/photo/folders` (viewer+), `POST /api/photo/folders` (admin системы;
  админ папки — подпапки в своей папке), `POST /api/photo/folders/rename`,
  `DELETE /api/photo/folders/{id}` (admin системы или папки, каскадно),
  `GET/POST /api/photo/folders/{id}/permissions` (admin системы или папки),
  `POST /api/photo/folders/{id}/limited` (admin системы или папки, `{limited: bool}`).

### Глобальные роли и общий доступ
- `GET /api/photo/permissions/me` (viewer+), `GET/POST /api/photo/permissions` (admin).
- Роли: `viewer` (Сотрудник) < `commenter` < `editor` (Редактор) < `admin` (Администратор) <
  `superadmin` (Администратор системы; назначает только действующий superadmin, владелец).
- **Общий доступ** (`photo_common_access`, по умолчанию `viewer` — все сотрудники видят
  папки): `GET/POST /api/photo/common-access` (admin). `""` — закрыть общий доступ.
- **Роли на папку** (`folder_permissions`): `viewer` «Сотрудник» (просмотр/скачивание) /
  `editor` «Редактор» (правка описаний + загрузка) / `admin` «Администратор папки»
  (права редактора + подпапки + удаление фото).

### Группы
- `GET /api/photo/groups` (viewer+), `POST /api/photo/groups` (admin), `DELETE /api/photo/groups/{id}` (admin).

### Схема своих полей
- `GET /api/photo/schema` (viewer+), `POST /api/photo/schema` (admin).

### Соцслой
- `GET/POST /api/photo/photos/{id}/comments` (viewer+/commenter+), `POST /api/photo/photos/{id}/like`
  (commenter+), `POST /api/photo/photos/{id}/favorite` (commenter+), `GET /api/photo/favorites`,
  `GET /api/photo/recent`, `POST /api/photo/photos/{id}/view` (viewer+, фиксирует «недавние»).

### Override видимости
- `GET/POST /api/photo/photos/{id}/visibility` (admin): `{override: "|grant|deny", subjects[]}`.

### Удаление
- `DELETE /api/photo/photos/{id}` (admin системы или папки, или автор карточки).

### GET /api/photo/health — статус.

## 6. S3

- Бакет `sbe-photo` (endpoint s3.firstvds.ru, Ceph). Доступ через rclone CLI внутри
  photo-service (remote `firstvds_photo`, конфиг из env `S3_ENDPOINT`/`S3_ACCESS_KEY`/
  `S3_SECRET_KEY` при старте). НЕ используем mailers-backup.
- Ключи: `photo/{uuid}/original-{name}`, `photo/{uuid}/thumb-{name}`.

## 7. Сервер (photo-service)

- Go-сервис, контейнер `photo`, БД `photo` (postgres `photo-db`).
- Таблицы: `photo_permissions`, `groups`, `folders`, `folder_permissions`, `photos`,
  `photo_access`, `comments`, `likes`, `favorites`, `recent_views`, `schema`.
- JWT: app_id `photo`, роли SBE, owner_email = polishchuk@tn.ru (seed при старте).
- При старте: `POST /apps/register` (PHOTO_APP_ID/NAME/OWNER_EMAIL/SERVICE_SECRET).
- Caddy: `/api/photo/*` → `photo:3000` (до `/api/documents/*` и `/api/*`).
- Миниатюры изображений — Go-ресайз (`golang.org/x/image`, CatmullRom ≤800×800, JPEG q82).
- Зависимости Go — только свободные (MIT/BSD-3-Clause).

## 8. ИИ-описание и поиск (клиент)

- **ИИ-описание при загрузке**: пользователь даёт контекст (что на кадре, событие, локация,
  персоны, цель) → плагин через `getService('sbe-llm').completeJson` получает
  `{title, description, tags[], category?, location?, shot_at?, custom{...}}`, где `title` —
  **отображаемое в стоке имя файла** (короткое, ёмкое, ≤60 симв.), а `description` (3-5
  предложений) обязательно включает что на кадре, композицию и угол съёмки, цветовую схему
  и свет — с учётом контекста пользователя. Перезапрос описания — кнопка «♻️ ИИ-описание»
  в карточке (контекст запрашивается заново, результат пушится). Vision у sbe-llm нет —
  описание строится из контекста + имени файла + папки. Если sbe-llm недоступен — ручное
  заполнение (graceful degradation).
- **Поиск**: сначала серверный FTS; при результате < 5 — `expandQuery` (LLM превращает запрос
  в набор тегов) → повторный FTS по ним; результаты объединяются без дублей.

## 9. Импорт папки вольта

- editor+ выбирает папку вольта → рекурсивный обход медиа → подпапки создаются папками банка
  → загрузка файлов в S3 → создание карточек (`sync_status=local`). Дедуп по `content_hash`
  (SHA-256): файл, уже существующий в банке, пропускается. ИИ-описание применяется при импорте,
  если sbe-llm доступен.

## 10. Настройки (data.json)

`apiUrl` (default `https://epyur.fvds.ru`), `syncIntervalMs` (default 300000 — фоновый pull),
`llmModel` (модель ИИ для описания и поиска; пусто — модель LLM-центра по умолчанию),
`visionEnabled` (false — при включении превью фото передаётся в ИИ через `completeVision`:
описываются реальные цвета/материалы; нужна vision-модель в chat-формате),
`lastAnnouncedVersion` (версия, для которой опубликована новость в ЦУП).

## 11. Сборка и проверка

- `npm install` → `npm run build` (esbuild, бандл `src/main.ts` → `main.js`, склейка styles)
  → `npx tsc --noEmit` (EXIT=0).
- Включённые файлы релиза: `main.js`, `styles.css`, `manifest.json`, `README.md`.
