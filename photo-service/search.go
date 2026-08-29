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

	// Строим условия поиска по словам запроса.
	// - AND (все слова обязательны) — точные результаты;
	// - OR (хотя бы одно слово) — fallback, если по AND мало (напр. «красный» только в папке).
	// Сортировка по ts_rank — чем больше/точнее совпало, тем выше.
	var andClause, orClause string
	if q != "" {
		words := strings.Fields(q)
		if len(words) == 1 {
			idx := paramIdx + 1
			andClause = `(to_tsvector('russian', coalesce(p.title,'') || ' ' || coalesce(p.description,'') || ' ' ||
				coalesce(p.tags::text,'') || ' ' || coalesce(p.custom::text,'') || ' ' || coalesce(p.location,'') ||
				' ' || coalesce(fp.path,'')) @@ plainto_tsquery('russian', $` + itoa(idx) + `))`
			args = append(args, q)
			paramIdx++
		} else {
			andParts := make([]string, 0, len(words))
			orParts := make([]string, 0, len(words))
			wordHits := make([]string, 0, len(words))
			idxStart := paramIdx + 1
			// Полное tsvector-выражение (переиспользуется в @@ и в wordHits).
			tsvExpr := `to_tsvector('russian', coalesce(p.title,'') || ' ' || coalesce(p.description,'') || ' ' ||
				coalesce(p.tags::text,'') || ' ' || coalesce(p.custom::text,'') || ' ' || coalesce(p.location,'') ||
				' ' || coalesce(fp.path,''))`
			for i, w := range words {
				pi := idxStart + i
				andParts = append(andParts, `plainto_tsquery('russian', $`+itoa(pi)+`)`)
				orParts = append(orParts, `plainto_tsquery('russian', $`+itoa(pi)+`)`)
				wordHits = append(wordHits, `((`+tsvExpr+`) @@ plainto_tsquery('russian', $`+itoa(pi)+`))::int`)
				args = append(args, w)
			}
			andClause = `(` + tsvExpr + ` @@ (` + strings.Join(andParts, " && ") + `))`
			orClause = `((` + tsvExpr + `) @@ (` + strings.Join(orParts, " || ") + `)) AND (` +
				strings.Join(wordHits, " + ") + ` >= 2)`
			paramIdx += len(words)
		}
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

	runQuery := func(searchClause string) ([]*Photo, error) {
		innerWhere := where
		if searchClause != "" {
			if innerWhere != "" {
				innerWhere += " AND "
			}
			innerWhere += searchClause
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
		if innerWhere != "" {
			query += " WHERE " + innerWhere
		}
		if q != "" {
			query += ` ORDER BY ts_rank(to_tsvector('russian', coalesce(p.title,'') || ' ' || coalesce(p.description,'') || ' ' ||
				coalesce(p.tags::text,'') || ' ' || coalesce(p.custom::text,'') || ' ' || coalesce(p.location,'') ||
				' ' || coalesce(fp.path,'')), plainto_tsquery('russian', '` + strings.Join(strings.Fields(q), " ") + `')) DESC`
		} else {
			query += " ORDER BY p.updated_at DESC"
		}
		query += " LIMIT 500"

		rows, err := s.pool.Query(r.Context(), query, args...)
		if err != nil {
			return nil, err
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
		return photos, rows.Err()
	}

	photos := make([]*Photo, 0, 64)
	if andClause != "" {
		p, err := runQuery(andClause)
		if err != nil {
			log.Printf("search (and): %v", err)
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
			return
		}
		photos = p
	}
	// Многословный запрос: если по AND мало (напр. слова только в папках) — OR-fallback.
	if orClause != "" && len(photos) < 5 {
		extra, err := runQuery(orClause)
		if err != nil {
			log.Printf("search (or): %v", err)
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
			return
		}
		seen := make(map[int64]bool, len(photos))
		for _, p := range photos {
			seen[p.ID] = true
		}
		for _, p := range extra {
			if !seen[p.ID] {
				seen[p.ID] = true
				photos = append(photos, p)
			}
		}
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
