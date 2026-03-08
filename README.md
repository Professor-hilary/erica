# ⬡ FileShare

A real-time file sharing and chat server that runs on your own machine and is
accessible from any device on your local network — no cloud, no accounts, no
subscription. Built entirely with Python's standard library and vanilla
JavaScript.

---

## Features

- **Real-time group chat** — messages delivered instantly via Server-Sent Events
- **Direct messages** — private conversations visible only to the two participants
- **#server channel** — query the host machine for stats (uptime, memory, CPU, IPs, files)
- **Voice messages** — hold the mic button to record, release to send; custom audio player
- **File sharing** — upload from any device, share to any channel, download or delete
- **File browser** — navigate the host machine's filesystem; list or grid view
- **Progressive Web App** — installable from the browser, launches like a native app
- **HTTPS** — self-signed certificate auto-generated at first startup; mic and PWA require it
- **Mobile-first layout** — fixed bottom navigation bar, slide-up drawer, `100dvh` viewport

---

## Requirements

- Python 3.10 or later (uses `match` type hints; no earlier version works)
- OpenSSL — for certificate generation on first run (`openssl` must be on your PATH)
- A modern browser on each device (Chrome 90+, Firefox 90+, Safari 15+)

No `pip install` is needed. Every dependency is part of Python's standard library.

---

## Getting Started

```bash
# 1. Clone or copy the project folder to your machine
cd fileshare

# 2. Run the server
python server.py
```

On first run the server generates a TLS certificate (`cert.pem` / `key.pem`) and
prints every address it is reachable on:

```
  ⬡  FileShare ─────────────────────────
  Localhost  →  https://localhost:8443
  Network addresses — share any of these:
    https://192.168.1.42:8443
    https://192.168.137.1:8443

  ⚠  FIRST VISIT: your browser will warn about the self-signed
     certificate. Click Advanced → Proceed (or Accept the Risk).
     This is normal for LAN HTTPS — the connection is still encrypted.
     You only need to do this once per device.
```

Open the address shown in your browser. Share the network address with anyone
on the same Wi-Fi or hotspot.

---

## Firewall

The server listens on port **8443**. If other devices cannot connect, your OS
firewall is likely blocking it.

```bash
# Linux (ufw)
sudo ufw allow 8443/tcp

# Linux (firewalld)
sudo firewall-cmd --add-port=8443/tcp --permanent
sudo firewall-cmd --reload

# macOS — usually no action needed; confirm via System Settings → Firewall

# Windows (PowerShell as Administrator)
New-NetFirewallRule -DisplayName "FileShare 8443" `
  -Direction Inbound -Protocol TCP -LocalPort 8443 -Action Allow -Profile Any
