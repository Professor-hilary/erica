/**
 * script.js — FileShare
 * ======================
 * Sections:
 *   0. PWA / Service Worker registration
 *   1. Forward declarations (prevent TDZ crashes)
 *   2. Utilities
 *   3. Identity
 *   4. Navigation (showChannel, badges, bottom nav, drawer)
 *   5. Chat engine (SSE, send, render, voice)
 *   6. Voice recording (MediaRecorder API)
 *   7. File options modal
 *   8. File viewer modal
 *   9. Files tab
 *  10. Browser tab
 */

// ════════════════════════════════════════════════════════════════════════════
// 0. PWA — SERVICE WORKER REGISTRATION
// ════════════════════════════════════════════════════════════════════════════

/*
 * A Service Worker is a script that runs in the browser background, separate
 * from the page. It intercepts network requests and can cache responses,
 * enabling offline use and the "Add to Home Screen" (PWA) install prompt.
 *
 * We register it here — the browser downloads sw.js, installs it, and from
 * then on it controls this page. The registration is idempotent: safe to call
 * on every page load.
 *
 * 'serviceWorker' in navigator — feature-detect before calling, since some
 * older or privacy-hardened browsers don't support it.
 */
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').then(reg => {
    console.log('[PWA] Service worker registered, scope:', reg.scope);
  }).catch(err => {
    console.warn('[PWA] Service worker registration failed:', err);
  });
}

// ════════════════════════════════════════════════════════════════════════════
// 1. FORWARD DECLARATIONS
// ════════════════════════════════════════════════════════════════════════════

/*
 * `let` variables have a Temporal Dead Zone (TDZ): the engine knows they
 * exist (they are "hoisted") but you cannot read or write them until their
 * declaration line executes. Accessing them before that throws:
 *   ReferenceError: can't access lexical declaration '...' before initialisation
 *
 * applyUsername() is called at top-level during Identity setup (section 3),
 * which triggers initSSE() before the engine reaches section 5 where
 * evtSource would naturally live. Declaring it here avoids the TDZ crash.
 *
 * browserReady is used in showChannel() (section 4) but would be declared
 * in section 10 — same problem.
 */
let evtSource;              // Assigned in initSSE()
let browserReady = false;   // Read in showChannel(), written in browseTo()

// ════════════════════════════════════════════════════════════════════════════
// 2. UTILITIES
// ════════════════════════════════════════════════════════════════════════════

const FILE_ICONS = {
  pdf:'📄', doc:'📝', docx:'📝', txt:'📃', md:'📃',
  xls:'📊', xlsx:'📊', csv:'📊', ppt:'📊', pptx:'📊',
  jpg:'🖼', jpeg:'🖼', png:'🖼', gif:'🖼', webp:'🖼', svg:'🖼',
  mp3:'🎵', wav:'🎵', flac:'🎵', ogg:'🎵',
  mp4:'🎬', webm:'🎬', mov:'🎬', avi:'🎬',
  js:'🟨', py:'🐍', html:'🌐', css:'🎨', json:'📦', ts:'🔷',
  zip:'🗜', tar:'🗜', gz:'🗜', rar:'🗜',
};

function getIcon(name, isDir=false) {
  if (isDir) return '📁';
  const ext = name.split('.').pop().toLowerCase();
  return FILE_ICONS[ext] || '📄';
}

function fmtSize(b) {
  if (b==null)       return '—';
  if (b<1024)        return b+' B';
  if (b<1048576)     return (b/1024).toFixed(1)+' KB';
  if (b<1073741824)  return (b/1048576).toFixed(1)+' MB';
  return (b/1073741824).toFixed(1)+' GB';
}

function fmtTime(ts) {
  const d   = new Date(ts * 1000);
  const now = new Date();
  return d.toDateString() === now.toDateString()
    ? d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})
    : d.toLocaleDateString([], {month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'});
}

function esc(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function ea(s) {
  return String(s).replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/"/g,'&quot;');
}

const toastEl = document.getElementById('toast');
let toastTimer;
function toast(msg, type='info') {
  toastEl.textContent = msg;
  toastEl.className = `toast ${type} show`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.className = 'toast'; }, 3000);
}

// ════════════════════════════════════════════════════════════════════════════
// 3. IDENTITY
// ════════════════════════════════════════════════════════════════════════════

const usernameOverlay  = document.getElementById('usernameOverlay');
const usernameInput    = document.getElementById('usernameInput');
const joinBtn          = document.getElementById('joinBtn');
const meAvatar         = document.getElementById('meAvatar');
const meName           = document.getElementById('meName');
const meAvatarMobile   = document.getElementById('meAvatarMobile');
const meNameMobile     = document.getElementById('meNameMobile');
const renameBtn        = document.getElementById('renameBtn');
const renameBtnMobile  = document.getElementById('renameBtnMobile');

let myUsername = localStorage.getItem('fileshare_user') || '';

function applyUsername(name) {
  myUsername = name.trim();
  localStorage.setItem('fileshare_user', myUsername);
  const initial = myUsername[0].toUpperCase();
  meAvatar.textContent       = initial;
  meName.textContent         = myUsername;
  meAvatarMobile.textContent = initial;
  meNameMobile.textContent   = myUsername;
  usernameOverlay.classList.add('hidden');
  initSSE();
}

