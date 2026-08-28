package main

import (
	"bytes"
	"context"
	"image"
	_ "image/gif"
	"image/jpeg"
	_ "image/png"
	"io"
	"log"
	"net/http"
	"os"
	"path"
	"strings"
	"time"

	"golang.org/x/image/draw"
	"golang.org/x/image/webp"
)

const (
	thumbMaxWidth  = 800
	thumbMaxHeight = 800
)

// handleUploadFile загружает оригинал файла в S3 (editor+).
// multipart: file + folder_id + kind (image|video|raw) + mime_type.
// Для изображений создаёт миниатюру (thumb_author=auto) на сервере.
func (s *Server) handleUploadFile(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(1 << 30); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid multipart"})
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "file is required"})
		return
	}
	defer file.Close()

	folderID := parseFormInt64(r, "folder_id")
	kind := r.FormValue("kind")
	mimeType := r.FormValue("mime_type")
	if kind == "" {
		kind = kindFromMime(mimeType)
	}

	email, _ := r.Context().Value(permEmailCtx{}).(string)
	globalRole, err := s.effectiveRole(r.Context(), appIDFromEnv(), email)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	if !s.canActOnFolder(r.Context(), folderID, email, "editor", globalRole) {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": "forbidden: no editor rights on folder"})
		return
	}

	data, err := io.ReadAll(file)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "read file"})
		return
	}

	// Оригинал в S3.
	key, fileID := photoS3Key(header.Filename)
	size, url, err := s.s3.Put(r.Context(), key, data)
	if err != nil {
		log.Printf("s3 put original: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "s3 error"})
		return
	}

	// Миниатюра для изображений.
	thumbKey := ""
	thumbAuthor := ""
	width, height := 0, 0
	if kind == "image" {
		thKey, thData, w, h, thErr := makeThumbnail(data, header.Filename, fileID)
		if thErr != nil {
			log.Printf("thumbnail: %v (skip)", thErr)
		} else {
			thumbKey = thKey
			thumbAuthor = "auto"
			width, height = w, h
			if _, _, err := s.s3.Put(r.Context(), thKey, thData); err != nil {
				log.Printf("s3 put thumb: %v (skip)", err)
				thumbKey = ""
				thumbAuthor = ""
			}
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"file_key":    key,
		"file_name":   header.Filename,
		"file_size":   size,
		"file_url":    url,
		"thumb_key":   thumbKey,
		"thumb_author": thumbAuthor,
		"width":       width,
		"height":      height,
	})
}

// handleUploadThumb загружает обложку (пользовательскую) для видео/RAW (editor+).
func (s *Server) handleUploadThumb(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(64 << 20); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid multipart"})
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "file is required"})
		return
	}
	defer file.Close()

	photoID := r.FormValue("photo_id")
	data, err := io.ReadAll(file)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "read file"})
		return
	}
	key := photoThumbKey(photoID, header.Filename)
	if _, _, err := s.s3.Put(r.Context(), key, data); err != nil {
		log.Printf("s3 put thumb: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "s3 error"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"thumb_key":   key,
		"thumb_author": "user",
	})
}

// makeThumbnail уменьшает изображение (image/jpeg, png, gif, webp) до 800x800.
// Возвращает ключ S3 (в каталоге fileID — уникальный на файл), данные JPEG,
// ширину/высоту исходника.
func makeThumbnail(data []byte, fileName string, fileID string) (string, []byte, int, int, error) {
	src, err := decodeImage(data)
	if err != nil {
		return "", nil, 0, 0, err
	}
	bounds := src.Bounds()
	width, height := bounds.Dx(), bounds.Dy()

	dstW, dstH := fitSize(width, height, thumbMaxWidth, thumbMaxHeight)
	if dstW >= width && dstH >= height {
		// не увеличиваем — обложкой станет сам файл.
		return "", nil, width, height, nil
	}

	dst := image.NewRGBA(image.Rect(0, 0, dstW, dstH))
	draw.CatmullRom.Scale(dst, dst.Bounds(), src, bounds, draw.Over, nil)

	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, dst, &jpeg.Options{Quality: 82}); err != nil {
		return "", nil, 0, 0, err
	}
	ext := strings.ToLower(path.Ext(fileName))
	if ext == "" {
		ext = ".jpg"
	}
	return photoThumbKey(fileID, "thumb"+ext), buf.Bytes(), width, height, nil
}

func decodeImage(data []byte) (image.Image, error) {
	// Пробуем по сигнатуре формата, чтобы избежать ложного webp-декода.
	if len(data) >= 12 && bytes.HasPrefix(data[:12], []byte("RIFF")) &&
		bytes.HasPrefix(data[8:12], []byte("WEBP")) {
		return webp.Decode(bytes.NewReader(data))
	}
	img, _, err := image.Decode(bytes.NewReader(data))
	return img, err
}

