package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strings"
)

// SchemaField — поле пользовательской схемы метаданных (админ).
type SchemaField struct {
	Key        string `json:"key"`
	Type       string `json:"type"` // text|list|date|number|bool
	Label      string `json:"label"`
	Required   bool   `json:"required"`
	Options    []string `json:"options,omitempty"` // для list
}

// Schema — схема своих полей фотобанка.
type Schema struct {
	Fields []SchemaField `json:"fields"`
}

// handleGetSchema возвращает схему своих полей (viewer+).
func (s *Server) handleGetSchema(w http.ResponseWriter, r *http.Request) {
	raw, err := s.getSchemaRaw(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"fields": raw})
}

// handleSetSchema сохраняет схему своих полей (admin).
func (s *Server) handleSetSchema(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Fields []SchemaField `json:"fields"`
	}
	if err := decodeJSON(w, r, &req, 1<<20); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json"})
		return
	}
	// Валидация типов.
	seen := map[string]bool{}
	fields := make([]SchemaField, 0, len(req.Fields))
	for _, f := range req.Fields {
		f.Key = strings.TrimSpace(f.Key)
		f.Label = strings.TrimSpace(f.Label)
		if f.Key == "" {
			continue
		}
		switch f.Type {
		case "text", "list", "date", "number", "bool":
		default:
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid field type"})
			return
		}
		if seen[f.Key] {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "duplicate field key"})
			return
		}
		seen[f.Key] = true
		fields = append(fields, f)
	}
	if req.Fields != nil && len(fields) == 0 {
		// явно очистили схему
	}
	raw, err := json.Marshal(fields)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "json error"})
		return
	}
	if _, err := s.pool.Exec(r.Context(), `
INSERT INTO schema (id, field_defs) VALUES (1, $1)
ON CONFLICT (id) DO UPDATE SET field_defs = EXCLUDED.field_defs`, raw); err != nil {
		log.Printf("set schema: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) getSchemaRaw(ctx context.Context) ([]SchemaField, error) {
	var raw []byte
	err := s.pool.QueryRow(ctx, `SELECT field_defs FROM schema WHERE id = 1`).Scan(&raw)
	if err != nil {
		if err.Error() == "no rows in result set" {
			return []SchemaField{}, nil
		}
		return nil, err
	}
	var fields []SchemaField
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &fields)
	}
	if fields == nil {
		fields = []SchemaField{}
	}
	return fields, nil
}
