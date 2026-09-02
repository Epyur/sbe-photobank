package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5"
)

var jwtSecret []byte

// loadJWTSecret — per-service ключ (Блок D, ревью 1.2): вместо общего JWT_SECRET
// валидируем токены своим {APP}_SERVICE_SECRET (тем же, что у /apps/register).
func loadJWTSecret() error {
	key := strings.ToUpper(appIDFromEnv()) + "_SERVICE_SECRET"
	secret := os.Getenv(key)
	if secret == "" {
		return fmt.Errorf("%s is required", key)
	}
	jwtSecret = []byte(secret)
	return nil
}

type jwtClaims struct {
	Email    string `json:"email"`
	DeviceID string `json:"device_id"`
	AppID    string `json:"app_id"`
	// Channel — "plugin" (Obsidian) или "web" («ЦУП Веб», 2026-09-02, magic-link).
	// Веб-сессиям запрещена запись независимо от роли, см. requireNotWebChannel.
	Channel string `json:"channel"`
	jwt.RegisteredClaims
}

func parseJWT(tokenStr string) (*jwtClaims, error) {
	claims, err := parseWithKey(tokenStr, jwtSecret)
	if err != nil {
		// Переходный период (Блок D): принимаем и токены, подписанные прежним
		// общим JWT_SECRET, пока он ещё присутствует в env.
		if legacy := os.Getenv("JWT_SECRET"); legacy != "" {
			if c, e2 := parseWithKey(tokenStr, []byte(legacy)); e2 == nil {
				return c, nil
			}
		}
	}
	return claims, err
}

func parseWithKey(tokenStr string, key []byte) (*jwtClaims, error) {
	claims := &jwtClaims{}
	token, err := jwt.ParseWithClaims(tokenStr, claims, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, errors.New("unexpected signing method")
		}
		return key, nil
	}, jwt.WithExpirationRequired(), jwt.WithLeeway(30*time.Second))
	if err != nil || !token.Valid {
		return nil, errors.New("invalid token")
	}
	return claims, nil
}

func claimStringsContains(a jwt.ClaimStrings, s string) bool {
	for _, v := range a {
		if v == s {
			return true
		}
	}
	return false
}

func appIDFromEnv() string {
	if v := os.Getenv("PHOTO_APP_ID"); v != "" {
		return v
	}
	return "photo"
}

func roleRank(role string) int {
	switch role {
	case "superadmin":
		return 5
	case "admin":
		return 4
	case "editor":
		return 3
	case "commenter":
		return 2
	case "viewer":
		return 1
	default:
		return 0
	}
}

type permEmailCtx struct{}
type permChannelCtx struct{}

func (s *Server) roleFor(ctx context.Context, appID, email string) (string, error) {
	var role string
	err := s.pool.QueryRow(ctx,
		`SELECT role FROM photo_permissions WHERE app = $1 AND email = $2`,
		appID, email).Scan(&role)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", nil
		}
		return "", err
	}
	return role, nil
}

// effectiveRole — персональная роль, иначе общий уровень доступа
// (по умолчанию viewer — «сотрудник»: все авторизованные могут просматривать).
func (s *Server) effectiveRole(ctx context.Context, appID, email string) (string, error) {
	role, err := s.roleFor(ctx, appID, email)
	if err != nil {
		return "", err
	}
	if role != "" {
		return role, nil
	}
	var level string
	err = s.pool.QueryRow(ctx,
		`SELECT level FROM photo_common_access WHERE app = $1`, appID).Scan(&level)
	if err != nil {
		// Нет записи — дефолт «сотрудник» (viewer).
		return "viewer", nil
	}
	if level == "" {
		return "viewer", nil
	}
	return level, nil
}

func (s *Server) requirePerm(minRole string) func(http.HandlerFunc) http.HandlerFunc {
	return func(next http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			auth := r.Header.Get("Authorization")
			tokenStr := strings.TrimSpace(strings.TrimPrefix(auth, "Bearer"))
			if tokenStr == "" {
				writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "unauthorized"})
				return
			}

			claims, err := parseJWT(tokenStr)
			if err != nil {
				writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "unauthorized"})
				return
			}
			if claims.AppID != appIDFromEnv() {
				writeJSON(w, http.StatusForbidden, map[string]any{"error": "forbidden"})
				return
			}
			if claims.Issuer != "" && claims.Issuer != "auth-service" {
				writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "unauthorized"})
				return
			}
			if len(claims.Audience) > 0 && !claimStringsContains(claims.Audience, appIDFromEnv()) {
				writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "unauthorized"})
				return
			}

			role, err := s.effectiveRole(r.Context(), claims.AppID, claims.Email)
			if err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
				return
			}
			if roleRank(role) < roleRank(minRole) {
				writeJSON(w, http.StatusForbidden, map[string]any{"error": "forbidden: insufficient role"})
				return
			}

			ctx := context.WithValue(r.Context(), permEmailCtx{}, claims.Email)
			ctx = context.WithValue(ctx, permChannelCtx{}, claims.Channel)
			next(w, r.WithContext(ctx))
		}
	}
}

// requireNotWebChannel — «ЦУП Веб» (2026-09-02): блокирует запись для JWT,
// выданных веб-сессии (channel="web"), независимо от роли — веб-порталу
// доступны только просмотр/поиск/соцслой (лайк/избранное/комментарии),
// вся запись контента (загрузка, папки, права, группы, схема) — только через
// Obsidian-плагин. Композируется поверх requirePerm:
// s.requirePerm(role)(requireNotWebChannel(s.handleX)).
func requireNotWebChannel(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if ch, _ := r.Context().Value(permChannelCtx{}).(string); ch == "web" {
			writeJSON(w, http.StatusForbidden, map[string]any{"error": "forbidden: web channel is read-only"})
			return
		}
		next(w, r)
	}
}
