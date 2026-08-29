package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// Folder — папка/альбом (дерево).
type Folder struct {
	ID          int64  `json:"id"`
	Name        string `json:"name"`
	ParentID    int64  `json:"parent_id"`
	OwnerEmail  string `json:"owner_email"`
	Limited     bool   `json:"limited"`
	CreatedAt   string `json:"created_at"`
	UpdatedAt   string `json:"updated_at"`
	Permissions []FolderPerm `json:"permissions,omitempty"`
}

// FolderPerm — доступ к папке: subject (email или имя группы),
// role (viewer «Сотрудник» / editor «Редактор» / admin «Администратор папки»).
type FolderPerm struct {
	Subject string `json:"subject"`
	Role    string `json:"role"`
}

// visibleFolderIDs возвращает множество видимых папок пользователя (folderID -> max роль).
// Модель прав (как lab-service):
//   - общий доступ: по умолчанию все папки видны «сотрудникам» (viewer), кроме
//     папок с limited=true;
//   - limited-папка видна только тем, кому (или чьей группе) назначена роль на
//     неё или на любого предка;
//   - роли наследуются вниз по дереву.
func (s *Server) visibleFolderIDs(ctx context.Context, email string) (map[int64]int, error) {
	subjects := s.userSubjects(ctx, email)

	// Роли пользователя/групп на папки: folder_id -> max роль.
	rows, err := s.pool.Query(ctx, `
SELECT fp.folder_id, fp.role FROM folder_permissions fp
WHERE fp.subject = ANY($1)`, subjects)
	if err != nil {
		return nil, err
	}
	direct := map[int64]int{}
	for rows.Next() {
		var fid int64
		var role string
		if err := rows.Scan(&fid, &role); err != nil {
			rows.Close()
			return nil, err
		}
		if r := roleRank(role); r > direct[fid] {
			direct[fid] = r
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// Дерево папок + флаг limited.
	treeRows, err := s.pool.Query(ctx, `SELECT id, parent_id, limited FROM folders`)
	if err != nil {
		return nil, err
	}
	children := map[int64][]int64{}
	limited := map[int64]bool{}
	topLevel := map[int64]bool{}
	for treeRows.Next() {
		var id, parent int64
		var lim bool
		if err := treeRows.Scan(&id, &parent, &lim); err != nil {
			treeRows.Close()
			return nil, err
		}
		children[parent] = append(children[parent], id)
		limited[id] = lim
		if parent == 0 {
			topLevel[id] = true
		}
	}
	treeRows.Close()
	if err := treeRows.Err(); err != nil {
		return nil, err
	}

	// Корни видимости: верхние неограниченные папки (общий доступ viewer)
	// + любые папки (в т.ч. limited) с прямой ролью пользователя/группы.
	visible := map[int64]int{}
	queue := make([]int64, 0, len(direct)+8)
	for id := range topLevel {
		if !limited[id] {
			visible[id] = roleRank("viewer")
			queue = append(queue, id)
		}
	}
	for fid, role := range direct {
		if role > visible[fid] {
			visible[fid] = role
			queue = append(queue, fid)
		}
	}

	// BFS вниз: потомки наследуют видимость/роль; limited-подпапка наследуется
	// только если у пользователя есть роль на неё (иначе — стоп по ветке).
	for len(queue) > 0 {
		parent := queue[0]
		queue = queue[1:]
		role := visible[parent]
		for _, child := range children[parent] {
			if limited[child] {
				// Ограниченная подпапка: видна только по своей роли.
				if dr := direct[child]; dr > 0 && dr > visible[child] {
					visible[child] = dr
					queue = append(queue, child)
				}
				continue
			}
			if role > visible[child] {
				visible[child] = role
				queue = append(queue, child)
			}
		}
	}
	return visible, nil
}

// userSubjects возвращает список субъектов доступа пользователя: email + имена групп,
// в которых он состоит.
func (s *Server) userSubjects(ctx context.Context, email string) []string {
	subjects := []string{email}
	rows, err := s.pool.Query(ctx, `SELECT name FROM groups WHERE $1 = ANY(members)`, email)
	if err != nil {
		return subjects
	}
	defer rows.Close()
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			continue
		}
		subjects = append(subjects, name)
	}
	return subjects
}

// handleListFolders возвращает видимые папки (для pull плагина). admin — все.
func (s *Server) handleListFolders(w http.ResponseWriter, r *http.Request) {
	email, _ := r.Context().Value(permEmailCtx{}).(string)
	role, err := s.effectiveRole(r.Context(), appIDFromEnv(), email)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}

	rows, err := s.pool.Query(r.Context(), `
SELECT id, name, parent_id, owner_email, limited, created_at, updated_at FROM folders ORDER BY name`)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	defer rows.Close()

	visible := map[int64]int{}
	if role != "admin" && role != "superadmin" {
		visible, err = s.visibleFolderIDs(r.Context(), email)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
			return
		}
	}

	folders := make([]Folder, 0, 32)
	for rows.Next() {
		var f Folder
		var createdAt, updatedAt time.Time
		if err := rows.Scan(&f.ID, &f.Name, &f.ParentID, &f.OwnerEmail, &f.Limited, &createdAt, &updatedAt); err != nil {
			log.Printf("folders scan: %v", err)
			continue
		}
		f.CreatedAt = createdAt.Format(time.RFC3339)
		f.UpdatedAt = updatedAt.Format(time.RFC3339)
		if role == "admin" || role == "superadmin" || visible[f.ID] > 0 {
			folders = append(folders, f)
		}
	}
	if err := rows.Err(); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"folders": folders})
}

