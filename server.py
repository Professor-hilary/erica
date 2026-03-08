"""
FileShare — Real-time chat, file sharing, and server queries
=============================================================
Built with Python's built-in modules only. No pip installs.

Chat channels:
  #general   — broadcast to everyone
  #server    — query the server (uptime, memory, users, files…)
  @username  — direct message to one person

Server-Sent Events (SSE) drive real-time delivery.
ThreadingHTTPServer lets multiple SSE streams coexist.

Run:   python server.py
Open:  http://localhost:8080
       http://<your-local-ip>:8080  ← share this on the same network

WAN access options (see README):
  • Port forward 8080 on your router
  • Tailscale (recommended — free virtual LAN)
  • cloudflared tunnel --url http://localhost:8080
"""

import http.server
import socketserver
import threading
import time
import os
import json
import mimetypes
import urllib.parse
import email
import email.policy
import socket
import platform
import datetime
import ssl
import subprocess
from pathlib import Path


# ─── Configuration ────────────────────────────────────────────────────────────

PORT        = 8443          # HTTPS port (8443 is the conventional HTTPS alt-port)
HOST        = "0.0.0.0"
BASE_DIR    = Path(__file__).parent
UPLOAD_DIR  = BASE_DIR / "uploads"
STATIC_DIR  = BASE_DIR / "static"
BROWSE_ROOT = Path(os.environ.get("BROWSE_ROOT", Path.home())).resolve()
CERT_FILE   = BASE_DIR / "cert.pem"   # TLS certificate (auto-generated)
KEY_FILE    = BASE_DIR / "key.pem"    # TLS private key  (auto-generated)
MAX_HISTORY = 500
SERVER_START = time.time()


# ─── Shared state ─────────────────────────────────────────────────────────────
#
# Two structures protected by one lock:
#
#   messages       — list of every message (general + DMs together, with channel/to fields)
#   online_users   — dict of {username: [wfile, ...]}
#                    A user can have multiple browser tabs open, each gets its own wfile.
#                    We store all their wfiles so every tab stays in sync.
#
# Why a lock? This server is multi-threaded. Two requests arriving at the same
# millisecond can corrupt a list if they both try to append simultaneously.
# `with state_lock:` makes them take turns.

state_lock   = threading.Lock()
messages     = []
online_users = {}   # {username: [wfile, ...]}


# ─── Routing & broadcast ──────────────────────────────────────────────────────

def push_to_wfile(wfile, msg: dict) -> bool:
    """Write one SSE event to a single connection. Returns False if the socket is dead."""
    try:
        wfile.write(f"data: {json.dumps(msg)}\n\n".encode("utf-8"))
        wfile.flush()
        return True
    except OSError:
        return False


def broadcast_general(msg: dict):
    """Push a message to every connected user (all their tabs)."""
    dead = {}
    with state_lock:
        for username, wfiles in list(online_users.items()):
            alive = [wf for wf in wfiles if push_to_wfile(wf, msg)]
            if alive:
                online_users[username] = alive
            else:
                dead[username] = True
        for u in dead:
            del online_users[u]


def send_to_users(msg: dict, recipients: list):
    """
    Push a message to a specific list of usernames.
    Used for DMs — only the sender and recipient see it.
    """
    with state_lock:
        for username in recipients:
            if username not in online_users:
                continue
            alive = [wf for wf in online_users[username] if push_to_wfile(wf, msg)]
            if alive:
                online_users[username] = alive
            else:
                del online_users[username]


def route_and_store(msg: dict):
    """
    Decide who gets the message and persist it.
    Also triggers the server bot if the channel is 'server'.
    """
    channel = msg.get("channel", "general")

    with state_lock:
        messages.append(msg)
        if len(messages) > MAX_HISTORY:
            messages.pop(0)

    if channel == "general":
        broadcast_general(msg)
    elif channel == "dm":
        recipients = {msg["user"], msg.get("to", "")}
        send_to_users(msg, list(recipients))
    elif channel == "server":
        # Push the user's own message back to them first (they need to see it)
        send_to_users(msg, [msg["user"]])
        # Then generate and deliver the bot reply
        threading.Thread(target=server_bot_reply, args=(msg,), daemon=True).start()


