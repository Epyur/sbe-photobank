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
type viewAsRoleCtx struct{}

// normalizeViewAsRole — валидирует заголовок X-View-As-Role («Просмотр от
// лица роли», 2026-09-03): пусто/неизвестное/"superadmin" → выключено (нельзя
// запросить роль не ниже собственной — см. effectiveRole).
func normalizeViewAsRole(raw string) string {
	v := strings.ToLower(strings.TrimSpace(raw))
	switch v {
	case "viewer", "commenter", "editor", "admin":
		return v
	default:
		return ""
	}
}

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

// rawRole — реальная роль пользователя, БЕЗ учёта «просмотра от лица роли».
// Использовать для проверок прав — effectiveRole; rawRole — только там, где
// нужна настоящая роль независимо от активной симуляции (переключатель ролей
// в UI суперадмина).
func (s *Server) rawRole(ctx context.Context, appID, email string) (string, error) {
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

// effectiveRole — роль для ВСЕХ проверок прав и фильтрации видимости:
// реальная роль (rawRole), а если активен «просмотр от лица роли» (заголовок
// X-View-As-Role, см. requirePerm/normalizeViewAsRole) — с подменой на
// запрошенную более низкую роль. Подмена возможна ТОЛЬКО когда реальная роль —
// superadmin, канал — web, и запрошенная роль строго ниже superadmin —
// поэтому не может стать способом эскалации прав. Запись (загрузка, папки,
// права и т.д.) в любом случае блокируется для web через requireNotWebChannel
// независимо от роли — «просмотр от лица роли» здесь влияет на ВИДИМОСТЬ.
// Проверяется заново на каждый вызов по реальной роли из БД, а не один раз в
// мидлваре — поэтому симуляция ограничивает всё, что читает effectiveRole, а
// не только сам gate в requirePerm.
func (s *Server) effectiveRole(ctx context.Context, appID, email string) (string, error) {
	role, err := s.rawRole(ctx, appID, email)
	if err != nil {
		return "", err
	}
	channel, _ := ctx.Value(permChannelCtx{}).(string)
	if viewAs, ok := ctx.Value(viewAsRoleCtx{}).(string); ok && viewAs != "" &&
		channel == "web" && role == "superadmin" && roleRank(viewAs) < roleRank(role) {
		role = viewAs
	}
	return role, nil
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

			// Контекст (email/channel/view-as) строится ДО первого вызова
			// effectiveRole — иначе gate ниже проверял бы РЕАЛЬНУЮ роль вместо
			// симулированной.
			ctx := context.WithValue(r.Context(), permEmailCtx{}, claims.Email)
			ctx = context.WithValue(ctx, permChannelCtx{}, claims.Channel)
			if viewAs := normalizeViewAsRole(r.Header.Get("X-View-As-Role")); viewAs != "" {
				ctx = context.WithValue(ctx, viewAsRoleCtx{}, viewAs)
			}

			role, err := s.effectiveRole(ctx, claims.AppID, claims.Email)
			if err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
				return
			}
			if roleRank(role) < roleRank(minRole) {
				writeJSON(w, http.StatusForbidden, map[string]any{"error": "forbidden: insufficient role"})
				return
			}

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
