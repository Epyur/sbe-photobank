package main

import (
	"log"
	"net/http"
	"strings"
)

// handleSearch — свободный поиск: полнотекст (FTS) по видимым фото (viewer+).
// Ищет по title/description/tags/custom/location, а также по названию папки и всех
// её предков (путь «Красный → Фаль»). Параметры: q; folder_id (опц.); kind (опц.).
func (s *Server) handleSearch(w http.ResponseWriter, r *http.Request) {
	email, _ := r.Context().Value(permEmailCtx{}).(string)
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	folderID := parseQueryInt64(r, "folder_id")
	kind := r.URL.Query().Get("kind")

	cond, args, err := s.visiblePhotoFilter(r.Context(), email)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	// visiblePhotoFilter возвращает условие без префикса таблицы — в поиске фото алиасировано p.
	if cond != "" {
		cond = strings.ReplaceAll(cond, "folder_id", "p.folder_id")
		cond = strings.ReplaceAll(cond, "visibility_override", "p.visibility_override")
	}

	where := ""
	paramIdx := len(args)
	if cond != "" {
		where += cond
	}
	if q != "" {
		idx := paramIdx + 1
		if where != "" {
			where += " AND "
		}
		// Многословный запрос: ищем по КАЖДОМУ слову отдельно и объединяем OR
		// (plainto_tsquery по всей фразе строит AND — «Красный фальц» требовал оба
		// слова в одной записи и не находил ничего, если «красный» есть только в
		// названии папки). Ранжируем ts_rank — чем больше слов совпало, тем выше.
		words := strings.Fields(q)
		if len(words) == 1 {
			where += `(to_tsvector('russian', coalesce(p.title,'') || ' ' || coalesce(p.description,'') || ' ' ||
				coalesce(p.tags::text,'') || ' ' || coalesce(p.custom::text,'') || ' ' || coalesce(p.location,'') ||
				' ' || coalesce(fp.path,'')) @@ plainto_tsquery('russian', $` + itoa(idx) + `))`
			args = append(args, q)
		} else {
			tsqueryParts := make([]string, 0, len(words))
			for i, w := range words {
				pi := idx + i
				tsqueryParts = append(tsqueryParts, `plainto_tsquery('russian', $`+itoa(pi)+`)`)
				args = append(args, w)
			}
			where += `(to_tsvector('russian', coalesce(p.title,'') || ' ' || coalesce(p.description,'') || ' ' ||
				coalesce(p.tags::text,'') || ' ' || coalesce(p.custom::text,'') || ' ' || coalesce(p.location,'') ||
				' ' || coalesce(fp.path,'')) @@ (` + strings.Join(tsqueryParts, " || ") + `))`
			paramIdx += len(words)
		}
		paramIdx++
	}
	if folderID > 0 {
		idx := paramIdx + 1
		if where != "" {
			where += " AND "
		}
		where += "p.folder_id = $" + itoa(idx)
		args = append(args, folderID)
		paramIdx++
	}
	if kind != "" {
		idx := paramIdx + 1
		if where != "" {
			where += " AND "
		}
		where += "p.kind = $" + itoa(idx)
		args = append(args, kind)
		paramIdx++
	}

	query := `
WITH RECURSIVE fp AS (
	SELECT id, name, name::text AS path FROM folders WHERE parent_id = 0
	UNION ALL
	SELECT f.id, f.name, (fp.path || ' ' || f.name)::text
	FROM folders f JOIN fp ON f.parent_id = fp.id
)
SELECT p.id, p.folder_id, p.title, p.description, p.tags, p.custom,
	p.file_key, p.file_name, p.file_size, p.content_hash, p.mime_type, p.kind, p.width, p.height, p.duration,
	p.thumb_key, p.thumb_author, p.author_email, p.shot_at, p.location, p.visibility_override,
	p.download_count, p.likes_count, p.created_at, p.updated_at
FROM photos p LEFT JOIN fp ON fp.id = p.folder_id`
	if where != "" {
		query += " WHERE " + where
	}
	query += " ORDER BY p.updated_at DESC LIMIT 500"

	rows, err := s.pool.Query(r.Context(), query, args...)
	if err != nil {
		log.Printf("search: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	defer rows.Close()

	photos := make([]*Photo, 0, 64)
	for rows.Next() {
		p, err := scanPhoto(rows)
		if err != nil {
			log.Printf("search scan: %v", err)
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

func parseQueryInt64(r *http.Request, name string) int64 {
	v := int64(0)
	s := r.URL.Query().Get(name)
	if s == "" {
		return 0
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return 0
		}
		v = v*10 + int64(c-'0')
	}
	return v
}

func itoa(v int) string {
	if v == 0 {
		return "0"
	}
	neg := v < 0
	if neg {
		v = -v
	}
	var b [20]byte
	i := len(b)
	for v > 0 {
		i--
		b[i] = byte('0' + v%10)
		v /= 10
	}
	if neg {
		i--
		b[i] = '-'
	}
	return string(b[i:])
}