# ─── Server bot ────────────────────────────────────────────────────────────────

HELP_TEXT = """Available commands:
  uptime   — how long the server has been running
  users    — who is currently online
  files    — uploaded files summary
  mem      — memory usage
  cpu      — CPU / OS info
  ip       — server IP addresses
  help     — show this message"""


def server_bot_reply(trigger_msg: dict):
    """
    Generate a response to a #server channel message.
    Runs in its own thread so it doesn't block message delivery.
    """
    cmd = trigger_msg.get("text", "").strip().lower()
    reply_text = dispatch_server_command(cmd)

    reply = {
        "id":      time.time(),
        "user":    "⬡ server",
        "text":    reply_text,
        "type":    "server-reply",
        "channel": "server",
        "time":    time.time(),
    }

    with state_lock:
        messages.append(reply)

    # Send bot reply to the requester only
    send_to_users(reply, [trigger_msg["user"]])


def dispatch_server_command(cmd: str) -> str:
    """
    Map a command string to a server stat.
    All data comes from built-in Python/OS sources — no external libraries.
    """
    # Clean command: strip leading /
    cmd = cmd.lstrip("/").strip()

    if cmd in ("help", ""):
        return HELP_TEXT

    elif cmd == "uptime":
        secs   = int(time.time() - SERVER_START)
        h, rem = divmod(secs, 3600)
        m, s   = divmod(rem, 60)
        wall   = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        return f"Server started: {datetime.datetime.fromtimestamp(SERVER_START).strftime('%Y-%m-%d %H:%M:%S')}\nUp for: {h}h {m}m {s}s\nCurrent time: {wall}"

    elif cmd == "users":
        with state_lock:
            users = list(online_users.keys())
        if not users:
            return "No users currently online."
        lines = [f"  • {u}  ({len(online_users.get(u,[]))} tab(s))" for u in users]
        return f"{len(users)} user(s) online:\n" + "\n".join(lines)

    elif cmd == "files":
        try:
            items  = list(UPLOAD_DIR.iterdir())
            files  = [f for f in items if f.is_file()]
            total  = sum(f.stat().st_size for f in files)
            recent = sorted(files, key=lambda f: f.stat().st_mtime, reverse=True)[:5]
            lines  = [f"  • {f.name}  ({_fmt_size(f.stat().st_size)})" for f in recent]
            return (
                f"{len(files)} file(s)  |  {_fmt_size(total)} total\n"
                + ("Recent:\n" + "\n".join(lines) if lines else "")
            )
        except Exception as e:
            return f"Error reading uploads: {e}"

    elif cmd == "mem":
        return _mem_info()

    elif cmd == "cpu":
        return _cpu_info()

    elif cmd == "ip":
        return _ip_info()

    else:
        # Treat unknown commands as a search across uploaded filenames
        if len(cmd) >= 2:
            matches = [
                f.name for f in UPLOAD_DIR.iterdir()
                if f.is_file() and cmd in f.name.lower()
            ]
            if matches:
                return f"Files matching '{cmd}':\n" + "\n".join(f"  • {m}" for m in matches[:20])
        return f"Unknown command: '{cmd}'\nType 'help' for a list of commands."


def _fmt_size(b: int) -> str:
    if b < 1024:        return f"{b} B"
    if b < 1048576:     return f"{b/1024:.1f} KB"
    if b < 1073741824:  return f"{b/1048576:.1f} MB"
    return f"{b/1073741824:.1f} GB"


def _mem_info() -> str:
    """Read /proc/meminfo (Linux). Fall back gracefully on other OSes."""
    try:
        meminfo = {}
        with open("/proc/meminfo") as f:
            for line in f:
                k, v = line.split(":", 1)
                meminfo[k.strip()] = v.strip()
        total = int(meminfo["MemTotal"].split()[0])
        avail = int(meminfo["MemAvailable"].split()[0])
        used  = total - avail
        pct   = used / total * 100
        return (
            f"Memory usage: {pct:.1f}%\n"
            f"  Used:  {_fmt_size(used*1024)}\n"
            f"  Free:  {_fmt_size(avail*1024)}\n"
            f"  Total: {_fmt_size(total*1024)}"
        )
    except FileNotFoundError:
        # macOS / Windows fallback
        return f"OS: {platform.system()} {platform.release()}\n(Memory details only available on Linux)"


