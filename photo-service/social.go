package main

import (
	"context"
	"log"
	"net/http"
	"strings"
	"time"
)

// Comment — комментарий к файлу.
type Comment struct {
	ID          int64  `json:"id"`
	PhotoID     int64  `json:"photo_id"`
	AuthorEmail string `json:"author_email"`
	Text        string `json:"text"`
	CreatedAt   string `json:"created_at"`
}

// handleListComments возвращает комментарии файла (viewer+, в рамках видимого).
func (s *Server) handleListComments(w http.ResponseWriter, r *http.Request) {
	id := parseIntPath(r, "id")
	if id <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid id"})
		return
	}
	if !s.photoVisibleForReq(r, id) {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "not found"})
		return
	}
	rows, err := s.pool.Query(r.Context(), `
SELECT id, photo_id, author_email, text, created_at FROM comments
WHERE photo_id = $1 ORDER BY created_at`, id)
	if err != nil {
		log.Printf("list comments: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	defer rows.Close()

	comments := make([]Comment, 0, 16)
	for rows.Next() {
		var c Comment
		var createdAt time.Time
		if err := rows.Scan(&c.ID, &c.PhotoID, &c.AuthorEmail, &c.Text, &createdAt); err != nil {
			continue
		}
		c.CreatedAt = createdAt.Format(time.RFC3339)
		comments = append(comments, c)
	}
	writeJSON(w, http.StatusOK, map[string]any{"comments": comments})
}

// handleAddComment добавляет комментарий (commenter+).
func (s *Server) handleAddComment(w http.ResponseWriter, r *http.Request) {
	id := parseIntPath(r, "id")
	if id <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid id"})
		return
	}
	email, _ := r.Context().Value(permEmailCtx{}).(string)
	globalRole, err := s.effectiveRole(r.Context(), appIDFromEnv(), email)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	if !s.canCommentPhoto(r.Context(), id, email, globalRole) {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": "forbidden: commenter+ required"})
		return
	}
	var req struct {
		Text string `json:"text"`
	}
	if err := decodeJSON(w, r, &req, 1<<20); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json"})
		return
	}
	req.Text = strings.TrimSpace(req.Text)
	if req.Text == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "text is required"})
		return
	}
	var cid int64
	err = s.pool.QueryRow(r.Context(), `
INSERT INTO comments (photo_id, author_email, text) VALUES ($1, $2, $3) RETURNING id`,
		id, email, req.Text).Scan(&cid)
	if err != nil {
		log.Printf("add comment: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": cid})
}