// handleCreateFolder создаёт папку ({name, parent_id}).
// Администратор системы (admin/superadmin) создаёт верхние папки (parent_id=0)
// и папки где угодно; администратор папки (role=admin на родительской папке)
// создаёт подпапки внутри своей папки.
func (s *Server) handleCreateFolder(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name     string `json:"name"`
		ParentID int64  `json:"parent_id"`
	}
	if err := decodeJSON(w, r, &req, 1<<20); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json"})
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "name is required"})
		return
	}
	email, _ := r.Context().Value(permEmailCtx{}).(string)
	globalRole, err := s.effectiveRole(r.Context(), appIDFromEnv(), email)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	// Право: глобальный admin/superadmin, либо admin на родительской папке.
	can := roleRank(globalRole) >= roleRank("admin")
	if !can && req.ParentID > 0 {
		can = s.canManageFolder(r.Context(), req.ParentID, email, globalRole)
	}
	if !can {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": "forbidden: admin required"})
		return
	}

	var id int64
	err = s.pool.QueryRow(r.Context(), `
INSERT INTO folders (name, parent_id, owner_email) VALUES ($1, $2, $3) RETURNING id`,
		req.Name, req.ParentID, email).Scan(&id)
	if err != nil {
		log.Printf("create folder: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": id})
}

// canManageFolder — может ли пользователь администрировать папку
// (глобальный admin/superadmin или роль admin на папке/предке).
func (s *Server) canManageFolder(ctx context.Context, folderID int64, email, globalRole string) bool {
	if roleRank(globalRole) >= roleRank("admin") {
		return true
	}
	visible, err := s.visibleFolderIDs(ctx, email)
	if err != nil {
		return false
	}
	return roleRank(roleName(visible[folderID])) >= roleRank("admin")
}