def _cpu_info() -> str:
    info = [
        f"OS:       {platform.system()} {platform.release()}",
        f"Machine:  {platform.machine()}",
        f"Python:   {platform.python_version()}",
        f"Node:     {platform.node()}",
    ]
    try:
        with open("/proc/cpuinfo") as f:
            for line in f:
                if "model name" in line:
                    info.insert(0, "CPU:      " + line.split(":")[1].strip())
                    break
    except FileNotFoundError:
        pass
    try:
        with open("/proc/loadavg") as f:
            load = f.read().split()[:3]
            info.append(f"Load avg: {' '.join(load)} (1m, 5m, 15m)")
    except FileNotFoundError:
        pass
    return "\n".join(info)


def _ip_info() -> str:
    """Collect all non-loopback IPv4 addresses."""
    lines = []
    # Try getting the primary outbound IP
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        lines.append(f"Primary:   {s.getsockname()[0]}")
        s.close()
    except Exception:
        pass
    # All interfaces
    try:
        hostname = socket.gethostname()
        lines.append(f"Hostname:  {hostname}")
        for ip in socket.gethostbyname_ex(hostname)[2]:
            if not ip.startswith("127."):
                lines.append(f"Interface: {ip}")
    except Exception:
        pass
    lines.append(f"Port:      {PORT}")
    return "\n".join(lines) if lines else "Could not determine IP addresses."


# ─── Helpers ──────────────────────────────────────────────────────────────────

def parse_multipart(headers, body: bytes):
    content_type = headers.get("Content-Type", "")
    raw = b"Content-Type: " + content_type.encode() + b"\r\n\r\n" + body
    msg = email.message_from_bytes(raw, policy=email.policy.default)
    files = []
    for part in msg.iter_parts():
        d = part.get("Content-Disposition", "")
        if 'filename="' in d:
            filename = d.split('filename="')[1].rstrip('"')
            files.append((filename, part.get_payload(decode=True)))
    return files


def safe_resolve(base: Path, user_path: str):
    try:
        resolved = (base / user_path).resolve()
        if resolved.is_relative_to(base):
            return resolved
    except Exception:
        pass
    return None


def entry_dict(entry: Path, relative_to: Path) -> dict:
    s = entry.stat()
    return {
        "name":     entry.name,
        "type":     "dir" if entry.is_dir() else "file",
        "size":     s.st_size if entry.is_file() else None,
        "modified": s.st_mtime,
        "path":     str(entry.relative_to(relative_to)),
    }


# ─── Threading HTTP Server ────────────────────────────────────────────────────

class ThreadingHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True


# ─── Request Handler ──────────────────────────────────────────────────────────

