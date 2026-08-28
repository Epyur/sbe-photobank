package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// Photo — карточка файла в фотобанке.
type Photo struct {
	ID                int64          `json:"id"`
	FolderID          int64          `json:"folder_id"`
	Title             string         `json:"title"`
	Description       string         `json:"description"`
	Tags              []string       `json:"tags"`
	Custom            map[string]any `json:"custom"`
	FileKey           string         `json:"file_key"`
	FileName          string         `json:"file_name"`
	FileSize          int64          `json:"file_size"`
	ContentHash       string         `json:"content_hash"`
	MimeType          string         `json:"mime_type"`
	Kind              string         `json:"kind"` // image|video|raw
	Width             int            `json:"width"`
	Height            int            `json:"height"`
	Duration          int            `json:"duration"`
	ThumbKey          string         `json:"thumb_key"`
	ThumbAuthor       string         `json:"thumb_author"` // user|auto
	AuthorEmail       string         `json:"author_email"`
	ShotAt            int64          `json:"shot_at"`
	Location          string         `json:"location"`
	VisibilityOverride string         `json:"visibility_override"` // ""|grant|deny
	DownloadCount     int            `json:"download_count"`
	LikesCount        int            `json:"likes_count"`
	CreatedAt         string         `json:"created_at"`
	UpdatedAt         string         `json:"updated_at"`
}

type PushRequest struct {
	Photos []Photo `json:"photos"`
}

func scanPhoto(row pgx.Row) (*Photo, error) {
	var p Photo
	var tagsRaw, customRaw []byte
	var createdAt, updatedAt time.Time
	err := row.Scan(&p.ID, &p.FolderID, &p.Title, &p.Description, &tagsRaw, &customRaw,
		&p.FileKey, &p.FileName, &p.FileSize, &p.ContentHash, &p.MimeType, &p.Kind, &p.Width, &p.Height,
		&p.Duration, &p.ThumbKey, &p.ThumbAuthor, &p.AuthorEmail, &p.ShotAt, &p.Location,
		&p.VisibilityOverride, &p.DownloadCount, &p.LikesCount, &createdAt, &updatedAt)
	if err != nil {
		return nil, err
	}
	p.CreatedAt = createdAt.Format(time.RFC3339)
	p.UpdatedAt = updatedAt.Format(time.RFC3339)
	if len(tagsRaw) > 0 {
		_ = json.Unmarshal(tagsRaw, &p.Tags)
	}
	if p.Tags == nil {
		p.Tags = []string{}
	}
	if len(customRaw) > 0 {
		_ = json.Unmarshal(customRaw, &p.Custom)
	}
	if p.Custom == nil {
		p.Custom = map[string]any{}
	}
	return &p, nil
}

const photoColumns = `
id, folder_id, title, description, tags, custom,
file_key, file_name, file_size, content_hash, mime_type, kind, width, height, duration,
thumb_key, thumb_author, author_email, shot_at, location, visibility_override,
download_count, likes_count, created_at, updated_at`

// visiblePhotoFilter возвращает SQL-условие видимости фото для пользователя.
// admin видит всё; остальные — фото в видимых папках ИЛИ grant-override, кроме deny.
func (s *Server) visiblePhotoFilter(ctx context.Context, email string) (string, []any, error) {
	role, err := s.effectiveRole(ctx, appIDFromEnv(), email)
	if err != nil {
		return "", nil, err
	}
	if role == "admin" {
		return "", nil, nil
	}
	visible, err := s.visibleFolderIDs(ctx, email)
	if err != nil {
		return "", nil, err
	}
	if len(visible) == 0 {
		return `(visibility_override = 'grant')`, nil, nil
	}
	ids := make([]any, 0, len(visible))
	for id := range visible {
		ids = append(ids, id)
	}
	return `((folder_id = ANY($1)) OR (visibility_override = 'grant')) AND (visibility_override <> 'deny' OR visibility_override IS NULL)`, ids, nil
}