if (myUsername) {
  applyUsername(myUsername);
} else {
  usernameOverlay.classList.remove('hidden');
}

joinBtn.addEventListener('click', () => {
  const v = usernameInput.value.trim();
  if (v) applyUsername(v);
  else usernameInput.focus();
});
usernameInput.addEventListener('keydown', e => { if (e.key==='Enter') joinBtn.click(); });

function triggerRename() {
  usernameInput.value = myUsername;
  usernameOverlay.classList.remove('hidden');
  usernameInput.focus();
  usernameInput.select();
}
renameBtn.addEventListener('click', triggerRename);
renameBtnMobile.addEventListener('click', () => { closeDrawer(); triggerRename(); });

// ════════════════════════════════════════════════════════════════════════════
// 4. NAVIGATION
// ════════════════════════════════════════════════════════════════════════════

let activeChannel = { type:'channel', name:'general' };
const unread = {};

function getKey(ch) {
  if (ch.type==='dm')  return `dm:${ch.peer}`;
  if (ch.type==='tab') return `tab:${ch.name}`;
  return `ch:${ch.name}`;
}

function isCurrentView(msg) {
  if (activeChannel.type==='tab') return false;
  const ch = msg.channel || 'general';
  if (ch==='general') return activeChannel.type==='channel' && activeChannel.name==='general';
  if (ch==='server')  return activeChannel.type==='channel' && activeChannel.name==='server';
  if (ch==='dm') {
    if (activeChannel.type!=='dm') return false;
    const peers = new Set([msg.user, msg.to]);
    return peers.has(activeChannel.peer) && peers.has(myUsername);
  }
  return false;
}

function showChannel(ch) {
  activeChannel = ch;
  unread[getKey(ch)] = 0;
  syncAllBadges();

  // Show/hide panels
  document.getElementById('chatView').style.display    = '';
  document.getElementById('filesView').classList.add('hidden');
  document.getElementById('browserView').classList.add('hidden');

  if (ch.type==='tab') {
    document.getElementById('chatView').style.display = 'none';
    document.getElementById(`${ch.name}View`).classList.remove('hidden');
    if (ch.name==='files') loadFiles();
    if (ch.name==='browser' && !browserReady) { browserReady=true; browseTo('.'); }
  }

  // Sidebar active states
  document.querySelectorAll('.ch-item, .dm-item').forEach(el => el.classList.remove('active'));
  if (ch.type==='channel') {
    document.querySelector(`.ch-item[data-ch="${ch.name}"][data-type="channel"]`)?.classList.add('active');
  } else if (ch.type==='dm') {
    document.querySelector(`.dm-item[data-peer="${CSS.escape(ch.peer)}"]`)?.classList.add('active');
  } else {
    document.querySelector(`.ch-item[data-ch="${ch.name}"][data-type="tab"]`)?.classList.add('active');
  }

  // Bottom nav active states
  document.querySelectorAll('.bn-item').forEach(el => el.classList.remove('active'));
  if (ch.type==='tab') {
    document.querySelector(`.bn-item[data-ch="${ch.name}"]`)?.classList.add('active');
  } else if (ch.type==='channel' && ch.name==='general') {
    document.querySelector('.bn-item[data-ch="general"]')?.classList.add('active');
  }

  // Drawer active states
  document.querySelectorAll('.drawer-item').forEach(el => el.classList.remove('active'));
  if (ch.type==='channel') {
    document.querySelector(`.drawer-item[data-ch="${ch.name}"]`)?.classList.add('active');
  }

  updateChatBar(ch);
  if (ch.type!=='tab') loadHistory(ch);
}

function updateChatBar(ch) {
  const icon  = document.getElementById('chatBarIcon');
  const title = document.getElementById('chatBarTitle');
  const sub   = document.getElementById('chatBarSub');
  const input = document.getElementById('msgInput');
  const sBtn  = document.getElementById('sendBtn');
  input.classList.remove('server-mode','dm-mode');
  sBtn.classList.remove('server-mode','dm-mode');

  if (ch.type==='channel' && ch.name==='general') {
    icon.textContent='#'; title.textContent='general';
    sub.textContent='Everyone on this server';
    input.placeholder='Message #general…';
  } else if (ch.type==='channel' && ch.name==='server') {
    icon.textContent='⬡'; title.textContent='server';
    sub.textContent='Query server — try: uptime · users · mem · files · help';
    input.placeholder='uptime / users / mem / files / help …';
    input.classList.add('server-mode'); sBtn.classList.add('server-mode');
  } else if (ch.type==='dm') {
    icon.textContent='@'; title.textContent=ch.peer;
    sub.textContent=`Direct message — only you and ${ch.peer} see this`;
    input.placeholder=`Message @${ch.peer}…`;
    input.classList.add('dm-mode'); sBtn.classList.add('dm-mode');
  }
}

// ── Badge management ──────────────────────────────────────────────────────
function incrementBadge(ch) {
  const key = getKey(ch);
  unread[key] = (unread[key]||0) + 1;
  syncAllBadges();
}