class FileShareHandler(http.server.BaseHTTPRequestHandler):

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path   = parsed.path
        qs     = urllib.parse.parse_qs(parsed.query)

        # Static
        if path in ("/", "/index.html"):
            self.serve_static(STATIC_DIR / "index.html")
        elif path == "/manifest.json":
            self.serve_static(STATIC_DIR / "manifest.json")
        elif path == "/sw.js":
            # Service workers must be served from root scope (not /static/)
            # so browsers grant them control over the whole origin.
            self.serve_static(STATIC_DIR / "sw.js")
        elif path.startswith("/static/"):
            self.serve_static(STATIC_DIR / path[len("/static/"):])

        # Uploads
        elif path == "/api/files":
            self.api_list_files()
        elif path.startswith("/download/"):
            self.download_upload(urllib.parse.unquote(path[len("/download/"):]))
        elif path == "/view":
            self.view_file(qs.get("path", [""])[0], qs.get("src", ["upload"])[0])

        # Chat
        elif path == "/api/chat/stream":
            self.chat_stream(qs.get("user", [""])[0])
        elif path == "/api/chat/history":
            self.chat_history(qs.get("channel", ["general"])[0],
                              qs.get("peer", [""])[0],
                              qs.get("viewer", [""])[0])
        elif path == "/api/users":
            with state_lock:
                users = list(online_users.keys())
            self.send_json(200, {"users": users})

        # Browser
        elif path == "/api/browse":
            self.api_browse(qs.get("path", ["."])[0])
        elif path == "/api/search":
            self.api_search(qs.get("q", [""])[0], qs.get("path", ["."])[0])
        elif path == "/fs-download":
            self.fs_download(qs.get("path", [""])[0])

        else:
            self.send_error(404, "Not found")

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/upload":
            self.upload_file()
        elif path == "/upload/voice":
            self.upload_voice()
        elif path == "/api/chat/send":
            self.api_chat_send()
        else:
            self.send_error(404, "Not found")

    def do_DELETE(self):
        path = urllib.parse.urlparse(self.path).path
        if path.startswith("/file/"):
            self.delete_file(urllib.parse.unquote(path[len("/file/"):]))
        else:
            self.send_error(404, "Not found")

    # ── Static ────────────────────────────────────────────────────────────────

    def serve_static(self, filepath: Path):
        if not filepath.exists():
            self.send_error(404, str(filepath.name))
            return
        mime, _ = mimetypes.guess_type(str(filepath))
        data = filepath.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type",   mime or "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    # ── File management ───────────────────────────────────────────────────────

    def api_list_files(self):
        files = [
            {"name": e.name, "size": e.stat().st_size, "modified": e.stat().st_mtime}
            for e in sorted(UPLOAD_DIR.iterdir()) if e.is_file()
        ]
        self.send_json(200, files)

    def download_upload(self, filename: str):
        filepath = safe_resolve(UPLOAD_DIR, filename)
        if not filepath or not filepath.exists():
            self.send_error(404, "File not found")
            return
        mime, _ = mimetypes.guess_type(str(filepath))
        data = filepath.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type",        mime or "application/octet-stream")
        self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.send_header("Content-Length",      str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def upload_file(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        try:
            files = parse_multipart(self.headers, body)
        except Exception as e:
            self.send_json(400, {"error": str(e)})
            return
        if not files:
            self.send_json(400, {"error": "No file in request"})
            return
        saved = []
        for filename, data in files:
            if not filename:
                continue
            safe_name = Path(filename).name
            (UPLOAD_DIR / safe_name).write_bytes(data)
            saved.append({"name": safe_name, "size": len(data)})
            print(f"  ✓ Uploaded: {safe_name} ({len(data):,} bytes)")
        self.send_json(200, {"saved": saved})

    def upload_voice(self):
        """
        Receive a raw audio blob (webm/ogg from MediaRecorder) and save it.
        Unlike the multipart upload_file(), this receives the audio as a plain
        binary body — the browser sends it via fetch() with the audio MIME type.
        We generate a timestamp-based filename so clips never overwrite each other.
        """
        length   = int(self.headers.get("Content-Length", 0))
        if length == 0 or length > 10 * 1024 * 1024:   # cap at 10 MB
            self.send_json(400, {"error": "Invalid size"})
            return
        body      = self.rfile.read(length)
        mime      = self.headers.get("Content-Type", "audio/webm")
        ext       = "ogg" if "ogg" in mime else "webm"
        filename  = f"voice-{int(time.time()*1000)}.{ext}"
        filepath  = UPLOAD_DIR / filename
        filepath.write_bytes(body)
        print(f"  🎙 Voice: {filename} ({length:,} bytes)")
        self.send_json(200, {"name": filename, "size": length})

    def delete_file(self, filename: str):
        filepath = safe_resolve(UPLOAD_DIR, filename)
        if not filepath:
            self.send_error(403, "Forbidden")
            return
        if not filepath.exists():
            self.send_json(404, {"error": "Not found"})
            return
        filepath.unlink()
        self.send_json(200, {"deleted": filename})

    def view_file(self, rel_path: str, source: str):
        """Serve file inline (no attachment header) so browser can render it."""
        root = BROWSE_ROOT if source == "fs" else UPLOAD_DIR
        filepath = safe_resolve(root, rel_path)
        if not filepath or not filepath.is_file():
            self.send_error(404, "File not found")
            return
        mime, _ = mimetypes.guess_type(str(filepath))
        data = filepath.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type",   mime or "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    # ── Chat: SSE stream ──────────────────────────────────────────────────────

    def chat_stream(self, username: str):
        """
        Long-lived SSE connection. The username identifies who owns this stream.
        When the browser opens EventSource('/api/chat/stream?user=Alice'),
        this method runs for as long as Alice has the page open.

        Lifecycle:
          1. Send HTTP 200 with Content-Type: text/event-stream
          2. Register wfile in online_users[username]
          3. Replay recent history (filtered for this user)
          4. Send system "joined" broadcast
          5. Loop sending keepalive pings every 20s
          6. On disconnect (OSError), deregister and send "left" broadcast
        """
        if not username:
            self.send_error(400, "username required")
            return

        self.send_response(200)
        self.send_header("Content-Type",  "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection",    "keep-alive")
        self.end_headers()

        wfile = self.wfile

        # Register user
        with state_lock:
            if username not in online_users:
                online_users[username] = []
            online_users[username].append(wfile)
            # Recent general + this user's DMs
            recent = [m for m in messages[-80:] if _visible_to(m, username)]

        # Replay history to this client
        for msg in recent:
            if not push_to_wfile(wfile, msg):
                with state_lock:
                    if username in online_users and wfile in online_users[username]:
                        online_users[username].remove(wfile)
                return

        # Announce join to general (only if this is their first tab)
        with state_lock:
            tab_count = len(online_users.get(username, []))

        if tab_count == 1:
            join_msg = {
                "id": time.time(), "user": username,
                "text": f"{username} joined.",
                "type": "system", "channel": "general", "time": time.time(),
            }
            with state_lock:
                messages.append(join_msg)
            broadcast_general(join_msg)
            # Also send online user list update to everyone
            _broadcast_users_update()

        # Keep-alive loop
        try:
            while True:
                time.sleep(20)
                wfile.write(b": ping\n\n")
                wfile.flush()
        except OSError:
            pass
        finally:
            with state_lock:
                if username in online_users:
                    try:
                        online_users[username].remove(wfile)
                    except ValueError:
                        pass
                    if not online_users[username]:
                        del online_users[username]
                        # Announce departure
                        leave_msg = {
                            "id": time.time(), "user": username,
                            "text": f"{username} left.",
                            "type": "system", "channel": "general", "time": time.time(),
                        }
                        messages.append(leave_msg)
                        threading.Thread(
                            target=broadcast_general, args=(leave_msg,), daemon=True
                        ).start()
                        threading.Thread(
                            target=_broadcast_users_update, daemon=True
                        ).start()

    def chat_history(self, channel: str, peer: str, viewer: str):
        """
        Return messages relevant to the requesting user.
          channel=general  → all general messages
          channel=server   → server channel messages for this viewer
          channel=dm       → DMs between viewer and peer
        """
        with state_lock:
            if channel == "dm":
                subset = [
                    m for m in messages
                    if m.get("channel") == "dm"
                    and {m.get("user"), m.get("to")} == {viewer, peer}
                ]
            elif channel == "server":
                subset = [m for m in messages if m.get("channel") == "server"
                          and (m.get("user") == viewer or m.get("user") == "⬡ server")]
            else:
                subset = [m for m in messages if m.get("channel") == "general"]
        self.send_json(200, subset[-100:])

    def api_chat_send(self):
        """
        Accept a message and route it.
        Expected JSON body:
          { user, text, type, channel, to?, file? }
        """
        body    = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
        user    = str(body.get("user", "")).strip()[:32]
        text    = str(body.get("text", "")).strip()[:2000]
        channel = body.get("channel", "general")
        to      = body.get("to", "")

        if not user:
            self.send_json(400, {"error": "user required"})
            return
        if not text and not body.get("file"):
            self.send_json(400, {"error": "empty message"})
            return

        msg = {
            "id":      time.time(),
            "user":    user,
            "text":    text,
            "type":    body.get("type", "text"),
            "channel": channel,
            "to":      to,
            "time":    time.time(),
        }
        if body.get("file"):
            msg["file"] = body["file"]

        route_and_store(msg)
        self.send_json(200, {"ok": True})

    # ── Browser ───────────────────────────────────────────────────────────────

    def api_browse(self, rel_path: str):
        target = safe_resolve(BROWSE_ROOT, rel_path)
        if not target or not target.is_dir():
            self.send_json(404, {"error": "Not a directory"})
            return
        entries = []
        try:
            for entry in sorted(target.iterdir(),
                                 key=lambda e: (not e.is_dir(), e.name.lower())):
                if entry.name.startswith("."):
                    continue
                try:
                    entries.append(entry_dict(entry, BROWSE_ROOT))
                except PermissionError:
                    pass
        except PermissionError:
            self.send_json(403, {"error": "Permission denied"})
            return
        rel_display = str(target.relative_to(BROWSE_ROOT)) if target != BROWSE_ROOT else "."
        self.send_json(200, {
            "path": rel_display, "abs": str(target),
            "root": str(BROWSE_ROOT), "can_go_up": target != BROWSE_ROOT,
            "entries": entries,
        })

    def api_search(self, term: str, rel_path: str):
        if not term.strip():
            self.send_json(400, {"error": "Search term required"})
            return
        target = safe_resolve(BROWSE_ROOT, rel_path)
        if not target:
            self.send_json(403, {"error": "Access denied"})
            return
        results, MAX = [], 200
        tl = term.lower()
        for root, dirs, files in os.walk(target):
            dirs[:] = [d for d in dirs if not d.startswith(".")]
            rp = Path(root)
            for name in dirs + files:
                if tl in name.lower():
                    try:
                        results.append(entry_dict(rp / name, BROWSE_ROOT))
                    except (PermissionError, FileNotFoundError):
                        pass
                if len(results) >= MAX:
                    break
            if len(results) >= MAX:
                break
        self.send_json(200, {"results": results, "term": term, "capped": len(results) >= MAX})

    def fs_download(self, rel_path: str):
        filepath = safe_resolve(BROWSE_ROOT, rel_path)
        if not filepath or not filepath.is_file():
            self.send_error(404, "File not found")
            return
        mime, _ = mimetypes.guess_type(str(filepath))
        data = filepath.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type",        mime or "application/octet-stream")
        self.send_header("Content-Disposition", f'attachment; filename="{filepath.name}"')
        self.send_header("Content-Length",      str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    # ── Utilities ─────────────────────────────────────────────────────────────

    def send_json(self, status: int, data):
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type",   "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        # Suppress keepalive noise but keep useful logs
        msg = fmt % args
        if "ping" not in msg:
            print(f"  [{self.address_string()}] {msg}")


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _visible_to(msg: dict, username: str) -> bool:
    """Decide whether a stored message should be replayed to a connecting user."""
    ch = msg.get("channel", "general")
    if ch == "general":
        return True
    if ch == "dm":
        return username in {msg.get("user"), msg.get("to")}
    if ch == "server":
        return msg.get("user") in (username, "⬡ server")
    return False


def _broadcast_users_update():
    """Push the current user list to all connected clients."""
    with state_lock:
        users = list(online_users.keys())
    update_msg = {
        "id":   time.time(),
        "type": "users-update",
        "users": users,
        "time": time.time(),
    }
    broadcast_general(update_msg)


# ─── Entry point ──────────────────────────────────────────────────────────────

def get_all_ips() -> list[tuple[str, str]]:
    """
    Return every non-loopback IPv4 address on this machine, with its
    interface name where available.

    Why enumerate all of them?
    A machine with a Wi-Fi card, an Ethernet port, AND a mobile hotspot
    has at least three different IP addresses — one per interface.
    Devices on different physical networks reach the server on different IPs.

    Strategy:
      1. socket.getaddrinfo() is the most portable call — works on Windows,
         macOS, and Linux without any external library.
      2. We supplement with a UDP trick to find the "primary" outbound IP.
    """
    seen   = set()
    result = []

    # Primary outbound IP (usually the "best" one to share)
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))          # doesn't actually send data
        primary = s.getsockname()[0]
        s.close()
        if not primary.startswith("127."):
            seen.add(primary)
            result.append(("primary", primary))
    except Exception:
        pass

    # All interface addresses via hostname resolution
    try:
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None, socket.AF_INET):
            ip = info[4][0]
            if ip not in seen and not ip.startswith("127."):
                seen.add(ip)
                result.append(("interface", ip))
    except Exception:
        pass

    return result