// handlePush приём/обновление карточек (editor+).
func (s *Server) handlePush(w http.ResponseWriter, r *http.Request) {
	var req PushRequest
	if err := decodeJSON(w, r, &req, 20<<20); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json"})
		return
	}
	if len(req.Photos) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{"inserted": 0, "updated": 0})
		return
	}
	email, _ := r.Context().Value(permEmailCtx{}).(string)
	globalRole, err := s.effectiveRole(r.Context(), appIDFromEnv(), email)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}

	now := time.Now().UTC()
	inserted := 0
	updated := 0
	for _, p := range req.Photos {
		if !s.canActOnFolder(r.Context(), p.FolderID, email, "editor", globalRole) {
			log.Printf("push photo %d: insufficient folder role", p.ID)
			continue
		}
		tagsJSON, err := json.Marshal(p.Tags)
		if err != nil || p.Tags == nil {
			tagsJSON = []byte("[]")
		}
		customJSON, err := json.Marshal(p.Custom)
		if err != nil || p.Custom == nil {
			customJSON = []byte("{}")
		}
		updatedAt := parseTime(p.UpdatedAt, now)
		if p.AuthorEmail == "" {
			p.AuthorEmail = email
		}

		if p.ID > 0 {
			tag, err := s.pool.Exec(r.Context(), `
UPDATE photos SET
	folder_id = $2, title = $3, description = $4, tags = $5, custom = $6,
	file_key = $7, file_name = $8, file_size = $9, content_hash = $10, mime_type = $11, kind = $12,
	width = $13, height = $14, duration = $15, thumb_key = $16, thumb_author = $17,
	shot_at = $18, location = $19, visibility_override = $20, updated_at = $21
WHERE id = $1 AND updated_at < $21`, p.ID, p.FolderID, p.Title, p.Description, tagsJSON,
				customJSON, p.FileKey, p.FileName, p.FileSize, p.ContentHash, p.MimeType, p.Kind,
				p.Width, p.Height, p.Duration, p.ThumbKey, p.ThumbAuthor, p.ShotAt,
				p.Location, p.VisibilityOverride, updatedAt)
			if err != nil {
				log.Printf("push update photo: %v", err)
				continue
			}
			if tag.RowsAffected() > 0 {
				updated++
				continue
			}
			insTag, err := s.pool.Exec(r.Context(), `
INSERT INTO photos (id, folder_id, title, description, tags, custom,
	file_key, file_name, file_size, content_hash, mime_type, kind, width, height, duration,
	thumb_key, thumb_author, author_email, shot_at, location, visibility_override,
	created_at, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $22)
ON CONFLICT (id) DO NOTHING`, p.ID, p.FolderID, p.Title, p.Description, tagsJSON,
				customJSON, p.FileKey, p.FileName, p.FileSize, p.ContentHash, p.MimeType, p.Kind,
				p.Width, p.Height, p.Duration, p.ThumbKey, p.ThumbAuthor, p.AuthorEmail,
				p.ShotAt, p.Location, p.VisibilityOverride, updatedAt)
			if err != nil {
				log.Printf("push insert photo by id: %v", err)
				continue
			}
			if insTag.RowsAffected() > 0 {
				inserted++
				s.bumpPhotoSequence(r.Context())
			}
			continue
		}

		var newID int64
		err = s.pool.QueryRow(r.Context(), `
INSERT INTO photos (folder_id, title, description, tags, custom,
	file_key, file_name, file_size, content_hash, mime_type, kind, width, height, duration,
	thumb_key, thumb_author, author_email, shot_at, location, visibility_override,
	created_at, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $21)
RETURNING id`, p.FolderID, p.Title, p.Description, tagsJSON, customJSON,
			p.FileKey, p.FileName, p.FileSize, p.ContentHash, p.MimeType, p.Kind, p.Width, p.Height,
			p.Duration, p.ThumbKey, p.ThumbAuthor, p.AuthorEmail, p.ShotAt, p.Location,
			p.VisibilityOverride, updatedAt).Scan(&newID)
		if err != nil {
			log.Printf("push insert photo: %v", err)
			continue
		}
		inserted++
	}
	writeJSON(w, http.StatusOK, map[string]any{"inserted": inserted, "updated": updated})
}

// handlePull выгрузка видимых карточек (viewer+).
func (s *Server) handlePull(w http.ResponseWriter, r *http.Request) {
	email, _ := r.Context().Value(permEmailCtx{}).(string)
	cond, args, err := s.visiblePhotoFilter(r.Context(), email)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}

	query := "SELECT " + photoColumns + " FROM photos"
	if cond != "" {
		query += " WHERE " + cond
	}
	query += " ORDER BY id"

	rows, err := s.pool.Query(r.Context(), query, args...)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	defer rows.Close()

	photos := make([]*Photo, 0, 128)
	for rows.Next() {
		p, err := scanPhoto(rows)
		if err != nil {
			log.Printf("pull scan photo: %v", err)
			continue
		}
		photos = append(photos, p)
	}
	if err := rows.Err(); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"photos": photos})
}