function syncAllBadges() {
  // Sidebar badges
  ['general','server'].forEach(name => {
    const count = unread[`ch:${name}`] || 0;
    const el = document.querySelector(`[data-badge="${name}"]`);
    if (el) { el.textContent=count; el.classList.toggle('hidden', count===0); }
  });
  // Bottom nav badges
  const generalCount = unread['ch:general'] || 0;
  const bnBadge = document.querySelector('[data-bn-badge="general"]');
  if (bnBadge) { bnBadge.textContent=generalCount; bnBadge.classList.toggle('hidden', generalCount===0); }
  // Drawer badges
  ['general','server'].forEach(name => {
    const count = unread[`ch:${name}`] || 0;
    const el = document.querySelector(`[data-drawer-badge="${name}"]`);
    if (el) { el.textContent=count; el.classList.toggle('hidden', count===0); }
  });
}

// ── Sidebar nav clicks ─────────────────────────────────────────────────────
document.querySelectorAll('.ch-item').forEach(btn => {
  btn.addEventListener('click', () => {
    const type = btn.dataset.type;
    showChannel(type==='tab' ? {type:'tab',name:btn.dataset.ch} : {type:'channel',name:btn.dataset.ch});
  });
});

// ── Bottom nav clicks ──────────────────────────────────────────────────────
document.querySelectorAll('.bn-item[data-type]').forEach(btn => {
  btn.addEventListener('click', () => {
    const type = btn.dataset.type;
    showChannel(type==='tab' ? {type:'tab',name:btn.dataset.ch} : {type:'channel',name:btn.dataset.ch});
  });
});

// ── Mobile "More" drawer ───────────────────────────────────────────────────
const moreBtn         = document.getElementById('moreBtn');
const mobileDrawer    = document.getElementById('mobileDrawer');
const drawerBackdrop  = document.getElementById('drawerBackdrop');
const closeDrawerBtn  = document.getElementById('closeDrawerBtn');

function openDrawer() {
  mobileDrawer.classList.remove('hidden');
  drawerBackdrop.classList.remove('hidden');
  // Slight delay lets the display:block paint before we add the class for transition
  requestAnimationFrame(() => mobileDrawer.classList.add('open'));
}
function closeDrawer() {
  mobileDrawer.classList.remove('open');
  drawerBackdrop.classList.add('hidden');
  setTimeout(() => mobileDrawer.classList.add('hidden'), 280);
}

moreBtn.addEventListener('click', openDrawer);
closeDrawerBtn.addEventListener('click', closeDrawer);
drawerBackdrop.addEventListener('click', closeDrawer);

// Drawer channel/DM clicks
document.querySelectorAll('.drawer-item[data-type]').forEach(btn => {
  btn.addEventListener('click', () => {
    const type = btn.dataset.type;
    closeDrawer();
    showChannel(type==='tab' ? {type:'tab',name:btn.dataset.ch} : {type:'channel',name:btn.dataset.ch});
  });
});

function openDM(peer) {
  closeDrawer();
  showChannel({type:'dm', peer});
}

// ════════════════════════════════════════════════════════════════════════════
// 5. CHAT ENGINE
// ════════════════════════════════════════════════════════════════════════════

const feed     = document.getElementById('feed');
const msgInput = document.getElementById('msgInput');
const sendBtn  = document.getElementById('sendBtn');
const attachBtn= document.getElementById('attachBtn');

const lastSender = {};
const lastTime   = {};

// ── SSE ───────────────────────────────────────────────────────────────────
function initSSE() {
  evtSource = new EventSource(`/api/chat/stream?user=${encodeURIComponent(myUsername)}`);

  evtSource.onmessage = event => {
    const msg = JSON.parse(event.data);
    if (msg.type==='users-update') { renderDMList(msg.users); return; }
    renderMessage(msg);
    if (!isCurrentView(msg)) {
      if (msg.channel==='dm') {
        incrementBadge({type:'dm', peer: msg.user===myUsername ? msg.to : msg.user});
      } else if (msg.channel==='server') {
        incrementBadge({type:'channel', name:'server'});
      } else if (msg.channel==='general') {
        incrementBadge({type:'channel', name:'general'});
      }
    }
  };
  evtSource.onerror = () => {};
}

// ── History ───────────────────────────────────────────────────────────────
async function loadHistory(ch) {
  clearFeed();
  let url = ch.type==='dm'
    ? `/api/chat/history?channel=dm&peer=${encodeURIComponent(ch.peer)}&viewer=${encodeURIComponent(myUsername)}`
    : `/api/chat/history?channel=${ch.name}&viewer=${encodeURIComponent(myUsername)}`;
  try {
    const msgs = await fetch(url).then(r=>r.json());
    msgs.forEach(m => renderMessage(m, true));
    scrollFeed();
  } catch {}
}

function clearFeed() {
  feed.innerHTML = '';
  Object.keys(lastSender).forEach(k => delete lastSender[k]);
  Object.keys(lastTime).forEach(k => delete lastTime[k]);
}