```

---

## Network Access

| Scenario | How |
|---|---|
| Same Wi-Fi / LAN | Use the IP printed at startup — works immediately after the firewall step |
| Mobile hotspot from PC | Run `ip addr show` (Linux) or `ipconfig` (Windows) and look for the hotspot adapter's IP — it's separate from your Wi-Fi IP |
| Internet (WAN) | See options below |

### WAN options

**Tailscale** (recommended for personal use — free, zero router config):
```bash
# Install Tailscale, then:
tailscale up
# Share your Tailscale IP with the other person — they need Tailscale too
```

**cloudflared tunnel** (gives a public HTTPS URL, no account needed for quick use):
```bash
cloudflared tunnel --url https://localhost:8443
# Prints a public URL like https://xxxx.trycloudflare.com
```

**Port forwarding** — forward external TCP port 8443 to your machine's local IP in
your router's admin panel. Your public IP is shown by `curl ifconfig.me`.

---

## Installing as a PWA

Because the server uses HTTPS, browsers can install it as a standalone app:

- **Android (Chrome)** — tap the three-dot menu → *Add to Home Screen*, or wait
  for the install banner that appears automatically after a few visits.
- **iOS (Safari)** — tap the Share icon → *Add to Home Screen*.
- **Desktop (Chrome/Edge)** — click the install icon in the address bar.

The app will launch fullscreen without any browser chrome, just like a native app.

**Note:** The self-signed certificate warning appears once per device. After you
accept it the browser remembers and won't ask again for this cert's lifetime
(10 years).

---

## Using the #server channel

Switch to the **⬡ server** channel in the sidebar and type any of these commands:

| Command | What it returns |
|---|---|
| `help` | List of all commands |
| `uptime` | How long the server has been running |
| `users` | Who is currently online and how many tabs they have open |
| `files` | Uploaded file count, total size, and five most recent files |
| `mem` | Memory usage (Linux only; falls back gracefully on macOS/Windows) |
| `cpu` | OS, architecture, Python version, CPU model, load averages |
| `ip` | All network addresses the server is reachable on |
| anything else | Treated as a filename search in the uploads folder |

Server replies are private — only you see them.

---

## Voice Messages

1. Navigate to any channel or DM.
2. **Hold** the 🎙 button. The button pulses red while recording.
3. **Release** to send. The audio uploads and appears as a player bubble.

The custom player shows playback position and duration and works consistently
across all browsers. The native `<audio controls>` widget was replaced because
its appearance varies dramatically between platforms.

**Microphone permission** — the browser will ask for mic access the first time.
This only works over HTTPS (which the server now provides). On subsequent
visits the browser remembers your choice.

---

## File Structure

```
fileshare/
├── server.py            ← Python backend — run this
├── cert.pem             ← TLS certificate (auto-generated on first run)
├── key.pem              ← TLS private key  (auto-generated on first run)
├── uploads/             ← Uploaded files are stored here (auto-created)
└── static/
    ├── index.html       ← App shell and all HTML
    ├── style.css        ← All styles (dark industrial theme)
    ← script.js        ← All frontend logic
    ├── manifest.json    ← PWA manifest
    ├── sw.js            ← Service worker (offline caching)
    ├── icon-192.png     ← PWA icon
    └── icon-512.png     ← PWA icon (large)
```

---

## Architecture Notes

**Why no pip?** The goal was a server you can run on any machine with just
`python server.py` — no virtual environments, no dependency management, no
version conflicts. Everything used (`http.server`, `ssl`, `threading`,
`socketserver`, `email`, `pathlib`, `socket`) ships with Python.

**Server-Sent Events (SSE)** push messages from server to browser over a
long-lived HTTP connection. The browser's `EventSource` API handles
reconnection automatically if the connection drops. SSE is one-directional
(server → client only); browsers send messages back via regular `fetch` POST
requests to `/api/chat/send`.

**ThreadingHTTPServer** is required because each SSE connection occupies a
thread indefinitely. Python's default `HTTPServer` is single-threaded — the
first SSE client would block everyone else. `ThreadingMixIn` spawns a new
thread per connection, each sleeping on a 20-second keepalive loop.

**TLS / HTTPS** is implemented by wrapping the server socket with
`ssl.SSLContext.wrap_socket()` before `serve_forever()` is called. The cert is
generated by shelling out to `openssl` with a config that embeds all local IPs
as Subject Alternative Names — without SAN, modern browsers reject bare-IP
certificates even if the CN field matches.

**Message routing** has three paths: `broadcast_general()` fans out to every
connected wfile; `send_to_users()` targets specific usernames (used for DMs
and server-bot replies); `route_and_store()` decides which path a message takes
based on its `channel` field (`general`, `dm`, or `server`), persists it to
the in-memory list, and calls the appropriate function.

---

## Security Notes

This server is designed for **trusted local networks** — a home network,
a hotspot between friends, or a LAN party. It has no authentication, no user
accounts, and no access control. Anyone who can reach the port can read all
messages, download all files, and browse the host filesystem.

Do not expose it to the public internet without adding authentication first.
The WAN options listed above (Tailscale in particular) are appropriate because
they require the other party to also be authenticated to your Tailscale network.

The self-signed certificate encrypts the connection (nobody on the network can
read traffic in transit) but does not verify identity — anyone could generate a
certificate with the same CN. For a private LAN this is an acceptable trade-off.

---

## Resetting the Certificate

If you change machines, add a new network interface, or just want a fresh cert:

```bash
rm cert.pem key.pem
python server.py   # generates a new cert on startup
```

You will need to accept the new certificate warning on each device again.

---

## Changing the Port or Browse Root

Edit the constants at the top of `server.py`:

```python
PORT        = 8443          # change to any free port
BROWSE_ROOT = Path.home()   # change to any directory you want to expose
```

Or set `BROWSE_ROOT` via environment variable without editing the file:

```bash
BROWSE_ROOT=/media/external python server.py
```
