package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type Server struct {
	pool        *pgxpool.Pool
	s3          *S3Store
	fileBaseURL string
}

func main() {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		log.Fatal("DATABASE_URL is required")
	}
	port := os.Getenv("PORT")
	if port == "" {
		port = "3000"
	}
	if err := loadJWTSecret(); err != nil {
		log.Fatalf("JWT: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		log.Fatalf("pgxpool.New: %v", err)
	}
	defer pool.Close()

	if err := pool.Ping(ctx); err != nil {
		log.Fatalf("ping: %v", err)
	}

	s3Store, err := NewS3Store()
	if err != nil {
		log.Fatalf("S3: %v", err)
	}

	s := &Server{pool: pool, s3: s3Store}
	s.fileBaseURL = s3Store.publicBaseURL()

	if err := s.migrate(ctx); err != nil {
		log.Fatalf("migrate: %v", err)
	}
	if err := s.seedOwner(ctx); err != nil {
		log.Fatalf("seedOwner: %v", err)
	}
	regCtx, regCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer regCancel()
	if err := s.registerApp(regCtx); err != nil {
		log.Printf("registerApp (non-fatal): %v", err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/photo/health", s.handleHealth)
	mux.HandleFunc("POST /api/photo/sync/push", s.requirePerm("editor")(s.handlePush))
	mux.HandleFunc("GET /api/photo/sync/pull", s.requirePerm("viewer")(s.handlePull))
	mux.HandleFunc("POST /api/photo/file", s.requirePerm("editor")(s.handleUploadFile))
	mux.HandleFunc("POST /api/photo/thumb", s.requirePerm("editor")(s.handleUploadThumb))
	mux.HandleFunc("GET /api/photo/file", s.requirePerm("viewer")(s.handleDownloadFile))
	mux.HandleFunc("GET /api/photo/file-link", s.requirePerm("viewer")(s.handleFileLink))
	mux.HandleFunc("GET /api/photo/search", s.requirePerm("viewer")(s.handleSearch))
	mux.HandleFunc("GET /api/photo/folders", s.requirePerm("viewer")(s.handleListFolders))
	mux.HandleFunc("POST /api/photo/folders", s.requirePerm("admin")(s.handleCreateFolder))
	mux.HandleFunc("POST /api/photo/folders/rename", s.requirePerm("admin")(s.handleRenameFolder))
	mux.HandleFunc("DELETE /api/photo/folders/{id}", s.requirePerm("viewer")(s.handleDeleteFolder))
	mux.HandleFunc("POST /api/photo/folders/{id}/limited", s.requirePerm("viewer")(s.handleSetFolderLimited))
	mux.HandleFunc("GET /api/photo/folders/{id}/permissions", s.requirePerm("viewer")(s.handleListFolderPerms))
	mux.HandleFunc("POST /api/photo/folders/{id}/permissions", s.requirePerm("viewer")(s.handleSetFolderPerm))
	mux.HandleFunc("GET /api/photo/permissions", s.requirePerm("admin")(s.handleListPermissions))
	mux.HandleFunc("POST /api/photo/permissions", s.requirePerm("admin")(s.handleSetPermission))
	mux.HandleFunc("GET /api/photo/permissions/me", s.requirePerm("viewer")(s.handleMyPermission))
	mux.HandleFunc("GET /api/photo/common-access", s.requirePerm("admin")(s.handleGetCommonAccess))
	mux.HandleFunc("POST /api/photo/common-access", s.requirePerm("admin")(s.handleSetCommonAccess))
	mux.HandleFunc("GET /api/photo/groups", s.requirePerm("viewer")(s.handleListGroups))
	mux.HandleFunc("POST /api/photo/groups", s.requirePerm("admin")(s.handleSaveGroup))
	mux.HandleFunc("DELETE /api/photo/groups/{id}", s.requirePerm("admin")(s.handleDeleteGroup))
	mux.HandleFunc("GET /api/photo/schema", s.requirePerm("viewer")(s.handleGetSchema))
	mux.HandleFunc("POST /api/photo/schema", s.requirePerm("admin")(s.handleSetSchema))
	mux.HandleFunc("GET /api/photo/photos/{id}", s.requirePerm("viewer")(s.handleGetPhoto))
	mux.HandleFunc("DELETE /api/photo/photos/{id}", s.requirePerm("viewer")(s.handleDeletePhoto))
	mux.HandleFunc("POST /api/photo/photos/{id}/view", s.requirePerm("viewer")(s.handleViewPhoto))
	mux.HandleFunc("GET /api/photo/photos/{id}/comments", s.requirePerm("viewer")(s.handleListComments))
	mux.HandleFunc("POST /api/photo/photos/{id}/comments", s.requirePerm("commenter")(s.handleAddComment))
	mux.HandleFunc("POST /api/photo/photos/{id}/like", s.requirePerm("commenter")(s.handleSetLike))
	mux.HandleFunc("POST /api/photo/photos/{id}/favorite", s.requirePerm("commenter")(s.handleSetFavorite))
	mux.HandleFunc("GET /api/photo/favorites", s.requirePerm("viewer")(s.handleFavorites))
	mux.HandleFunc("GET /api/photo/recent", s.requirePerm("viewer")(s.handleRecent))
	mux.HandleFunc("GET /api/photo/photos/{id}/visibility", s.requirePerm("admin")(s.handleGetVisibilityOverride))
	mux.HandleFunc("POST /api/photo/photos/{id}/visibility", s.requirePerm("admin")(s.handleSetVisibilityOverride))

	httpServer := &http.Server{
		Addr:              ":" + port,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
		WriteTimeout:      300 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	log.Printf("photo-service listening on :%s", port)
	if err := httpServer.ListenAndServe(); err != nil {
		log.Fatalf("ListenAndServe: %v", err)
	}
}

func (s *Server) migrate(ctx context.Context) error {
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS photo_permissions (
			app   TEXT NOT NULL,
			email TEXT NOT NULL,
			role  TEXT NOT NULL,
			PRIMARY KEY (app, email)
		)`,
		`CREATE TABLE IF NOT EXISTS groups (
			id      BIGSERIAL PRIMARY KEY,
			name    TEXT NOT NULL UNIQUE,
			members JSONB NOT NULL DEFAULT '[]'
		)`,
		`CREATE TABLE IF NOT EXISTS folders (
			id           BIGSERIAL PRIMARY KEY,
			name         TEXT NOT NULL,
			parent_id    BIGINT NOT NULL DEFAULT 0,
			owner_email  TEXT NOT NULL DEFAULT '',
			limited      BOOLEAN NOT NULL DEFAULT false,
			created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
			updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
		)`,
		`CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id)`,
		`ALTER TABLE folders ADD COLUMN IF NOT EXISTS limited BOOLEAN NOT NULL DEFAULT false`,
		`CREATE TABLE IF NOT EXISTS photo_common_access (
			app    TEXT PRIMARY KEY,
			level  TEXT NOT NULL DEFAULT 'viewer'
		)`,
		`CREATE TABLE IF NOT EXISTS folder_permissions (
			folder_id BIGINT NOT NULL,
			subject   TEXT NOT NULL,
			role      TEXT NOT NULL,
			PRIMARY KEY (folder_id, subject)
		)`,
		`CREATE TABLE IF NOT EXISTS photos (
			id                  BIGSERIAL PRIMARY KEY,
			folder_id           BIGINT NOT NULL DEFAULT 0,
			title               TEXT NOT NULL DEFAULT '',
			description         TEXT NOT NULL DEFAULT '',
			tags                JSONB NOT NULL DEFAULT '[]',
			custom              JSONB NOT NULL DEFAULT '{}',
			file_key            TEXT NOT NULL DEFAULT '',
			file_name           TEXT NOT NULL DEFAULT '',
			file_size           BIGINT NOT NULL DEFAULT 0,
			content_hash        TEXT NOT NULL DEFAULT '',
			mime_type           TEXT NOT NULL DEFAULT '',
			kind                TEXT NOT NULL DEFAULT 'image',
			width               INT NOT NULL DEFAULT 0,
			height              INT NOT NULL DEFAULT 0,
			duration            INT NOT NULL DEFAULT 0,
			thumb_key           TEXT NOT NULL DEFAULT '',
			thumb_author        TEXT NOT NULL DEFAULT '',
			author_email        TEXT NOT NULL DEFAULT '',
			shot_at             BIGINT NOT NULL DEFAULT 0,
			location            TEXT NOT NULL DEFAULT '',
			visibility_override TEXT NOT NULL DEFAULT '',
			download_count      INT NOT NULL DEFAULT 0,
			likes_count         INT NOT NULL DEFAULT 0,
			created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
			updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
		)`,
		`CREATE INDEX IF NOT EXISTS idx_photos_folder ON photos(folder_id)`,
		`CREATE INDEX IF NOT EXISTS idx_photos_kind ON photos(kind)`,
		`CREATE TABLE IF NOT EXISTS photo_access (
			photo_id BIGINT NOT NULL,
			subject  TEXT NOT NULL,
			PRIMARY KEY (photo_id, subject)
		)`,
		`CREATE TABLE IF NOT EXISTS comments (
			id           BIGSERIAL PRIMARY KEY,
			photo_id     BIGINT NOT NULL,
			author_email TEXT NOT NULL,
			text         TEXT NOT NULL,
			created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
		)`,
		`CREATE INDEX IF NOT EXISTS idx_comments_photo ON comments(photo_id)`,
		`CREATE TABLE IF NOT EXISTS likes (
			photo_id   BIGINT NOT NULL,
			user_email TEXT NOT NULL,
			PRIMARY KEY (photo_id, user_email)
		)`,
		`CREATE TABLE IF NOT EXISTS favorites (
			photo_id   BIGINT NOT NULL,
			user_email TEXT NOT NULL,
			PRIMARY KEY (photo_id, user_email)
		)`,
		`CREATE TABLE IF NOT EXISTS recent_views (
			user_email TEXT NOT NULL,
			photo_id   BIGINT NOT NULL,
			viewed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
			PRIMARY KEY (user_email, photo_id)
		)`,
		`CREATE TABLE IF NOT EXISTS schema (
			id         INT PRIMARY KEY,
			field_defs JSONB NOT NULL DEFAULT '[]'
		)`,
	}
	for _, stmt := range stmts {
		if _, err := s.pool.Exec(ctx, stmt); err != nil {
			return err
		}
	}
	return nil
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok"})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("writeJSON: %v", err)
	}
}

// decodeJSON читает JSON-тело с жёстким лимитом размера (защита от DoS памятью).
func decodeJSON(w http.ResponseWriter, r *http.Request, v any, maxBytes int64) error {
	r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
	return json.NewDecoder(r.Body).Decode(v)
}

func parseIntPath(r *http.Request, name string) int64 {
	v, err := strconv.ParseInt(r.PathValue(name), 10, 64)
	if err != nil {
		return 0
	}
	return v
}

func parseTime(v string, fallback time.Time) time.Time {
	if v == "" {
		return fallback
	}
	t, err := time.Parse(time.RFC3339, v)
	if err != nil {
		return fallback
	}
	return t
}