func fitSize(w, h, maxW, maxH int) (int, int) {
	if w <= 0 || h <= 0 {
		return w, h
	}
	scale := 1.0
	if w > maxW {
		scale = float64(maxW) / float64(w)
	}
	if float64(h)*scale > float64(maxH) {
		scale = float64(maxH) / float64(h)
	}
	if scale >= 1 {
		return w, h
	}
	return int(float64(w) * scale), int(float64(h) * scale)
}

// handleDownloadFile скачивает оригинал из S3; увеличивает счётчик скачиваний (viewer+).
func (s *Server) handleDownloadFile(w http.ResponseWriter, r *http.Request) {
	key := r.URL.Query().Get("key")
	if key == "" || !validObjectKey(key, "photo") {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid or missing key"})
		return
	}
	// Проверка видимости по фото, которому принадлежит файл.
	if err := s.checkFileVisibility(r.Context(), r, key); err != nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "not found"})
		return
	}
	data, err := s.s3.Get(r.Context(), key)
	if err != nil {
		log.Printf("s3 get: %v", err)
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "file not found"})
		return
	}

	// Просмотр превью/миниатюры (`view=1`) не считается скачиванием — счётчик
	// download_count растёт только при явном скачивании файла.
	if r.URL.Query().Get("view") != "1" {
		s.incDownloadCount(r.Context(), key)
	}

	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	w.WriteHeader(http.StatusOK)
	if _, err := w.Write(data); err != nil {
		log.Printf("download write: %v", err)
	}
}

// handleFileLink возвращает временную публичную ссылку на файл (presigned GET) (viewer+).
func (s *Server) handleFileLink(w http.ResponseWriter, r *http.Request) {
	key := r.URL.Query().Get("key")
	if key == "" || !validObjectKey(key, "photo") {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid key"})
		return
	}
	if err := s.checkFileVisibility(r.Context(), r, key); err != nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "not found"})
		return
	}
	link, err := s.s3.Link(r.Context(), key)
	if err != nil {
		log.Printf("file-link: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "link error"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"url": link})
}

// checkFileVisibility проверяет, что файл с ключом принадлежит видимому фото.
func (s *Server) checkFileVisibility(ctx context.Context, r *http.Request, key string) error {
	email, _ := r.Context().Value(permEmailCtx{}).(string)
	role, err := s.effectiveRole(ctx, appIDFromEnv(), email)
	if err != nil {
		return err
	}
	// key вида photo/{uuid}/... — по uuid найти фото нельзя напрямую, поэтому
	// проверяем по thumb_key (обложки привязаны к id фото) либо по file_key точному
	// совпадению (если клиент шлёт file_key из карточки).
	if role == "admin" {
		return nil
	}
	if !s.photoExistsByKey(ctx, key, email) {
		return os.ErrNotExist
	}
	return nil
}

// photoExistsByKey — есть ли видимое фото с таким file_key или thumb_key.
func (s *Server) photoExistsByKey(ctx context.Context, key, email string) bool {
	var id int64
	err := s.pool.QueryRow(ctx,
		`SELECT id FROM photos WHERE file_key = $1 OR thumb_key = $1 LIMIT 1`, key).Scan(&id)
	if err != nil {
		return false
	}
	visible, err := s.photoVisible(ctx, id, email, "")
	if err != nil {
		return false
	}
	return visible
}

// incDownloadCount увеличивает счётчик скачиваний фото по ключу файла.
func (s *Server) incDownloadCount(ctx context.Context, key string) {
	_, _ = s.pool.Exec(ctx,
		`UPDATE photos SET download_count = download_count + 1 WHERE file_key = $1 OR thumb_key = $1`, key)
}

// validObjectKey проверяет ключ S3: разрешён только собственный префикс сервиса,
// без выхода за пределы («..») и служебных символов.
func validObjectKey(key, prefix string) bool {
	if key == "" || len(key) > 512 {
		return false
	}
	if strings.Contains(key, "..") || strings.ContainsAny(key, "\\\x00\r\n") {
		return false
	}
	return strings.HasPrefix(key, prefix+"/")
}

func parseFormInt64(r *http.Request, name string) int64 {
	var v int64
	s := r.FormValue(name)
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

// touchedAt — вспомогательная функция для обновления времени (не используется напрямую,
// оставлена для единообразия с документами).
func touchedAt() time.Time {
	return time.Now().UTC()
}