// ── Render message ─────────────────────────────────────────────────────────
function renderMessage(msg, replay=false) {
  const ch     = msg.channel || 'general';
  const isMine = msg.user === myUsername;

  if (msg.type==='system') {
    if (activeChannel.type==='channel' && activeChannel.name==='general') {
      const el = document.createElement('div');
      el.className = 'msg-system';
      el.textContent = msg.text;
      feed.appendChild(el);
      if (!replay) scrollFeed();
    }
    return;
  }

  if (!isCurrentView(msg)) return;

  const chKey = ch==='dm' ? `dm:${[msg.user,msg.to].sort().join('-')}` : ch;
  const cont  = msg.user===lastSender[chKey] && (msg.time-(lastTime[chKey]||0))<120;
  lastSender[chKey] = msg.user;
  lastTime[chKey]   = msg.time;

  feed.querySelector('.feed-welcome')?.remove();

  const group = document.createElement('div');
  let cls = `msg-group${cont?' cont':''}`;
  if (ch==='server') cls+=' is-server';
  if (ch==='dm')     cls+=' is-dm';
  if (isMine)        cls+=' own';         // own messages: right-aligned bubble
  group.className = cls;

  const textHtml = msg.type==='server-reply'
    ? `<div class="mg-text server-reply">${esc(msg.text)}</div>`
    : msg.text ? `<div class="mg-text">${esc(msg.text)}</div>` : '';

  const fileHtml  = msg.type==='file'  ? buildFileCard(msg.file) : '';
  const voiceHtml = msg.type==='voice' ? buildVoiceBubble(msg.file) : '';

  if (isMine) {
    // Own messages: no avatar, no name header — just the bubble on the right
    group.innerHTML = `
      <div class="mg-body own-body">
        <div class="mg-time own-time">${fmtTime(msg.time)}</div>
        ${textHtml}${fileHtml}${voiceHtml}
      </div>`;
  } else {
    group.innerHTML = `
      <div class="mg-avatar">${esc(msg.user[0].toUpperCase())}</div>
      <div class="mg-body">
        <div class="mg-header">
          <span class="mg-user${ch==='dm'?' dm-peer':''}">${esc(msg.user)}</span>
          <span class="mg-time">${fmtTime(msg.time)}</span>
        </div>
        ${textHtml}${fileHtml}${voiceHtml}
      </div>`;
  }

  feed.appendChild(group);
  if (!replay) scrollFeed();
}

function buildFileCard(file) {
  if (!file) return '';
  return `
    <div class="file-card" onclick="openFileFromCard('${ea(file.name)}','${ea(file.path)}','${ea(file.src||'upload')}',${file.size||0})">
      <span class="fc-icon">${getIcon(file.name)}</span>
      <div class="fc-info">
        <div class="fc-name">${esc(file.name)}</div>
        <div class="fc-meta">${fmtSize(file.size)} · click to view or download</div>
      </div>
      <span class="fc-arr">›</span>
    </div>`;
}

function buildVoiceBubble(file) {
  if (!file) return '';
  const url = `/view?path=${encodeURIComponent(file.path)}&src=upload`;
  // Each player gets a unique ID so multiple voice messages don't collide
  const id  = 'vp-' + Math.random().toString(36).slice(2,8);
  return `
    <div class="voice-player" data-src="${url}" id="${id}">
      <button class="vp-play" onclick="vpToggle('${id}')" title="Play / Pause">▶</button>
      <div class="vp-track">
        <div class="vp-bar" onclick="vpSeek(event,'${id}')">
          <div class="vp-fill" id="${id}-fill"></div>
          <div class="vp-thumb" id="${id}-thumb"></div>
        </div>
        <div class="vp-times">
          <span class="vp-cur" id="${id}-cur">0:00</span>
          <span class="vp-dur" id="${id}-dur">–:––</span>
        </div>
      </div>
      <audio id="${id}-audio" src="${url}" preload="metadata"
             onloadedmetadata="vpMeta('${id}')"
             ontimeupdate="vpTick('${id}')"
             onended="vpEnded('${id}')"></audio>
    </div>`;
}

/* ── Voice player controller functions ── */
function vpFmt(s) {
  // Format seconds as m:ss
  if (!isFinite(s)) return '–:––';
  const m = Math.floor(s/60), sec = Math.floor(s%60);
  return m+':'+(sec<10?'0':'')+sec;
}
function vpEl(id, sel) { return document.querySelector('#'+id+(sel?' '+sel:'')); }

function vpMeta(id) {
  const a = document.getElementById(id+'-audio');
  document.getElementById(id+'-dur').textContent = vpFmt(a.duration);
}
function vpTick(id) {
  const a    = document.getElementById(id+'-audio');
  const pct  = a.duration ? (a.currentTime / a.duration * 100) : 0;
  document.getElementById(id+'-fill').style.width  = pct+'%';
  document.getElementById(id+'-thumb').style.left  = pct+'%';
  document.getElementById(id+'-cur').textContent   = vpFmt(a.currentTime);
}
function vpEnded(id) {
  const btn = document.querySelector('#'+id+' .vp-play');
  if (btn) btn.textContent = '▶';
  // Reset visuals
  document.getElementById(id+'-fill').style.width = '0%';
  document.getElementById(id+'-thumb').style.left = '0%';
  document.getElementById(id+'-cur').textContent  = '0:00';
}
function vpToggle(id) {
  const a   = document.getElementById(id+'-audio');
  const btn = document.querySelector('#'+id+' .vp-play');
  if (a.paused) { a.play(); btn.textContent='⏸'; }
  else          { a.pause(); btn.textContent='▶'; }
}
function vpSeek(e, id) {
  const a   = document.getElementById(id+'-audio');
  const bar = e.currentTarget;
  const pct = e.offsetX / bar.offsetWidth;
  if (a.duration) { a.currentTime = pct * a.duration; }
}