def ensure_tls_cert() -> ssl.SSLContext:
    """
    Generate a self-signed TLS certificate if one doesn't already exist,
    then return a configured SSLContext ready to wrap our server socket.

    Why self-signed?
    Proper CA-signed certs require a publicly reachable domain name (or a
    paid CA). For LAN use, self-signed is the only option — and it's
    perfectly secure for a private network. The browser will show a warning
    on the *first* visit; you click "Advanced → Proceed" once, and that's it.
    The warning appears because the cert isn't signed by a trusted CA, not
    because anything is actually wrong with the connection.

    Certificate lifetime: 10 years. Regenerate by deleting cert.pem/key.pem
    and restarting the server.

    SAN (Subject Alternative Name): we add every local IP we can find so the
    browser warning appears only for IPs we didn't include. Without SAN, modern
    browsers reject the cert entirely for IP addresses (CN alone isn't enough).
    """
    if not CERT_FILE.exists() or not KEY_FILE.exists():
        print("  Generating TLS certificate (first run only)…")

        # Collect all local IPs for the SAN extension
        ip_list = [ip for _, ip in get_all_ips()]
        ip_list.insert(0, "127.0.0.1")
        san = ", ".join(f"IP:{ip}" for ip in ip_list) or "IP:127.0.0.1"

        # Write a minimal OpenSSL config with SAN support
        openssl_conf = BASE_DIR / "_openssl.cnf"
        openssl_conf.write_text(
            "[req]\n"
            "distinguished_name = req_dn\n"
            "x509_extensions    = v3_req\n"
            "prompt             = no\n"
            "[req_dn]\n"
            "CN = fileshare-lan\n"
            "[v3_req]\n"
            "subjectAltName = " + san + "\n"
            "basicConstraints = CA:FALSE\n"
            "keyUsage = digitalSignature, keyEncipherment\n"
            "extendedKeyUsage = serverAuth\n"
        )

        subprocess.run([
            "openssl", "req", "-x509", "-newkey", "rsa:2048",
            "-keyout", str(KEY_FILE),
            "-out",    str(CERT_FILE),
            "-days",   "3650",
            "-nodes",
            "-config", str(openssl_conf),
        ], check=True, capture_output=True)

        openssl_conf.unlink()
        print(f"  Certificate written to {CERT_FILE.name} / {KEY_FILE.name}")

    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(str(CERT_FILE), str(KEY_FILE))
    return ctx


