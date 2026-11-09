#!/bin/zsh
# Build a throwaway demo home for recording the README clips.
#
# Usage: setup-demo.sh DEMO_DIR
#
# DEMO_DIR becomes $HOME for Claude Code, jarvis and memory-mcp while recording,
# so the clips show only the demo repo below, never your real sessions, ledger
# or memories. ~/Library/Keychains is linked in so Claude Code finds your login.
set -euo pipefail

DEMO=${1:?usage: setup-demo.sh DEMO_DIR}
JARVIS=${JARVIS_DIR:-$(cd "$(dirname "$0")/../../.." && pwd)}
REAL_HOME=$HOME

[[ -d $DEMO ]] && rm -rf -- "$DEMO"
mkdir -p "$DEMO/Library" "$DEMO/.claude" "$DEMO/.local/bin" "$DEMO/todo-api"
ln -s "$REAL_HOME/Library/Keychains" "$DEMO/Library/Keychains"
ln -s "$(command -v memory-mcp || echo "$REAL_HOME/.local/bin/memory-mcp")" "$DEMO/.local/bin/memory-mcp"

cat > "$DEMO/.claude/settings.json" <<JSON
{
  "env": { "CLAUDE_CODE_PLUGIN_DIRS": "$JARVIS", "JARVIS_LANG": "en" },
  "skipDangerousModePermissionPrompt": true
}
JSON

# the file an approved routing lesson is written to
mkdir -p "$DEMO/dotfiles/claude/skills/model-routing"
cat > "$DEMO/dotfiles/claude/skills/model-routing/SKILL.md" <<'MD'
# Model routing

- Explore: find files and symbols.
- general-purpose: multi-step work.
MD

# the demo repo: a tiny Go todo API with a short history
cd "$DEMO/todo-api"
git init -q -b main
git config user.name Demo
git config user.email demo@example.com
mkdir -p cmd/server internal/todo
cat > go.mod <<'GO'
module example.com/todo-api

go 1.22
GO
cat > internal/todo/store.go <<'GO'
package todo

import (
	"errors"
	"sync"
)

// Todo is one item on the list.
type Todo struct {
	ID    int    `json:"id"`
	Title string `json:"title"`
	Done  bool   `json:"done"`
}

// ErrNotFound is returned when no todo has the given id.
var ErrNotFound = errors.New("todo not found")

// Store keeps todos in memory.
type Store struct {
	mu    sync.Mutex
	next  int
	items map[int]Todo
}

func NewStore() *Store { return &Store{next: 1, items: map[int]Todo{}} }

func (s *Store) Add(title string) Todo {
	s.mu.Lock()
	defer s.mu.Unlock()
	t := Todo{ID: s.next, Title: title}
	s.items[t.ID] = t
	s.next++
	return t
}

func (s *Store) Get(id int) (Todo, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	t, ok := s.items[id]
	if !ok {
		return Todo{}, ErrNotFound
	}
	return t, nil
}

func (s *Store) List() []Todo {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Todo, 0, len(s.items))
	for id := 1; id < s.next; id++ {
		if t, ok := s.items[id]; ok {
			out = append(out, t)
		}
	}
	return out
}
GO
cat > internal/todo/store_test.go <<'GO'
package todo

import "testing"

func TestAddAndGet(t *testing.T) {
	s := NewStore()
	a := s.Add("write docs")
	got, err := s.Get(a.ID)
	if err != nil || got.Title != "write docs" {
		t.Fatalf("Get(%d) = %+v, %v", a.ID, got, err)
	}
}
GO
GIT_AUTHOR_DATE="2026-11-02T10:00:00" GIT_COMMITTER_DATE="2026-11-02T10:00:00" git add -A
GIT_AUTHOR_DATE="2026-11-02T10:00:00" GIT_COMMITTER_DATE="2026-11-02T10:00:00" git commit -qm "feat: in-memory todo store"
cat > internal/todo/handler.go <<'GO'
package todo

import (
	"encoding/json"
	"net/http"
	"strconv"
)

// Handler serves the todo routes.
type Handler struct{ Store *Store }

func (h Handler) Routes(mux *http.ServeMux) {
	mux.HandleFunc("GET /todos", h.list)
	mux.HandleFunc("POST /todos", h.create)
	mux.HandleFunc("GET /todos/{id}", h.get)
}

func (h Handler) list(w http.ResponseWriter, r *http.Request) {
	json.NewEncoder(w).Encode(h.Store.List())
}

func (h Handler) create(w http.ResponseWriter, r *http.Request) {
	var in struct{ Title string }
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil || in.Title == "" {
		http.Error(w, "title required", http.StatusBadRequest)
		return
	}
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(h.Store.Add(in.Title))
}

func (h Handler) get(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.Atoi(r.PathValue("id"))
	if err != nil {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	t, err := h.Store.Get(id)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	json.NewEncoder(w).Encode(t)
}
GO
cat > cmd/server/main.go <<'GO'
package main

import (
	"log"
	"net/http"

	"example.com/todo-api/internal/todo"
)

func main() {
	mux := http.NewServeMux()
	todo.Handler{Store: todo.NewStore()}.Routes(mux)
	log.Println("listening on :8080")
	log.Fatal(http.ListenAndServe(":8080", mux))
}
GO
GIT_AUTHOR_DATE="2026-11-03T15:30:00" GIT_COMMITTER_DATE="2026-11-03T15:30:00" git add -A
GIT_AUTHOR_DATE="2026-11-03T15:30:00" GIT_COMMITTER_DATE="2026-11-03T15:30:00" git commit -qm "feat: HTTP handlers and server"
printf '# todo-api\n\nA tiny in-memory todo API.\n' > README.md
GIT_AUTHOR_DATE="2026-11-04T09:10:00" GIT_COMMITTER_DATE="2026-11-04T09:10:00" git add -A
GIT_AUTHOR_DATE="2026-11-04T09:10:00" GIT_COMMITTER_DATE="2026-11-04T09:10:00" git commit -qm "docs: readme"

# one headless call creates .claude.json (and checks the login), then skip onboarding
"$JARVIS/docs/media/record/demo-env.sh" "$DEMO" claude -p "reply with the single word: ok" </dev/null >/dev/null
python3 -I - "$DEMO" <<'PY'
import json, sys
demo = sys.argv[1]
path = f"{demo}/.claude.json"
d = json.load(open(path))
# diffSidebarOpen: keep Claude Code's own diff sidebar from taking the dock the pane sits in
d.update(hasCompletedOnboarding=True, theme="dark", bypassPermissionsModeAccepted=True, diffSidebarOpen=False)
d.setdefault("projects", {})[f"{demo}/todo-api"] = {"hasTrustDialogAccepted": True, "hasCompletedProjectOnboarding": True}
json.dump(d, open(path, "w"))
PY
echo "demo home ready: $DEMO"