function openFileFromCard(name, path, src, size) {
  showFileOptions({name, path, src, size, modified:null}, true);
}

function scrollFeed() { feed.scrollTop = feed.scrollHeight; }

// ── DM list ────────────────────────────────────────────────────────────────
function renderDMList(users) {
  const others = users.filter(u => u!==myUsername);
  document.getElementById('onlinePill').textContent        = others.length;
  document.getElementById('onlinePillMobile').textContent  = others.length;

  const sidebarHtml = others.length
    ? others.map(u => `
        <button class="dm-item" data-peer="${esc(u)}" onclick="openDM('${ea(u)}')">
          <span class="dm-avatar">${esc(u[0].toUpperCase())}</span>
          <span class="dm-name">${esc(u)}</span>
        </button>`).join('')
    : '<p class="dm-empty">No one else online</p>';
  document.getElementById('dmList').innerHTML = sidebarHtml;

  const drawerHtml = others.length
    ? others.map(u => `
        <button class="drawer-item" onclick="openDM('${ea(u)}')">
          <span class="di-hash">${esc(u[0].toUpperCase())}</span>
          <span class="di-name">${esc(u)}</span>
        </button>`).join('')
    : '<p class="dm-empty">No one else online</p>';
  document.getElementById('drawerDmList').innerHTML = drawerHtml;

  if (activeChannel.type==='dm') {
    document.querySelector(`.dm-item[data-peer="${CSS.escape(activeChannel.peer)}"]`)?.classList.add('active');
  }
}

setInterval(async () => {
  try {
    const data = await fetch('/api/users').then(r=>r.json());
    renderDMList(data.users);
  } catch {}
}, 15_000);

// ── Send ───────────────────────────────────────────────────────────────────
async function doSend(text='', type='text', fileData=null) {
  if (!myUsername || (!text.trim() && !fileData)) return;
  const ch = activeChannel;
  const payload = {
    user: myUsername,
    text: text.trim(),
    type,
    channel: ch.type==='channel' ? ch.name : ch.type==='dm' ? 'dm' : 'general',
    to: ch.type==='dm' ? ch.peer : '',
  };
  if (fileData) payload.file = fileData;
  await fetch('/api/chat/send', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify(payload),
  }).catch(() => toast('Could not send.','error'));
}

msgInput.addEventListener('keydown', e => {
  if (e.key==='Enter' && !e.shiftKey) {
    e.preventDefault();
    const text = msgInput.value.trim();
    if (!text) return;
    doSend(text);
    msgInput.value = '';
    msgInput.style.height = 'auto';
  }
});
msgInput.addEventListener('input', () => {
  msgInput.style.height = 'auto';
  msgInput.style.height = Math.min(msgInput.scrollHeight, 140)+'px';
});
sendBtn.addEventListener('click', () => {
  const text = msgInput.value.trim();
  if (!text) return;
  doSend(text);
  msgInput.value = '';
  msgInput.style.height = 'auto';
});
attachBtn.addEventListener('click', () => {
  showChannel({type:'tab', name:'files'});
  toast('Upload a file, then use "Share to Chat"','info');
});

// ════════════════════════════════════════════════════════════════════════════
// 6. VOICE RECORDING
// ════════════════════════════════════════════════════════════════════════════

/*
 * Voice messages use the browser's MediaRecorder API.
 *
 * How it works:
 *   1. navigator.mediaDevices.getUserMedia({audio:true}) — asks permission
 *      and returns a MediaStream (raw audio from the mic).
 *   2. new MediaRecorder(stream) — wraps the stream in a recorder.
 *   3. recorder.start() — begins collecting audio chunks.
 *   4. recorder.ondataavailable — fires with a Blob of audio data.
 *   5. recorder.stop() — triggers ondataavailable one last time, then onstop.
 *   6. onstop — we assemble chunks into a single Blob and upload it.
 *
 * The recorded format (webm or ogg) is whatever the browser supports —
 * we detect this and set the correct MIME type for the server.
 *
 * On mobile: touch events (touchstart/touchend) replace mousedown/mouseup
 * because "hold to record" doesn't work well with mouse events on touch screens.
 */

const voiceBtn = document.getElementById('voiceBtn');
let mediaRecorder = null;
let audioChunks   = [];
let micStream     = null;

