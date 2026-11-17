package main

import (
	"crypto/rand"
	"embed"
	"encoding/hex"
	"encoding/json"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
)

//go:embed web
var webFS embed.FS

var (
	dataDir    string
	imagesDir  string
	sessionDir string
	fileMu     sync.Mutex
	safeName   = regexp.MustCompile(`^[A-Za-z0-9_\-]+(\.[A-Za-z0-9]+)?$`)
)

func initDirs() error {
	base, err := os.UserConfigDir()
	if err != nil || base == "" {
		base = "."
	}
	if v := os.Getenv("RANDOMIZER_DATA"); v != "" {
		base = v
	}
	dataDir = filepath.Join(base, "Randomizer")
	imagesDir = filepath.Join(dataDir, "images")
	sessionDir = filepath.Join(dataDir, "sessions")
	for _, d := range []string{dataDir, imagesDir, sessionDir} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return err
		}
	}
	return nil
}

func randomID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// writeAtomic writes data to a temp file and renames it into place so a crash
// never leaves a half-written library.
func writeAtomic(path string, data []byte) error {
	fileMu.Lock()
	defer fileMu.Unlock()
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func readJSONBody(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 64<<20))
	if err != nil || !json.Valid(body) {
		http.Error(w, "invalid JSON", http.StatusBadRequest)
		return nil, false
	}
	return body, true
}

func sessionPath(id string) (string, bool) {
	if !safeName.MatchString(id) || strings.Contains(id, ".") {
		return "", false
	}
	return filepath.Join(sessionDir, id+".json"), true
}

func newHandler() http.Handler {
	mux := http.NewServeMux()

	static, _ := fs.Sub(webFS, "web")
	mux.Handle("/", http.FileServer(http.FS(static)))

	libraryPath := func() string { return filepath.Join(dataDir, "library.json") }

	mux.HandleFunc("/api/library", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			data, err := os.ReadFile(libraryPath())
			if err != nil {
				data = []byte(`{"collections":[]}`)
			}
			w.Header().Set("Content-Type", "application/json")
			w.Write(data)
		case http.MethodPut:
			body, ok := readJSONBody(w, r)
			if !ok {
				return
			}
			if err := writeAtomic(libraryPath(), body); err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			w.WriteHeader(http.StatusNoContent)
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})

	// Upload an image or sound file: raw bytes in the body, original file name in ?name=.
	mux.HandleFunc("/api/images", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		ext := strings.ToLower(filepath.Ext(r.URL.Query().Get("name")))
		switch ext {
		case ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".avif",
			".mp3", ".wav", ".ogg", ".oga", ".m4a", ".aac", ".flac", ".webm":
		default:
			http.Error(w, "unsupported file type", http.StatusBadRequest)
			return
		}
		data, err := io.ReadAll(io.LimitReader(r.Body, 50<<20))
		if err != nil || len(data) == 0 {
			http.Error(w, "empty upload", http.StatusBadRequest)
			return
		}
		name := randomID() + ext
		if err := os.WriteFile(filepath.Join(imagesDir, name), data, 0o644); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"file": name})
	})

	mux.HandleFunc("/img/", func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimPrefix(r.URL.Path, "/img/")
		if !safeName.MatchString(name) {
			http.NotFound(w, r)
			return
		}
		// File names are random and never reused, so they can be cached forever.
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		http.ServeFile(w, r, filepath.Join(imagesDir, name))
	})

	// Saved sessions: list all, or get/put/delete one by id.
	mux.HandleFunc("/api/sessions", func(w http.ResponseWriter, r *http.Request) {
		entries, _ := os.ReadDir(sessionDir)
		list := []json.RawMessage{}
		for _, e := range entries {
			if e.IsDir() || filepath.Ext(e.Name()) != ".json" {
				continue
			}
			data, err := os.ReadFile(filepath.Join(sessionDir, e.Name()))
			if err == nil && json.Valid(data) {
				list = append(list, data)
			}
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(list)
	})
	mux.HandleFunc("/api/sessions/", func(w http.ResponseWriter, r *http.Request) {
		path, ok := sessionPath(strings.TrimPrefix(r.URL.Path, "/api/sessions/"))
		if !ok {
			http.Error(w, "bad session id", http.StatusBadRequest)
			return
		}
		switch r.Method {
		case http.MethodPut:
			body, ok := readJSONBody(w, r)
			if !ok {
				return
			}
			if err := writeAtomic(path, body); err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			w.WriteHeader(http.StatusNoContent)
		case http.MethodDelete:
			os.Remove(path)
			w.WriteHeader(http.StatusNoContent)
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})

	return mux
}

// startServer listens on a random loopback port and returns the base URL.
func startServer(addr string) (string, error) {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return "", err
	}
	go http.Serve(ln, newHandler())
	return "http://" + ln.Addr().String() + "/", nil
}
