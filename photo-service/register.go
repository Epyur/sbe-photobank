package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"time"
)

func (s *Server) registerApp(ctx context.Context) error {
	authURL := os.Getenv("AUTH_SERVICE_URL")
	if authURL == "" {
		authURL = "http://auth-service:3000"
	}
	serviceSecret := os.Getenv("PHOTO_SERVICE_SECRET")
	if serviceSecret == "" {
		return fmt.Errorf("PHOTO_SERVICE_SECRET is required for /apps/register")
	}
	name := os.Getenv("PHOTO_APP_NAME")
	if name == "" {
		name = "Photobank"
	}

	body, err := json.Marshal(map[string]string{
		"app_id":         appIDFromEnv(),
		"name":           name,
		"owner_email":    os.Getenv("PHOTO_OWNER_EMAIL"),
		"service_secret": serviceSecret,
	})
	if err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, authURL+"/apps/register", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: 8 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("apps/register status %d", resp.StatusCode)
	}
	log.Printf("registerApp: %s registered", appIDFromEnv())
	return nil
}

func (s *Server) seedOwner(ctx context.Context) error {
	owner := os.Getenv("PHOTO_OWNER_EMAIL")
	if owner == "" {
		return nil
	}
	_, err := s.pool.Exec(ctx, `
INSERT INTO photo_permissions (app, email, role) VALUES ($1, $2, 'superadmin')
ON CONFLICT (app, email) DO UPDATE SET role = EXCLUDED.role`, appIDFromEnv(), owner)
	return err
}