async function startRecording() {
  // Request microphone access
  try {
    micStream = await navigator.mediaDevices.getUserMedia({audio: true});
  } catch {
    toast('Microphone access denied', 'error');
    return;
  }

  audioChunks = [];
  const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/ogg';
  mediaRecorder  = new MediaRecorder(micStream, {mimeType});

  mediaRecorder.ondataavailable = e => {
    if (e.data.size > 0) audioChunks.push(e.data);
  };

  mediaRecorder.onstop = async () => {
    // Stop all mic tracks to release the mic indicator in the OS
    micStream.getTracks().forEach(t => t.stop());
    micStream = null;

    if (audioChunks.length === 0) return;

    const blob     = new Blob(audioChunks, {type: mediaRecorder.mimeType});
    const ext      = mimeType.includes('ogg') ? 'ogg' : 'webm';

    // Upload the raw blob directly (not multipart)
    try {
      const res  = await fetch('/upload/voice', {
        method:  'POST',
        headers: { 'Content-Type': mimeType, 'Content-Length': blob.size },
        body:    blob,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      // Share as a voice message in the current channel
      await doSend('', 'voice', {
        name: data.name,
        size: data.size,
        path: data.name,
        src:  'upload',
      });
      toast('Voice message sent 🎙','success');
    } catch (err) {
      toast('Voice upload failed: '+err.message, 'error');
    }
  };

  mediaRecorder.start();
  voiceBtn.classList.add('recording');
  voiceBtn.title = 'Release to send…';
}

function stopRecording() {
  if (!mediaRecorder || mediaRecorder.state==='inactive') return;
  mediaRecorder.stop();
  voiceBtn.classList.remove('recording');
  voiceBtn.title = 'Hold to record voice message';
}

// Desktop: mouse events
voiceBtn.addEventListener('mousedown',  e => { e.preventDefault(); startRecording(); });
voiceBtn.addEventListener('mouseup',    stopRecording);
voiceBtn.addEventListener('mouseleave', stopRecording);

// Mobile: touch events
voiceBtn.addEventListener('touchstart', e => { e.preventDefault(); startRecording(); }, {passive:false});
voiceBtn.addEventListener('touchend',   e => { e.preventDefault(); stopRecording(); },  {passive:false});

// ════════════════════════════════════════════════════════════════════════════
// 7. FILE OPTIONS MODAL
// ════════════════════════════════════════════════════════════════════════════

const fileOptionsOverlay = document.getElementById('fileOptionsOverlay');
const closeOptionsBtn    = document.getElementById('closeOptionsBtn');
const optionsIcon        = document.getElementById('optionsIcon');
const optionsName        = document.getElementById('optionsName');
const optionsMeta        = document.getElementById('optionsMeta');
const optionView         = document.getElementById('optionView');
const optionShare        = document.getElementById('optionShare');
const optionDownload     = document.getElementById('optionDownload');
const optionDelete       = document.getElementById('optionDelete');

let activeFile = null;

function showFileOptions(file, fromChat=false) {
  activeFile = file;
  optionsIcon.textContent = getIcon(file.name);
  optionsName.textContent = file.name;
  optionsMeta.textContent = [fmtSize(file.size), file.modified ? fmtTime(file.modified) : null].filter(Boolean).join(' · ');
  optionDelete.style.display = fromChat ? 'none' : '';
  fileOptionsOverlay.classList.remove('hidden');
}
function closeOptions() { fileOptionsOverlay.classList.add('hidden'); activeFile=null; }

closeOptionsBtn.addEventListener('click', closeOptions);
fileOptionsOverlay.addEventListener('click', e => { if(e.target===fileOptionsOverlay) closeOptions(); });

optionView.addEventListener('click', () => { const f=activeFile; closeOptions(); openViewer(f); });

optionShare.addEventListener('click', () => {
  const f=activeFile; closeOptions();
  doSend('','file',{name:f.name,size:f.size,path:f.path,src:f.src||'upload'});
  if (activeChannel.type==='tab') showChannel({type:'channel',name:'general'});
  toast(`Shared "${f.name}"`,'success');
});

optionDownload.addEventListener('click', () => {
  const f=activeFile; closeOptions();
  window.location.href = f.src==='fs'
    ? `/fs-download?path=${encodeURIComponent(f.path)}`
    : `/download/${encodeURIComponent(f.name)}`;
});

optionDelete.addEventListener('click', async () => {
  const f=activeFile;
  if (!confirm(`Delete "${f.name}"?`)) return;
  closeOptions();
  const res  = await fetch(`/file/${encodeURIComponent(f.name)}`,{method:'DELETE'});
  const data = await res.json();
  if (res.ok) { toast(`"${f.name}" deleted`,'info'); loadFiles(); }
  else toast(data.error||'Delete failed','error');
});

// ════════════════════════════════════════════════════════════════════════════
// 8. FILE VIEWER MODAL
// ════════════════════════════════════════════════════════════════════════════

const viewerOverlay  = document.getElementById('viewerOverlay');
const viewerName     = document.getElementById('viewerName');
const viewerBody     = document.getElementById('viewerBody');
const viewerDownload = document.getElementById('viewerDownload');
const viewerShare    = document.getElementById('viewerShare');
const closeViewerBtn = document.getElementById('closeViewerBtn');

const IMG   = new Set(['jpg','jpeg','png','gif','webp','svg','bmp']);
const VIDEO = new Set(['mp4','webm','ogg','mov']);
const AUDIO = new Set(['mp3','wav','ogg','flac','aac','m4a','webm']);
const TEXT  = new Set(['txt','md','json','js','py','html','css','ts','csv','xml','sh','log']);

let viewerFile = null;

function openViewer(file) {
  viewerFile = file;
  viewerName.textContent = file.name;
  viewerBody.innerHTML   = '';
  const ext = file.name.split('.').pop().toLowerCase();
  const url = `/view?path=${encodeURIComponent(file.path)}&src=${encodeURIComponent(file.src||'upload')}`;

  if (IMG.has(ext)) {
    const img=document.createElement('img'); img.src=url; img.alt=file.name;
    viewerBody.appendChild(img);
  } else if (VIDEO.has(ext)) {
    const v=document.createElement('video'); v.src=url; v.controls=true;
    viewerBody.appendChild(v);
  } else if (AUDIO.has(ext)) {
    const a=document.createElement('audio'); a.src=url; a.controls=true;
    viewerBody.appendChild(a);
  } else if (ext==='pdf') {
    const iframe=document.createElement('iframe'); iframe.src=url;
    viewerBody.appendChild(iframe);
  } else if (TEXT.has(ext)) {
    fetch(url).then(r=>r.text()).then(t=>{
      const pre=document.createElement('pre'); pre.textContent=t;
      viewerBody.appendChild(pre);
    }).catch(()=>{
      viewerBody.innerHTML='<div class="viewer-unsup"><div class="big">📃</div><p>Could not load.</p></div>';
    });
  } else {
    viewerBody.innerHTML=`<div class="viewer-unsup">
      <div class="big">${getIcon(file.name)}</div>
      <p>Can't preview this file type.</p>
      <p style="margin-top:.75rem">
        <button class="btn-accent" onclick="document.getElementById('viewerDownload').click()">↓ Download</button>
      </p></div>`;
  }
  viewerOverlay.classList.remove('hidden');
}

closeViewerBtn.addEventListener('click', () => {
  viewerOverlay.classList.add('hidden');
  viewerBody.innerHTML='';
  viewerFile=null;
});
viewerOverlay.addEventListener('click', e => { if(e.target===viewerOverlay) closeViewerBtn.click(); });

viewerDownload.addEventListener('click', () => {
  if (!viewerFile) return;
  window.location.href = viewerFile.src==='fs'
    ? `/fs-download?path=${encodeURIComponent(viewerFile.path)}`
    : `/download/${encodeURIComponent(viewerFile.name)}`;
});
viewerShare.addEventListener('click', () => {
  if (!viewerFile) return;
  const f=viewerFile; closeViewerBtn.click();
  doSend('','file',{name:f.name,size:f.size,path:f.path,src:f.src||'upload'});
  if (activeChannel.type==='tab') showChannel({type:'channel',name:'general'});
  toast(`Shared "${f.name}"`,'success');
});

// ════════════════════════════════════════════════════════════════════════════
// 9. FILES TAB
// ════════════════════════════════════════════════════════════════════════════

const uploadZone      = document.getElementById('uploadZone');
const fileInput       = document.getElementById('fileInput');
const fileListEl      = document.getElementById('fileList');
const progressWrap    = document.getElementById('progressWrap');
const progressFill    = document.getElementById('progressFill');
const progressText    = document.getElementById('progressText');
const refreshFilesBtn = document.getElementById('refreshFilesBtn');

async function loadFiles() {
  try {
    const files = await fetch('/api/files').then(r=>r.json());
    if (!files.length) { fileListEl.innerHTML='<p class="empty">No files yet.</p>'; return; }
    fileListEl.innerHTML = files.map((f,i) => `
      <div class="file-row" style="animation-delay:${i*.025}s"
           onclick="showFileOptions({name:'${ea(f.name)}',path:'${ea(f.name)}',src:'upload',size:${f.size},modified:${f.modified}})">
        <span class="f-icon">${getIcon(f.name)}</span>
        <div>
          <div class="f-name" title="${esc(f.name)}">${esc(f.name)}</div>
          <div class="f-meta">${fmtSize(f.size)} · ${fmtTime(f.modified)}</div>
        </div>
      </div>`).join('');
  } catch { fileListEl.innerHTML='<p class="empty">Server unreachable.</p>'; }
}

async function uploadFiles(list) {
  if (!list || !list.length) return;
  const form = new FormData();
  for (const f of list) form.append('file',f);
  progressWrap.classList.remove('hidden');
  progressFill.style.width='0%';
  progressText.textContent=`Uploading ${list.length} file(s)…`;
  try {
    const result = await new Promise((res,rej) => {
      const xhr = new XMLHttpRequest();
      xhr.upload.onprogress = e => {
        if (e.lengthComputable) {
          const p=Math.round(e.loaded/e.total*100);
          progressFill.style.width=p+'%'; progressText.textContent=p+'%';
        }
      };
      xhr.onload  = ()=>xhr.status<300?res(JSON.parse(xhr.responseText)):rej();
      xhr.onerror = ()=>rej();
      xhr.open('POST','/upload'); xhr.send(form);
    });
    toast(`${result.saved.length} file(s) uploaded!`,'success');
    loadFiles();
  } catch { toast('Upload failed.','error'); }
  finally { setTimeout(()=>progressWrap.classList.add('hidden'),800); }
}

uploadZone.addEventListener('click',     ()=>fileInput.click());
fileInput.addEventListener('change',     ()=>{uploadFiles(fileInput.files);fileInput.value='';});
uploadZone.addEventListener('dragenter', e=>{e.preventDefault();uploadZone.classList.add('over');});
uploadZone.addEventListener('dragover',  e=>e.preventDefault());
uploadZone.addEventListener('dragleave', e=>{if(!uploadZone.contains(e.relatedTarget))uploadZone.classList.remove('over');});
uploadZone.addEventListener('drop',      e=>{e.preventDefault();uploadZone.classList.remove('over');uploadFiles(e.dataTransfer.files);});
refreshFilesBtn.addEventListener('click',()=>{
  refreshFilesBtn.classList.add('spin');
  loadFiles().finally(()=>setTimeout(()=>refreshFilesBtn.classList.remove('spin'),600));
});

// ════════════════════════════════════════════════════════════════════════════
// 10. BROWSER TAB
// ════════════════════════════════════════════════════════════════════════════

const dirList        = document.getElementById('dirList');
const breadcrumbEl   = document.getElementById('breadcrumb');
const bStatus        = document.getElementById('bStatus');
const searchInput    = document.getElementById('searchInput');
const searchClearBtn = document.getElementById('searchClearBtn');

let currentPath = '.';
let searchTimer;

// View toggle
document.querySelectorAll('.vt-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.vt-btn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    dirList.dataset.view = btn.dataset.view;
  });
});

