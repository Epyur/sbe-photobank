package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"strings"
)

func ownerEmailFromEnv() string {
	return os.Getenv("PHOTO_OWNER_EMAIL")
}

// handleMyPermission возвращает глобальную роль текущего пользователя (по JWT email).
func (s *Server) handleMyPermission(w http.ResponseWriter, r *http.Request) {
	email, ok := r.Context().Value(permEmailCtx{}).(string)
	if !ok || email == "" {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "unauthorized"})
		return
	}
	role, err := s.effectiveRole(r.Context(), appIDFromEnv(), email)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	if role == "" {
		writeJSON(w, http.StatusOK, map[string]any{"email": email, "role": "", "hasAccess": false})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"email": email, "role": role, "hasAccess": true})
}

// handleListPermissions возвращает все глобальные роли (для admin).
func (s *Server) handleListPermissions(w http.ResponseWriter, r *http.Request) {
	rows, err := s.pool.Query(r.Context(), `
SELECT email, role FROM photo_permissions WHERE app = $1 ORDER BY email`, appIDFromEnv())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	defer rows.Close()

	type perm struct {
		Email string `json:"email"`
		Role  string `json:"role"`
	}
	perms := make([]perm, 0, 16)
	for rows.Next() {
		var p perm
		if err := rows.Scan(&p.Email, &p.Role); err != nil {
			log.Printf("permissions scan: %v", err)
			continue
		}
		perms = append(perms, p)
	}
	if err := rows.Err(); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"permissions": perms})
}

// handleSetPermission устанавливает глобальную роль ({email, role}); role="" — удаляет доступ.
func (s *Server) handleSetPermission(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Email string `json:"email"`
		Role  string `json:"role"`
	}
	if err := decodeJSON(w, r, &req, 1<<20); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json"})
		return
	}
	req.Email = strings.TrimSpace(req.Email)
	req.Role = strings.TrimSpace(req.Role)
	if req.Email == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "email is required"})
		return
	}
	if req.Role != "" && req.Role != "viewer" && req.Role != "commenter" && req.Role != "editor" && req.Role != "admin" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "role must be viewer, commenter, editor or admin"})
		return
	}

	if req.Role == "" || req.Role != "admin" {
		owner := ownerEmailFromEnv()
		if req.Email == owner {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "нельзя отозвать доступ владельца"})
			return
		}
	}

	var err error
	if req.Role == "" {
		_, err = s.pool.Exec(r.Context(), `
DELETE FROM photo_permissions WHERE app = $1 AND email = $2`, appIDFromEnv(), req.Email)
	} else {
		_, err = s.pool.Exec(r.Context(), `
INSERT INTO photo_permissions (app, email, role) VALUES ($1, $2, $3)
ON CONFLICT (app, email) DO UPDATE SET role = EXCLUDED.role`,
			appIDFromEnv(), req.Email, req.Role)
	}
	if err != nil {
		log.Printf("set permission: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// Group — группа доступа: субъект folder_permissions и объект grant-override.
type Group struct {
	ID      int64    `json:"id"`
	Name    string   `json:"name"`
	Members []string `json:"members"`
}

// handleListGroups возвращает все группы (admin) или только видимые данные для владельца.
func (s *Server) handleListGroups(w http.ResponseWriter, r *http.Request) {
	rows, err := s.pool.Query(r.Context(), `SELECT id, name, members FROM groups ORDER BY name`)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	defer rows.Close()

	groups := make([]Group, 0, 8)
	for rows.Next() {
		var g Group
		var membersRaw []byte
		if err := rows.Scan(&g.ID, &g.Name, &membersRaw); err != nil {
			log.Printf("groups scan: %v", err)
			continue
		}
		if len(membersRaw) > 0 {
			_ = json.Unmarshal(membersRaw, &g.Members)
		}
		if g.Members == nil {
			g.Members = []string{}
		}
		groups = append(groups, g)
	}
	if err := rows.Err(); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"groups": groups})
}

// handleSaveGroup создаёт/обновляет группу ({id?, name, members[]}) (admin).
func (s *Server) handleSaveGroup(w http.ResponseWriter, r *http.Request) {
	var req Group
	if err := decodeJSON(w, r, &req, 1<<20); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json"})
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "name is required"})
		return
	}
	members := make([]string, 0, len(req.Members))
	for _, m := range req.Members {
		m = strings.ToLower(strings.TrimSpace(m))
		if m != "" {
			members = append(members, m)
		}
	}
	if req.Members == nil {
		members = []string{}
	}
	membersJSON, err := json.Marshal(members)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "json error"})
		return
	}

	if req.ID > 0 {
		_, err = s.pool.Exec(r.Context(),
			`UPDATE groups SET name = $2, members = $3 WHERE id = $1`, req.ID, req.Name, membersJSON)
	} else {
		_, err = s.pool.Exec(r.Context(),
			`INSERT INTO groups (name, members) VALUES ($1, $2)`, req.Name, membersJSON)
	}
	if err != nil {
		log.Printf("save group: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleDeleteGroup удаляет группу (admin).
func (s *Server) handleDeleteGroup(w http.ResponseWriter, r *http.Request) {
	id := parseIntPath(r, "id")
	if id <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid id"})
		return
	}
	if _, err := s.pool.Exec(r.Context(), `DELETE FROM groups WHERE id = $1`, id); err != nil {
		log.Printf("delete group: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"deleted": true})
}
