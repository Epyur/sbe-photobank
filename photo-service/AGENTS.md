# AGENTS.md — photo-service (Фотобанк)

Go-сервис фотобанка для SBE-плагина «Фотобанк» (sbe-photobank). Контейнер `photo`,
БД `photo` (postgres `photo-db`), авторизация — JWT HS256 (per-service секрет
`PHOTO_SERVICE_SECRET`, общий с auth-service) + роли из `photo_permissions`.
Файлы — в S3 (бакет `sbe-photo`) через rclone CLI. Деплой: `/opt/mailers/photo-service/`.

## Назначение (текущее)

- **Карточки**: `POST /api/photo/sync/push`, `GET /api/photo/sync/pull` (только видимое).
  Модель — `Photo` (folders/photos/группы/схема своих полей, спека §4).
- **Файлы**: `POST /api/photo/file` (оригинал в S3; для изображений — серверная миниатюра
  `thumb_author=auto`), `POST /api/photo/thumb` (пользовательская обложка для видео/RAW),
  `GET /api/photo/file?key=...` (скачивание, +счётчик), `GET /api/photo/file-link?key=...`
  (presigned через `rclone link --expire 7d`).
- **Поиск**: `GET /api/photo/search?q=...` — полнотекст (Postgres FTS, `to_tsvector('russian')`)
  по `title/description/tags/custom/location` в пределах видимого; фильтры `folder_id`, `kind`.
- **Папки и права**: `GET/POST /api/photo/folders*` (admin), `folder_permissions`
  (subject = email | имя группы, role viewer/commenter/editor), наследование видимости вниз
  по дереву папок; точечный override файла (`photos.visibility_override` grant/deny +
  `photo_access`).
- **Глобальные роли**: `GET/POST /api/photo/permissions`, `GET /api/photo/permissions/me`.
  Общего доступа НЕТ (по умолчанию всё закрыто — спека §5).
- **Группы**: `GET/POST /api/photo/groups`, `DELETE /api/photo/groups/{id}` (admin).
- **Схема своих полей**: `GET/POST /api/photo/schema` (admin).
- **Соцслой**: комментарии (`GET/POST /api/photo/photos/{id}/comments`), лайки и избранное
  (`POST .../like`, `POST .../favorite`, `GET /api/photo/favorites`), «недавние»
  (`POST .../view`, `GET /api/photo/recent`).
- **Видимость фото**: admin видит всё; остальные — фото в видимых папках (или предках),
  + grant-override; deny скрывает от всех, кроме admin.
- `GET /api/photo/health`.
- Таблицы: `photo_permissions`, `groups`, `folders`, `folder_permissions`, `photos`,
  `photo_access`, `comments`, `likes`, `favorites`, `recent_views`, `schema`.

## S3 (rclone)

- Как в documents-service: загрузка/скачивание через **rclone CLI** (не aws-sdk-go-v2 —
  тот зависал на Ceph). rclone в Dockerfile (статический бинарь linux-amd64).
- Бакет `sbe-photo` (создать через rclone на сервере). Remote `firstvds_photo`
  генерируется из env (`S3_ENDPOINT`/`S3_ACCESS_KEY`/`S3_SECRET_KEY`) в `rclone.conf`.
- Ключи: `photo/{uuid}/original-{name}`, `photo/{uuid}/thumb-{name}`.
- НЕ использовать `mailers-backup` (ротация 7 дней).

## Миниатюры

- Изображения (jpeg/png/webp) при загрузке уменьшаются до ≤800×800 (CatmullRom,
  `golang.org/x/image/draw`, JPEG q82). Меньше порога — миниатюры нет, клиент берёт оригинал.
- Видео/RAW — миниатюры нет; обложку прикладывает пользователь (`POST /api/photo/thumb`).

## Конфиг (env)

`DATABASE_URL`, `PORT`, `PHOTO_APP_ID` (default `photo`), `PHOTO_APP_NAME`,
`PHOTO_OWNER_EMAIL`, `PHOTO_SERVICE_SECRET`, `AUTH_SERVICE_URL`,
`S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET` (default `sbe-photo`).

## Сборка / проверка

```
docker compose up -d --build photo        # на сервере
docker compose exec photo rclone version   # rclone внутри
docker compose logs photo --tail 20
```

Локально: `go build ./...`, `go vet ./...` (на машине есть Go 1.26).

## История