async function browseTo(relPath) {
  currentPath = relPath;
  dirList.innerHTML='<p class="empty">Loading…</p>';
  bStatus.textContent='';

  const res  = await fetch(`/api/browse?path=${encodeURIComponent(relPath)}`).catch(()=>null);
  if (!res) { dirList.innerHTML='<p class="empty">Server unreachable.</p>'; return; }
  const data = await res.json();
  if (!res.ok) { dirList.innerHTML=`<p class="empty">${esc(data.error)}</p>`; return; }

  buildBreadcrumb(data.path, data.root);
  bStatus.textContent=`${data.entries.length} item(s)`;

  if (!data.entries.length && !data.can_go_up) { dirList.innerHTML='<p class="empty">Empty folder.</p>'; return; }

  let rows='';
  if (data.can_go_up) {
    const parent = data.path.includes('/') ? data.path.slice(0,data.path.lastIndexOf('/')) : '.';
    rows += row({name:'.. parent', type:'dir', path:parent}, true);
  }
  rows += data.entries.map(e => row(e)).join('');
  dirList.innerHTML = rows;
}

function row(e, isUp=false) {
  const isDir = e.type==='dir'||isUp;
  const icon  = isUp ? '↩' : getIcon(e.name, isDir);
  const name  = isUp ? '.. parent directory' : e.name;
  const meta  = isDir ? (e.modified?fmtTime(e.modified):'') : `${fmtSize(e.size)} · ${fmtTime(e.modified)}`;
  const cls   = `dir-row${isDir?' is-dir':''}${isUp?' up-row':''}`;
  const action = isDir
    ? `browseTo('${ea(e.path)}')`
    : `openFsFile('${ea(e.name)}','${ea(e.path)}',${e.size||0},${e.modified||0})`;
  const arr = isDir ? '›' : '↓';
  return `
    <div class="${cls}" onclick="${action}">
      <span class="dr-icon">${icon}</span>
      <div class="dr-info">
        <div class="dr-name" title="${esc(name)}">${esc(name)}</div>
        <div class="dr-meta">${meta}</div>
      </div>
      <span class="dr-arr">${arr}</span>
    </div>`;
}