// handleGetPhoto возвращает одну карточку (viewer+, видимость проверяется).
func (s *Server) handleGetPhoto(w http.ResponseWriter, r *http.Request) {
	id := parseIntPath(r, "id")
	if id <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid id"})
		return
	}
	email, _ := r.Context().Value(permEmailCtx{}).(string)
	role, err := s.effectiveRole(r.Context(), appIDFromEnv(), email)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	visible, err := s.photoVisible(r.Context(), id, email, role)
	if err != nil || !visible {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "not found"})
		return
	}
	p, err := scanPhoto(s.pool.QueryRow(r.Context(),
		"SELECT "+photoColumns+" FROM photos WHERE id = $1", id))
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "not found"})
		return
	}
	writeJSON(w, http.StatusOK, p)
}

// photoVisible — видимость одного фото для пользователя.
func (s *Server) photoVisible(ctx context.Context, photoID int64, email, globalRole string) (bool, error) {
	if globalRole == "admin" {
		return true, nil
	}
	var folderID int64
	var override string
	err := s.pool.QueryRow(ctx,
		`SELECT folder_id, COALESCE(visibility_override, '') FROM photos WHERE id = $1`,
		photoID).Scan(&folderID, &override)
	if err != nil {
		if err == pgx.ErrNoRows {
			return false, nil
		}
		return false, err
	}
	if override == "deny" {
		return false, nil
	}
	visible, err := s.visibleFolderIDs(ctx, email)
	if err != nil {
		return false, err
	}
	if visible[folderID] > 0 {
		return true, nil
	}
	if override == "grant" {
		subjects := s.userSubjects(ctx, email)
		var one int
		err := s.pool.QueryRow(ctx,
			`SELECT 1 FROM photo_access WHERE photo_id = $1 AND subject = ANY($2)`,
			photoID, subjects).Scan(&one)
		return err == nil, nil
	}
	return false, nil
}

// handleDeletePhoto удаляет карточку и файл из S3 (admin или автор).
func (s *Server) handleDeletePhoto(w http.ResponseWriter, r *http.Request) {
	id := parseIntPath(r, "id")
	if id <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid id"})
		return
	}
	email, _ := r.Context().Value(permEmailCtx{}).(string)
	role, err := s.effectiveRole(r.Context(), appIDFromEnv(), email)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}

	var author string
	err = s.pool.QueryRow(r.Context(), `SELECT author_email FROM photos WHERE id = $1`, id).Scan(&author)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "not found"})
		return
	}
	if role != "admin" && author != email {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": "forbidden: only admin or author"})
		return
	}
	if _, err := s.pool.Exec(r.Context(), `DELETE FROM photos WHERE id = $1`, id); err != nil {
		log.Printf("delete photo: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	_, _ = s.pool.Exec(r.Context(), `DELETE FROM photo_access WHERE photo_id = $1`, id)
	_, _ = s.pool.Exec(r.Context(), `DELETE FROM comments WHERE photo_id = $1`, id)
	_, _ = s.pool.Exec(r.Context(), `DELETE FROM likes WHERE photo_id = $1`, id)
	_, _ = s.pool.Exec(r.Context(), `DELETE FROM favorites WHERE photo_id = $1`, id)
	_, _ = s.pool.Exec(r.Context(), `DELETE FROM recent_views WHERE photo_id = $1`, id)
	writeJSON(w, http.StatusOK, map[string]any{"deleted": true})
}

func (s *Server) bumpPhotoSequence(ctx context.Context) {
	_, _ = s.pool.Exec(ctx, `
SELECT setval(pg_get_serial_sequence('photos', 'id'),
	GREATEST((SELECT COALESCE(MAX(id), 0) FROM photos), (SELECT last_value FROM photos_id_seq)), true)`)
}

// kindFromMime определяет kind по MIME/расширению: image|video|raw.
func kindFromMime(mimeType string) string {
	m := strings.ToLower(mimeType)
	switch {
	case strings.HasPrefix(m, "image/"):
		return "image"
	case strings.HasPrefix(m, "video/"):
		return "video"
	}
	// сырые форматы камер не имеют стандартного MIME у плагина — определяем по расширению
	// в плагине; на сервере оставляем как есть.
	return "raw"
}