- **2026-09-02 — найден и исправлен реальный баг: `sync/pull` и `search` падали
  500 `db error` для ЛЮБОГО пользователя с ролью ниже admin.** Обнаружено
  пользователем сразу после запуска «ЦУП Веб» на реальных пользователях (не
  polishchuk@tn.ru) — у admin/superadmin баг не проявлялся, потому что
  `visiblePhotoFilter` для них вообще не доходит до сломанной ветки (ранний
  `return "", nil, nil"`).
  - Причина: `visiblePhotoFilter` (`photos.go`) собирал id видимых папок как
    `ids := make([]any, 0, ...)` и возвращал их как есть — `s.pool.Query(ctx,
    query, args...)` разворачивал `[]any` через `...` в N ОТДЕЛЬНЫХ позиционных
    параметров ($1=id1, $2=id2, ...), хотя SQL ожидал ОДИН параметр-массив для
    `folder_id = ANY($1)`. Postgres: `ERROR: could not determine data type of
    parameter $2 (SQLSTATE 42P18)`.
  - Фикс: `ids` — `[]int64` (не `[]any`), возвращается обёрнутым в
    `[]any{ids}` — ровно один аргумент-массив на позицию `$1`. Заодно чинит и
    `search.go` (тот же `cond`/`args` от `visiblePhotoFilter`, `paramIdx :=
    len(args)` раньше считал 4 вместо 1 и сдвигал нумерацию последующих
    плейсхолдеров).
  - Проверено на реальном пользователе с ролью viewer (не admin): до фикса —
    500 на `pull`/`search`; после — 200, корректная фильтрация (179 из 183
    фото, 4 скрыты в ограниченной папке).
  - `go build`/`go vet` — чисто. Задеплоено (`docker compose up -d --build
    photo`).

- **2026-09-02 — веб-канал (channel=web) для «ЦУП Веб»: блок записи + фикс прав.**
  - **Побочная находка, исправлена по решению пользователя**: `POST
    /api/photo/folders/{id}/permissions` (`handleSetFolderPerm`, `folders.go`) был
    защищён на уровне роута только `viewer` и БЕЗ внутренней проверки на admin/
    владельца папки — в отличие от соседних create/rename/move/delete. Любой
    авторизованный пользователь мог назначить себе `admin` любой папки прямым
    вызовом API. Добавлена та же проверка `canManageFolder`, что и у остальных
    операций над папкой.
  - `jwt.go`: `jwtClaims` += `Channel` (`"plugin"`/`"web"`, из нового claim в JWT,
    см. `auth-service/AGENTS.md`); `requirePerm` кладёт канал в контекст (новый
    `permChannelCtx{}`). Новый декоратор `requireNotWebChannel` — 403 независимо
    от роли, композируется поверх `requirePerm`: `s.requirePerm(role)
    (requireNotWebChannel(s.handleX))`.
  - `main.go`: обёрнуты 14 write-маршрутов (upload file/thumb, folder create/
    rename/move/delete/limited/permissions, permissions get/set, common-access
    get/set, group CRUD, schema set, photo delete, visibility get/set). Осталось
    без изменений: search, список/дерево папок (read), file/thumb/link (view),
    like/favorite/comment (создание и чтение), favorites/recent, `photos/{id}/
    view`, `sync/pull`, `permissions/me` — веб-порталу доступны просмотр/поиск/
    соцслой, ничего больше.
  - `go build`/`go vet` — чисто. Задеплоено (`docker compose up -d --build photo`),
    E2E пройден живьём: web-JWT — search/like 200, folder-create 403 (`forbidden:
    web channel is read-only`); тем же JWT с `channel=plugin` — без изменений
    (регресс). Тестовые устройства/данные удалены после проверки.

- **2026-08-29 — счётчик скачиваний (view=1):**
  `GET /api/photo/file?key=...&view=1` не инкрементит `download_count` — просмотр
  превью/миниатюры не считается скачиванием. Инкремент только при явном скачивании
  (без `view`). Причина: сетка/превью грузили файлы через обычный download, и у файла
  набегало десятки «скачиваний» без явных действий. Накрученные счётчики сброшены
  (`UPDATE photos SET download_count=0`). Задеплоено (`docker compose up -d --build photo`),
  `go build`/`go vet` EXIT=0.

- **2026-08-28 — Этап 2: деплой на VDS + E2E.**
  Залит в `/opt/mailers/photo-service/`, добавлены `photo-db`/`photo` в compose,
  `/api/photo/*` в Caddyfile (в `./caddy/Caddyfile`), `PHOTO_*` в `.env`, seed `photo`
  в auth-service. Бакет `sbe-photo` создан через rclone. Создан app-пользователь
  `photo_app` (NOSUPERUSER + GRANT/ALTER DEFAULT PRIVILEGES + CREATE ON SCHEMA public —
  без CREATE миграции падали «permission denied for schema public»). Caddy пересоздан
  `--force-recreate`. E2E зелёный: health 200, 401 без JWT, папки+права+видимость,
  загрузка PNG в S3, push/pull карточек, FTS-поиск, лайки/комментарии/избранное/недавние,
  счётчик скачиваний, presigned-ссылка, группы, override deny/сброс, schema.
  Тестовые данные очищены (БД и бакет).
- **2026-08-28 — фиксы при первом деплое:** (1) `handleListFolders` сканировал
  timestamptz в `string` → падал «db error»; исправлено на `time.Time` + RFC3339.
  (2) миниатюры: `image.Decode` не знал форматы — вернул пустые импорты
  `_ "image/png"`, `_ "image/gif"` (декодеры регистрируются side-effect).
- **2026-08-28 — создание (sbe-photobank, Этап 1):**
  Сервис создан зеркалом documents-service (jwt.go/register.go/s3.go скопированы с
  адаптацией под `photo`/`photo_*`). Таблицы по спеке §4. Миниатюры — Go-ресайз
  (`golang.org/x/image`, BSD-3-Clause; уже использовалась в lab-service). Локальная
  компиляция: `go build ./...` EXIT=0, `go vet ./...` EXIT=0.