function openFsFile(name, path, size, modified) {
  showFileOptions({name,path,src:'fs',size,modified});
}

function buildBreadcrumb(relPath, root) {
  const segs = relPath==='.' ? [] : relPath.split(/[/\\]/);
  const label = root.length>28 ? '…'+root.slice(-27) : root;
  let html=`<button class="crumb" onclick="browseTo('.')">${esc(label)}</button>`;
  let built='';
  segs.forEach((seg,i)=>{
    built = built?`${built}/${seg}`:seg;
    const p=built;
    html+=`<span class="crumb-sep">/</span>`;
    html+=i===segs.length-1
      ?`<span class="crumb cur">${esc(seg)}</span>`
      :`<button class="crumb" onclick="browseTo('${ea(p)}')">${esc(seg)}</button>`;
  });
  breadcrumbEl.innerHTML=html;
}

searchInput.addEventListener('input', () => {
  const t=searchInput.value.trim();
  searchClearBtn.classList.toggle('hidden',!t);
  clearTimeout(searchTimer);
  if (!t) { browseTo(currentPath); return; }
  searchTimer=setTimeout(()=>runSearch(t), 350);
});
searchClearBtn.addEventListener('click', ()=>{
  searchInput.value=''; searchClearBtn.classList.add('hidden');
  browseTo(currentPath);
});

async function runSearch(term) {
  dirList.innerHTML='<p class="empty">Searching…</p>';
  breadcrumbEl.innerHTML=`<span class="crumb cur">Search: "${esc(term)}"</span>`;
  bStatus.textContent='';
  const res  = await fetch(`/api/search?q=${encodeURIComponent(term)}&path=${encodeURIComponent(currentPath)}`).catch(()=>null);
  if (!res) { dirList.innerHTML='<p class="empty">Search failed.</p>'; return; }
  const data = await res.json();
  bStatus.textContent = data.capped ? `First 200 results for "${term}"` : `${data.results.length} result(s)`;
  if (!data.results.length) { dirList.innerHTML=`<p class="empty">No results for "${esc(term)}"</p>`; return; }
  dirList.innerHTML = data.results.map(e => e.type==='dir'
    ?`<div class="dir-row is-dir" onclick="clearSearch('${ea(e.path)}')">
        <span class="dr-icon">📁</span>
        <div class="dr-info"><div class="dr-name">${esc(e.name)}</div><div class="dr-meta">${esc(e.path)}</div></div>
        <span class="dr-arr">›</span></div>`
    :row(e)
  ).join('');
}

function clearSearch(path) {
  searchInput.value=''; searchClearBtn.classList.add('hidden');
  browseTo(path);
}