// handleSetLike ставит/снимает лайк (commenter+).
func (s *Server) handleSetLike(w http.ResponseWriter, r *http.Request) {
	id := parseIntPath(r, "id")
	if id <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid id"})
		return
	}
	email, _ := r.Context().Value(permEmailCtx{}).(string)
	globalRole, err := s.effectiveRole(r.Context(), appIDFromEnv(), email)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	if !s.canCommentPhoto(r.Context(), id, email, globalRole) {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": "forbidden"})
		return
	}
	var req struct {
		Liked bool `json:"liked"`
	}
	if err := decodeJSON(w, r, &req, 1<<20); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json"})
		return
	}
	if req.Liked {
		_, err = s.pool.Exec(r.Context(), `
INSERT INTO likes (photo_id, user_email) VALUES ($1, $2)
ON CONFLICT (photo_id, user_email) DO NOTHING`, id, email)
	} else {
		_, err = s.pool.Exec(r.Context(), `
DELETE FROM likes WHERE photo_id = $1 AND user_email = $2`, id, email)
	}
	if err != nil {
		log.Printf("set like: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	s.syncLikesCount(r.Context(), id)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// syncLikesCount пересчитывает счётчик лайков карточки.
func (s *Server) syncLikesCount(ctx context.Context, photoID int64) {
	_, _ = s.pool.Exec(ctx, `
UPDATE photos SET likes_count = (SELECT COUNT(*) FROM likes WHERE photo_id = $1) WHERE id = $1`,
		photoID)
}

// handleSetFavorite добавляет/убирает из избранного (commenter+).
func (s *Server) handleSetFavorite(w http.ResponseWriter, r *http.Request) {
	id := parseIntPath(r, "id")
	if id <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid id"})
		return
	}
	email, _ := r.Context().Value(permEmailCtx{}).(string)
	globalRole, err := s.effectiveRole(r.Context(), appIDFromEnv(), email)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	if !s.canCommentPhoto(r.Context(), id, email, globalRole) {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": "forbidden"})
		return
	}
	var req struct {
		Favorited bool `json:"favorited"`
	}
	if err := decodeJSON(w, r, &req, 1<<20); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json"})
		return
	}
	if req.Favorited {
		_, err = s.pool.Exec(r.Context(), `
INSERT INTO favorites (photo_id, user_email) VALUES ($1, $2)
ON CONFLICT (photo_id, user_email) DO NOTHING`, id, email)
	} else {
		_, err = s.pool.Exec(r.Context(), `
DELETE FROM favorites WHERE photo_id = $1 AND user_email = $2`, id, email)
	}
	if err != nil {
		log.Printf("set favorite: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleFavorites возвращает избранные фото пользователя (viewer+).
func (s *Server) handleFavorites(w http.ResponseWriter, r *http.Request) {
	email, _ := r.Context().Value(permEmailCtx{}).(string)
	rows, err := s.pool.Query(r.Context(), `
SELECT `+photoColumns+` FROM photos p
JOIN favorites f ON f.photo_id = p.id
WHERE f.user_email = $1
ORDER BY p.updated_at DESC LIMIT 500`, email)
	if err != nil {
		log.Printf("favorites: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	defer rows.Close()
	photos := make([]*Photo, 0, 32)
	for rows.Next() {
		p, err := scanPhoto(rows)
		if err != nil {
			continue
		}
		photos = append(photos, p)
	}
	writeJSON(w, http.StatusOK, map[string]any{"photos": photos})
}

// handleRecent возвращает недавно просмотренные фото пользователя (viewer+).
func (s *Server) handleRecent(w http.ResponseWriter, r *http.Request) {
	email, _ := r.Context().Value(permEmailCtx{}).(string)
	rows, err := s.pool.Query(r.Context(), `
SELECT `+photoColumns+` FROM photos p
JOIN recent_views rv ON rv.photo_id = p.id
WHERE rv.user_email = $1
ORDER BY rv.viewed_at DESC LIMIT 50`, email)
	if err != nil {
		log.Printf("recent: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	defer rows.Close()
	photos := make([]*Photo, 0, 32)
	for rows.Next() {
		p, err := scanPhoto(rows)
		if err != nil {
			continue
		}
		photos = append(photos, p)
	}
	writeJSON(w, http.StatusOK, map[string]any{"photos": photos})
}

// handleViewPhoto фиксирует просмотр (для «недавних») (viewer+).
func (s *Server) handleViewPhoto(w http.ResponseWriter, r *http.Request) {
	id := parseIntPath(r, "id")
	if id <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid id"})
		return
	}
	email, _ := r.Context().Value(permEmailCtx{}).(string)
	if !s.photoVisibleForReq(r, id) {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "not found"})
		return
	}
	_, _ = s.pool.Exec(r.Context(), `
INSERT INTO recent_views (user_email, photo_id, viewed_at) VALUES ($1, $2, now())
ON CONFLICT (user_email, photo_id) DO UPDATE SET viewed_at = now()`, email, id)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// canCommentPhoto — commenter+ (глобально или на папке фото).
func (s *Server) canCommentPhoto(ctx context.Context, photoID int64, email, globalRole string) bool {
	if roleRank(globalRole) >= roleRank("commenter") {
		return true
	}
	fid, err := s.photoFolderID(ctx, photoID)
	if err != nil {
		return false
	}
	visible, err := s.visibleFolderIDs(ctx, email)
	if err != nil {
		return false
	}
	return roleRank(roleName(visible[fid])) >= roleRank("commenter")
}

// photoVisibleForReq — проверка видимости фото для текущего запроса.
func (s *Server) photoVisibleForReq(r *http.Request, photoID int64) bool {
	email, _ := r.Context().Value(permEmailCtx{}).(string)
	globalRole, err := s.effectiveRole(r.Context(), appIDFromEnv(), email)
	if err != nil {
		return false
	}
	visible, err := s.photoVisible(r.Context(), photoID, email, globalRole)
	return err == nil && visible
}
