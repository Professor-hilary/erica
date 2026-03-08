# 🗂 FileShare — A Beginner's Python Web Project

A practical file-sharing web app built with **Python's built-in modules only**.
No pip installs. No frameworks. Just Python, HTML, CSS, and JavaScript.

---

## How to Run

```bash
python server.py
```
Then open **http://localhost:8080** in your browser.

---

## Project Structure

```
fileshare/
├── server.py           ← Python backend (the "server")
├── static/
│   ├── index.html      ← Page structure
│   ├── style.css       ← Visual design
│   └── script.js       ← Frontend interactivity
└── uploads/            ← Where your files are saved (auto-created)
```

---

## What You Can Learn From Each File

### `server.py` — Python & HTTP concepts
| Concept | Where |
|---|---|
| Classes and inheritance | `class FileShareHandler(BaseHTTPRequestHandler)` |
| Reading the filesystem | `UPLOAD_DIR.iterdir()`, `Path`, `os` |
| HTTP methods (GET, POST, DELETE) | `do_GET`, `do_POST`, `do_DELETE` |
| Routing (URL → function) | `if path == "/api/files"` blocks |
| JSON as an API format | `json.dumps()`, `self.send_json()` |
| File I/O | `.read_bytes()`, `.write_bytes()`, `.unlink()` |
| Security (path traversal) | `filepath.resolve().is_relative_to(...)` |
| Parsing multipart form data | `parse_multipart()` using `email` module |

### `static/index.html` — HTML fundamentals
| Concept | Where |
|---|---|
| Semantic structure | `<header>`, `<main>`, `<section>`, `<footer>` |
| Linking CSS and JS | `<link>` and `<script>` tags |
| Hidden inputs | `<input type="file" hidden>` |
| IDs for JS targeting | `id="uploadZone"`, `id="fileList"` etc. |

### `static/style.css` — CSS concepts
| Concept | Where |
|---|---|
| CSS variables | `:root { --accent: #e8a835; }` |
| Flexbox layout | `display: flex` on header, buttons |
| CSS Grid | `grid-template-columns` on `.file-row` |
| Transitions & animations | `transition: ...`, `@keyframes fadeIn` |
| Pseudo-classes | `:hover`, `:nth-child()` |
| Responsive design | `@media (max-width: 540px)` |

### `static/script.js` — JavaScript concepts
| Concept | Where |
|---|---|
| DOM selection | `document.getElementById()` |
| Event listeners | `.addEventListener('click', ...)` |
| Async/await | `async function loadFiles()` |
| Fetch API | `fetch('/api/files')` |
| FormData for uploads | `new FormData()` |
| XMLHttpRequest for progress | `xhr.upload.onprogress` |
| Drag-and-drop events | `dragenter`, `dragover`, `drop` |
| String template literals | `` `<div>${file.name}</div>` `` |

---

## Python Modules Used (all built-in)

| Module | Purpose |
|---|---|
| `http.server` | Creates the web server |
| `pathlib` | File path operations (cleaner than `os.path`) |
| `json` | Encode/decode JSON data |
| `mimetypes` | Guess file type from extension |
| `urllib.parse` | Decode URL-encoded strings |
| `email` | Parse multipart form data |
| `os` | Low-level file system access |

---

## Good Questions to Ask While Learning

1. What happens if you visit `/api/files` directly in the browser?
2. What does the server print in the terminal when you upload a file?
3. What is a "status code"? What does 200, 404, and 403 mean?
4. Why is the `<script>` tag at the bottom of the HTML, not the top?
5. What is a CSS variable? How would you change the accent colour?
6. What is the difference between `fetch()` and `XMLHttpRequest`?
7. What would happen if you removed the security check in `download_file()`?
8. Why do we use `async`/`await` in JavaScript?
