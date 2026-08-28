package main

import (
	"log"
	"net/http"
	"strings"
)

// handleSetVisibilityOverride — точечный override видимости файла (admin).
// Тело: {"id": int, "override": ""|"grant"|"deny", "subjects": ["email@..","group"]}.
// - "" — сбросить override (видимость снова определяется папкой).
// - "grant" — показать конкретным субъектам, даже если папка не видна.
// - "deny" — скрыть от всех, кроме admin.
func (s *Server) handleSetVisibilityOverride(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID       int64    `json:"id"`
		Override string   `json:"override"`
		Subjects []string `json:"subjects"`
	}
	if err := decodeJSON(w, r, &req, 1<<20); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json"})
		return
	}
	req.Override = strings.TrimSpace(req.Override)
	if req.Override != "" && req.Override != "grant" && req.Override != "deny" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "override must be grant, deny or empty"})
		return
	}
	if req.ID <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid id"})
		return
	}
	if !s.photoExists(r.Context(), req.ID) {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "not found"})
		return
	}

	if _, err := s.pool.Exec(r.Context(),
		`UPDATE photos SET visibility_override = $2 WHERE id = $1`, req.ID, req.Override); err != nil {
		log.Printf("set override: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}

	if _, err := s.pool.Exec(r.Context(),
		`DELETE FROM photo_access WHERE photo_id = $1`, req.ID); err != nil {
		log.Printf("clear photo_access: %v", err)
	}
	if req.Override == "grant" && len(req.Subjects) > 0 {
		for _, subj := range req.Subjects {
			subj = strings.ToLower(strings.TrimSpace(subj))
			if subj == "" {
				continue
			}
			if _, err := s.pool.Exec(r.Context(), `
INSERT INTO photo_access (photo_id, subject) VALUES ($1, $2)
ON CONFLICT (photo_id, subject) DO NOTHING`, req.ID, subj); err != nil {
				log.Printf("insert photo_access: %v", err)
			}
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleGetVisibilityOverride возвращает текущий override файла (admin).
func (s *Server) handleGetVisibilityOverride(w http.ResponseWriter, r *http.Request) {
	id := parseIntPath(r, "id")
	if id <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid id"})
		return
	}
	var override string
	err := s.pool.QueryRow(r.Context(),
		`SELECT COALESCE(visibility_override, '') FROM photos WHERE id = $1`, id).Scan(&override)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "not found"})
		return
	}
	rows, err := s.pool.Query(r.Context(),
		`SELECT subject FROM photo_access WHERE photo_id = $1`, id)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	defer rows.Close()
	subjects := make([]string, 0, 4)
	for rows.Next() {
		var subj string
		if err := rows.Scan(&subj); err != nil {
			continue
		}
		subjects = append(subjects, subj)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"override": override,
		"subjects": subjects,
	})
}
