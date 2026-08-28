package main

import (
	"log"
	"net/http"
	"strings"
)

// handleSearch — свободный поиск: полнотекст (FTS) по видимым фото (viewer+).
// Параметры: q — запрос; folder_id (опц.); kind (опц.). Результат сортируется по релевантности.
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
		where += "(to_tsvector('russian', coalesce(title,'') || ' ' || coalesce(description,'') || ' ' ||" +
			" coalesce(tags::text,'') || ' ' || coalesce(custom::text,'') || ' ' || coalesce(location,''))" +
			" @@ plainto_tsquery('russian', $" + itoa(idx) + "))"
		args = append(args, q)
		paramIdx++
	}
	if folderID > 0 {
		idx := paramIdx + 1
		if where != "" {
			where += " AND "
		}
		where += "folder_id = $" + itoa(idx)
		args = append(args, folderID)
		paramIdx++
	}
	if kind != "" {
		idx := paramIdx + 1
		if where != "" {
			where += " AND "
		}
		where += "kind = $" + itoa(idx)
		args = append(args, kind)
		paramIdx++
	}

	query := "SELECT " + photoColumns + " FROM photos"
	if where != "" {
		query += " WHERE " + where
	}
	query += " ORDER BY updated_at DESC LIMIT 500"

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