def print_banner(ips: list[tuple[str, str]]):
    """Print a startup banner — now showing https:// URLs."""
    print(f"\n  ⬡  FileShare ─────────────────────────")
    print(f"  Localhost  →  https://localhost:{PORT}")
    if ips:
        print(f"  Network addresses — share any of these:")
        for _, ip in ips:
            print(f"    https://{ip}:{PORT}")
    else:
        print(f"  ⚠  No network interfaces found — only localhost works.")
    print()
    print(f"  ⚠  FIRST VISIT: your browser will warn about the self-signed")
    print(f"     certificate. Click Advanced → Proceed (or Accept the Risk).")
    print(f"     This is normal for LAN HTTPS — the connection is still encrypted.")
    print(f"     You only need to do this once per device.")
    print()
    print(f"  Firewall:   sudo ufw allow {PORT}/tcp")
    print(f"  WAN:        Tailscale (recommended) or")
    print(f"              cloudflared tunnel --url https://localhost:{PORT}")
    print(f"  Browse:     {BROWSE_ROOT}")
    print(f"  Ctrl+C to stop\n")


if __name__ == "__main__":
    UPLOAD_DIR.mkdir(exist_ok=True)
    ips = get_all_ips()

    try:
        ssl_ctx = ensure_tls_cert()
    except Exception as e:
        print(f"  ✗ Could not generate TLS certificate: {e}")
        print(f"  Falling back to plain HTTP (PWA and microphone won't work on LAN).")
        ssl_ctx = None

    print_banner(ips)

    server = ThreadingHTTPServer((HOST, PORT), FileShareHandler)
    if ssl_ctx:
        # Wrap the raw TCP socket with TLS before the server starts accepting
        server.socket = ssl_ctx.wrap_socket(server.socket, server_side=True)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  Stopped.\n")
        server.server_close()