// handleRenameFolder переименовывает папку ({id, name}) (admin системы или папки).
func (s *Server) handleRenameFolder(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID   int64  `json:"id"`
		Name string `json:"name"`
	}
	if err := decodeJSON(w, r, &req, 1<<20); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json"})
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.ID <= 0 || req.Name == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "id and name are required"})
		return
	}
	email, _ := r.Context().Value(permEmailCtx{}).(string)
	globalRole, err := s.effectiveRole(r.Context(), appIDFromEnv(), email)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	if !s.canManageFolder(r.Context(), req.ID, email, globalRole) {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": "forbidden: admin required"})
		return
	}
	if _, err := s.pool.Exec(r.Context(),
		`UPDATE folders SET name = $2 WHERE id = $1`, req.ID, req.Name); err != nil {
		log.Printf("rename folder: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleDeleteFolder удаляет папку вместе с её подпапками и фото (admin системы или папки).
func (s *Server) handleDeleteFolder(w http.ResponseWriter, r *http.Request) {
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
	if !s.canManageFolder(r.Context(), id, email, globalRole) {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": "forbidden: admin required"})
		return
	}

	// Собрать все подпапки.
	ids, err := s.folderAndDescendants(r.Context(), id)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}

	if _, err := s.pool.Exec(r.Context(), `
DELETE FROM folders WHERE id = ANY($1)`, ids); err != nil {
		log.Printf("delete folder: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	if _, err := s.pool.Exec(r.Context(), `
DELETE FROM folder_permissions WHERE folder_id = ANY($1)`, ids); err != nil {
		log.Printf("delete folder perms: %v", err)
	}
	if _, err := s.pool.Exec(r.Context(), `
DELETE FROM photos WHERE folder_id = ANY($1)`, ids); err != nil {
		log.Printf("delete folder photos: %v", err)
	}
	writeJSON(w, http.StatusOK, map[string]any{"deleted": true})
}

// folderAndDescendants возвращает id папки и всех её потомков.
func (s *Server) folderAndDescendants(ctx context.Context, rootID int64) ([]int64, error) {
	rows, err := s.pool.Query(ctx, `SELECT id, parent_id FROM folders`)
	if err != nil {
		return nil, err
	}
	children := map[int64][]int64{}
	for rows.Next() {
		var id, parent int64
		if err := rows.Scan(&id, &parent); err != nil {
			rows.Close()
			return nil, err
		}
		children[parent] = append(children[parent], id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	ids := []int64{rootID}
	queue := []int64{rootID}
	for len(queue) > 0 {
		p := queue[0]
		queue = queue[1:]
		for _, c := range children[p] {
			ids = append(ids, c)
			queue = append(queue, c)
		}
	}
	return ids, nil
}

// handleListFolderPerms возвращает права папки (admin).
func (s *Server) handleListFolderPerms(w http.ResponseWriter, r *http.Request) {
	id := parseIntPath(r, "id")
	if id <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid id"})
		return
	}
	rows, err := s.pool.Query(r.Context(), `
SELECT subject, role FROM folder_permissions WHERE folder_id = $1`, id)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	defer rows.Close()
	perms := make([]FolderPerm, 0, 8)
	for rows.Next() {
		var p FolderPerm
		if err := rows.Scan(&p.Subject, &p.Role); err != nil {
			continue
		}
		perms = append(perms, p)
	}
	writeJSON(w, http.StatusOK, map[string]any{"permissions": perms})
}

// handleSetFolderPerm назначает доступ на папку ({subject, role}) (admin); role="" — убрать.
func (s *Server) handleSetFolderPerm(w http.ResponseWriter, r *http.Request) {
	id := parseIntPath(r, "id")
	if id <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid id"})
		return
	}
	var req FolderPerm
	if err := decodeJSON(w, r, &req, 1<<20); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json"})
		return
	}
	req.Subject = strings.ToLower(strings.TrimSpace(req.Subject))
	if req.Subject == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "subject is required"})
		return
	}
	if req.Role != "" && req.Role != "viewer" && req.Role != "commenter" && req.Role != "editor" && req.Role != "admin" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "role must be viewer, commenter, editor or admin"})
		return
	}

	var err error
	if req.Role == "" {
		_, err = s.pool.Exec(r.Context(),
			`DELETE FROM folder_permissions WHERE folder_id = $1 AND subject = $2`, id, req.Subject)
	} else {
		_, err = s.pool.Exec(r.Context(), `
INSERT INTO folder_permissions (folder_id, subject, role) VALUES ($1, $2, $3)
ON CONFLICT (folder_id, subject) DO UPDATE SET role = EXCLUDED.role`, id, req.Subject, req.Role)
	}
	if err != nil {
		log.Printf("set folder perm: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleSetFolderLimited включает/выключает «ограниченный доступ» к папке
// (админ системы или админ папки): при limited=true папка скрыта от общего
// просмотра — видна только по назначенным ролям.
func (s *Server) handleSetFolderLimited(w http.ResponseWriter, r *http.Request) {
	id := parseIntPath(r, "id")
	if id <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid id"})
		return
	}
	var req struct {
		Limited bool `json:"limited"`
	}
	if err := decodeJSON(w, r, &req, 1<<20); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json"})
		return
	}
	email, _ := r.Context().Value(permEmailCtx{}).(string)
	globalRole, err := s.effectiveRole(r.Context(), appIDFromEnv(), email)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	if !s.canManageFolder(r.Context(), id, email, globalRole) {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": "forbidden: admin required"})
		return
	}
	if _, err := s.pool.Exec(r.Context(),
		`UPDATE folders SET limited = $2 WHERE id = $1`, id, req.Limited); err != nil {
		log.Printf("set folder limited: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// folderExists проверяет существование папки.
func (s *Server) folderExists(ctx context.Context, id int64) bool {
	var one int
	err := s.pool.QueryRow(ctx, `SELECT 1 FROM folders WHERE id = $1`, id).Scan(&one)
	return err == nil
}

// canActOnFolder — имеет ли пользователь роль не ниже minRole в контексте папки
// (глобальная роль или роль на папке/предке).
func (s *Server) canActOnFolder(ctx context.Context, folderID int64, email, minRole string, globalRole string) bool {
	if roleRank(globalRole) >= roleRank(minRole) {
		return true
	}
	visible, err := s.visibleFolderIDs(ctx, email)
	if err != nil {
		return false
	}
	return roleRank(roleName(visible[folderID])) >= roleRank(minRole)
}

func roleName(rank int) string {
	switch {
	case rank >= roleRank("admin"):
		return "admin"
	case rank >= roleRank("editor"):
		return "editor"
	case rank >= roleRank("commenter"):
		return "commenter"
	case rank >= roleRank("viewer"):
		return "viewer"
	}
	return ""
}

// photoFolderID возвращает folder_id фото (для проверки контекста папки).
func (s *Server) photoFolderID(ctx context.Context, photoID int64) (int64, error) {
	var fid int64
	err := s.pool.QueryRow(ctx, `SELECT folder_id FROM photos WHERE id = $1`, photoID).Scan(&fid)
	return fid, err
}

// photoExistsIn checks.
func (s *Server) photoExists(ctx context.Context, id int64) bool {
	var one int
	err := s.pool.QueryRow(ctx, `SELECT 1 FROM photos WHERE id = $1`, id).Scan(&one)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return false
		}
		log.Printf("photoExists: %v", err)
	}
	return one == 1
}
