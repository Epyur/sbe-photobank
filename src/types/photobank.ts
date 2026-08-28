/** Типы плагина «Фотобанк». Модель совместима с photo-service (photo-service/). */

/** Папка/альбом (дерево). */
export interface PhotoFolder {
  id: number;
  name: string;
  parent_id: number;
  owner_email: string;
  created_at: string;
  updated_at: string;
  /** Права папки (admin видит при просмотре прав; в pull обычно пусто). */
  permissions?: PhotoFolderPerm[];
}

/** Доступ к папке: subject = email или имя группы, role = viewer|commenter|editor. */
export interface PhotoFolderPerm {
  subject: string;
  role: string;
}

/** Группа доступа. */
export interface PhotoGroup {
  id: number;
  name: string;
  members: string[];
}

/** Поле схемы своих полей (админ). */
export interface SchemaField {
  key: string;
  type: 'text' | 'list' | 'date' | 'number' | 'bool';
  label: string;
  required: boolean;
  options?: string[];
}

/** Карточка файла. */
export interface PhotoItem {
  id: number;
  folder_id: number;
  title: string;
  description: string;
  tags: string[];
  /** Значения своих полей: {key: value}. */
  custom: Record<string, unknown>;
  file_key: string;
  file_name: string;
  file_size: number;
  content_hash: string;
  mime_type: string;
  /** image|video|raw */
  kind: string;
  width: number;
  height: number;
  duration: number;
  thumb_key: string;
  thumb_author: '' | 'user' | 'auto';
  author_email: string;
  shot_at: number;
  location: string;
  visibility_override: '' | 'grant' | 'deny';
  download_count: number;
  likes_count: number;
  created_at: string;
  updated_at: string;
  /** Только локально: local — не синхронизировано с сервером. */
  sync_status: 'local' | 'synced';
}

/** Комментарий к файлу. */
export interface PhotoComment {
  id: number;
  photo_id: number;
  author_email: string;
  text: string;
  created_at: string;
}

/** Локальная БД плагина. */
export interface PhotobankDbData {
  folders: PhotoFolder[];
  photos: PhotoItem[];
  groups: PhotoGroup[];
  schema: SchemaField[];
}

/** Ответ сервера на pull карточек. */
export interface PullResponse {
  photos: PhotoItem[];
}

/** Ответ сервера на push карточек. */
export interface PushResponse {
  inserted: number;
  updated: number;
}

/** Ответ сервера на загрузку файла. */
export interface UploadFileResponse {
  file_key: string;
  file_name: string;
  file_size: number;
  file_url: string;
  thumb_key: string;
  thumb_author: '' | 'user' | 'auto';
  width: number;
  height: number;
}

/** Роль текущего пользователя. */
export interface MyPermission {
  email: string;
  role: string;
  hasAccess: boolean;
}

/** Контекст для ИИ-описания. */
export interface AiDescribeContext {
  /** Что на кадре (свободный текст пользователя). */
  content: string;
  /** Событие/съёмка. */
  event?: string;
  /** Локация. */
  location?: string;
  /** Персоны. */
  people?: string;
  /** Цель использования. */
  purpose?: string;
}

/** Результат ИИ-описания (промпт возвращает JSON). */
export interface AiDescribeResult {
  /** Отображаемое в стоке имя файла — короткое, ёмкое (≤60 симв.). */
  title: string;
  description: string;
  tags: string[];
  category?: string;
  location?: string;
  shot_at?: number;
  custom: Record<string, unknown>;
}
