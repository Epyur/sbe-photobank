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
