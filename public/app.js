'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// VideoConf Pro — Full Client
// Features: auth · screen share · recording · room passwords · admin panel
//           TURN servers · participant mgmt · file sharing · reactions
//           live captions (Web Speech API) · AI transcription
// ═══════════════════════════════════════════════════════════════════════════

const ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    // Metered.ca free TURN — replace credentials with your own
    {
      urls: [
        'turn:a.relay.metered.ca:80',
        'turn:a.relay.metered.ca:443',
        'turns:a.relay.metered.ca:443',
      ],
      username:   'openrelayproject',
      credential: 'openrelayproject',
    },
  ],
  iceCandidatePoolSize: 10,
};

// ── State ─────────────────────────────────────────────────────────────────
let socket        = null;
let localStream   = null;
let screenStream  = null;
let mediaRecorder = null;
let recordChunks  = [];
let recognition   = null;
let captionsOn    = false;
let myActorId     = null;
let myName        = null;
let myRole        = null;
let myToken       = null;
let spotlightId   = null;

const peers        = new Map();  // peerId → { pc, video, name, role }
const pendingNames = new Map();  // peerId → name (from peer_joined, before offer)

// ── DOM shortcuts ─────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

// ═══════════════════════════════════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════════════════════════════════
function switchAuthTab(tab) {
  $('authLogin').style.display    = tab === 'login'    ? 'block' : 'none';
  $('authRegister').style.display = tab === 'register' ? 'block' : 'none';
  document.querySelectorAll('.auth-tab').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.auth-tab')[tab === 'login' ? 0 : 1].classList.add('active');
}

async function doLogin() {
  const username = $('loginUser').value.trim();
  const password = $('loginPass').value;
  if (!username || !password) return showAuthErr('Fill in all fields');
  try {
    const r = await fetch('/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const d = await r.json();
    if (!r.ok) return showAuthErr(d.error);
    myToken = d.token; myName = d.username; myRole = d.role;
    afterAuth();
  } catch { showAuthErr('Server unreachable'); }
}

async function doRegister() {
  const username = $('regUser').value.trim();
  const password = $('regPass').value;
  if (!username || !password) return showAuthErr('Fill in all fields');
  try {
    const r = await fetch('/api/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const d = await r.json();
    if (!r.ok) return showAuthErr(d.error);
    $('loginUser').value = username;
    $('loginPass').value = password;
    showAuthErr('Account created — logging in…');
    setTimeout(doLogin, 800);
  } catch { showAuthErr('Server unreachable'); }
}

function showAuthErr(msg) { $('authError').textContent = msg; }

function afterAuth() {
  $('authScreen').style.display = 'none';
  $('joinScreen').style.display = 'flex';
  $('joinWelcome').textContent  = `Welcome, ${myName} 👋`;
  if (myRole === 'admin') $('btnAdminPanel').style.display = 'block';
  // Restore saved room
  const saved = JSON.parse(localStorage.getItem('vc_session') || '{}');
  if (saved.sessionId) $('joinRoomId').value = saved.sessionId;
}

// Key listener for auth inputs
['loginUser','loginPass'].forEach(id => {
  $(id)?.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
});

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN PANEL
// ═══════════════════════════════════════════════════════════════════════════
async function showAdminPanel() {
  $('adminModal').style.display = 'flex';
  await loadAdminSessions();
}
function hideAdminPanel() { $('adminModal').style.display = 'none'; }

function adminTab(tab) {
  document.querySelectorAll('.modal-tab').forEach(b => b.classList.remove('active'));
  event.target.classList.add('active');
  $('adminSessions').style.display = tab === 'sessions' ? 'block' : 'none';
  $('adminUsers').style.display    = tab === 'users'    ? 'block' : 'none';
  if (tab === 'sessions') loadAdminSessions();
  if (tab === 'users')    loadAdminUsers();
}

async function adminFetch(url, method = 'GET', body) {
  const opts = { method, headers: { Authorization: `Bearer ${myToken}`, 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(url, opts);
  return r.json();
}

async function loadAdminSessions() {
  const data = await adminFetch('/api/admin/sessions');
  const el = $('adminSessions');
  if (!Object.keys(data).length) { el.innerHTML = '<div style="color:var(--text-dim);font-size:13px">No active sessions</div>'; return; }
  el.innerHTML = Object.entries(data).map(([sid, s]) => `
    <div class="admin-session-card">
      <h4>Room: <code>${sid}</code> — ${s.count} actor(s) ${s.hasPassword ? '🔒' : ''}</h4>
      <div style="font-size:12px;color:var(--text-dim);margin-bottom:8px">${s.actors.map(a=>a.name).join(', ')}</div>
      <button class="btn-danger" style="font-size:12px;padding:4px 10px" onclick="adminCloseSession('${sid}')">Close Session</button>
    </div>`).join('');
}

async function loadAdminUsers() {
  const data = await adminFetch('/api/admin/users');
  $('adminUsers').innerHTML = data.map(u => `
    <div class="admin-user-row">
      <span>${u.username}</span>
      <span class="participant-role ${u.role === 'admin' ? 'admin' : ''}">${u.role}</span>
    </div>`).join('');
}

async function adminCloseSession(sid) {
  if (!confirm(`Close session "${sid}"?`)) return;
  await adminFetch(`/api/admin/session/${sid}`, 'DELETE');
  loadAdminSessions();
}

// ═══════════════════════════════════════════════════════════════════════════
// JOIN ROOM
// ═══════════════════════════════════════════════════════════════════════════
async function doJoin() {
  const sessionId   = $('joinRoomId').value.trim()      || 'room-1';
  const password    = $('joinRoomPass').value;
  const roomPassword= $('joinRoomNewPass').value;

  $('joinError').textContent = '';

  const ok = await startMedia();
  if (!ok) return;

  localStorage.setItem('vc_session', JSON.stringify({ sessionId }));
  $('roomLabel').textContent = sessionId;

  $('joinScreen').style.display = 'none';
  $('confScreen').style.display  = 'block';
  $('localName').textContent     = myName;

  if (myRole === 'admin') {
    $('adminStab').style.display = 'flex';
  }

  connectSocket(sessionId, password, roomPassword);
}

// ═══════════════════════════════════════════════════════════════════════════
// MEDIA
// ═══════════════════════════════════════════════════════════════════════════
async function startMedia() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, frameRate: 30 },
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    $('localVideo').srcObject = localStream;
    $('localVideo').crossOrigin = 'anonymous';
    setStatus('media_ok', 'Camera ready');
    return true;
  } catch (err) {
    $('joinError').textContent = 'Camera denied: ' + err.message;
    return false;
  }
}

// ─── Toggle audio ─────────────────────────────────────────────────────────
let audioOn = true, videoOn = true;
function toggleAudio() {
  audioOn = !audioOn;
  localStream?.getAudioTracks().forEach(t => t.enabled = audioOn);
  const btn = $('btnToggleAudio');
  btn.textContent = audioOn ? '🎤' : '🔇';
  btn.classList.toggle('active', audioOn);
}
function toggleVideo() {
  videoOn = !videoOn;
  localStream?.getVideoTracks().forEach(t => t.enabled = videoOn);
  const btn = $('btnToggleVideo');
  btn.textContent = videoOn ? '📷' : '📵';
  btn.classList.toggle('active', videoOn);
}
function setLocalAudio(enabled) { audioOn = enabled; toggleAudio(); if (!enabled) toggleAudio(); /* force state */ }
function setLocalVideo(enabled) { videoOn = enabled; toggleVideo(); if (!enabled) toggleVideo(); }

// ─── Screen share ─────────────────────────────────────────────────────────
let isSharing = false;
async function toggleScreen() {
  if (isSharing) { stopScreen(); return; }
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    $('screenVideo').srcObject = screenStream;
    $('screenWrapper').style.display = 'block';
    $('btnScreen').classList.add('active');
    isSharing = true;
    wsSend({ type: 'screen_started' });

    // Add screen track to all peer connections
    const track = screenStream.getVideoTracks()[0];
    peers.forEach(({ pc }) => pc.addTrack(track, screenStream));

    screenStream.getVideoTracks()[0].onended = stopScreen;
  } catch (e) { console.warn('Screen share cancelled:', e.message); }
}
function stopScreen() {
  screenStream?.getTracks().forEach(t => t.stop());
  screenStream = null;
  $('screenWrapper').style.display = 'none';
  $('btnScreen').classList.remove('active');
  isSharing = false;
  wsSend({ type: 'screen_stopped' });
}

// ─── Recording ────────────────────────────────────────────────────────────
let isRecording = false;
function toggleRecord() {
  isRecording ? stopRecording() : startRecording();
}
function startRecording() {
  if (!localStream) return;
  try {
    const combined = new MediaStream([
      ...localStream.getTracks(),
      ...(screenStream ? screenStream.getTracks() : []),
    ]);
    mediaRecorder = new MediaRecorder(combined);
    recordChunks  = [];
    mediaRecorder.ondataavailable = e => { if (e.data.size > 0) recordChunks.push(e.data); };
    mediaRecorder.onstop = () => {
      const blob = new Blob(recordChunks, { type: 'video/webm' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href = url; a.download = `videoconf-${Date.now()}.webm`;
      a.click(); URL.revokeObjectURL(url);
    };
    mediaRecorder.start(1000);
    isRecording = true;
    $('btnRecord').classList.add('recording');
    $('btnRecord').textContent = '⏹';
    wsSend({ type: 'recording_started' });
    addChatEvent('🔴 Recording started');
  } catch (e) { console.error('Recording error:', e); }
}
function stopRecording() {
  mediaRecorder?.stop();
  isRecording = false;
  $('btnRecord').classList.remove('recording');
  $('btnRecord').textContent = '⏺';
  wsSend({ type: 'recording_stopped' });
  addChatEvent('⏹ Recording saved');
}

// ─── Live captions / AI transcription ────────────────────────────────────
function toggleCaptions() {
  captionsOn ? stopCaptions() : startCaptions();
}
function startCaptions() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) { addChatEvent('⚠ Speech recognition not supported in this browser'); return; }

  recognition = new SpeechRecognition();
  recognition.continuous     = true;
  recognition.interimResults = true;
  recognition.lang           = 'en-US';   // change as needed

  recognition.onresult = (e) => {
    let interim = '', final = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) final += t;
      else interim += t;
    }
    if (interim || final) {
      $('captionsText').textContent = interim || final;
      wsSend({ type: 'transcript', text: interim || final, final: !!final });
    }
  };
  recognition.onerror = e => { if (e.error !== 'no-speech') console.warn('Speech error:', e.error); };
  recognition.onend   = () => { if (captionsOn) recognition.start(); }; // auto-restart

  recognition.start();
  captionsOn = true;
  $('captionsBar').style.display = 'block';
  $('btnCaption').classList.add('active');
  document.body.classList.add('has-captions');
  addChatEvent('💬 Captions on');
}
function stopCaptions() {
  recognition?.stop();
  captionsOn = false;
  $('captionsBar').style.display = 'none';
  $('btnCaption').classList.remove('active');
  document.body.classList.remove('has-captions');
  addChatEvent('💬 Captions off');
}

function exportTranscript() {
  const lines = [...$('transcriptLog').querySelectorAll('.transcript-entry:not(.interim)')]
    .map(el => el.textContent.trim());
  const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
  const a    = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `transcript-${Date.now()}.txt`;
  a.click();
}

// ─── Reactions ────────────────────────────────────────────────────────────
function sendReaction(emoji) { wsSend({ type: 'reaction', emoji }); showFlyingEmoji(emoji, myName); }
function showFlyingEmoji(emoji, name) {
  const stage = $('reactionStage');
  const el = document.createElement('div');
  el.className   = 'flying-emoji';
  el.textContent = emoji;
  el.title       = name;
  el.style.left  = Math.random() * 30 + 'px';
  stage.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

// ═══════════════════════════════════════════════════════════════════════════
// WebSocket + signaling
// ═══════════════════════════════════════════════════════════════════════════
function connectSocket(sessionId, password, roomPassword) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  socket = new WebSocket(`${proto}://${location.host}`);

  socket.onopen = () => {
    setStatus('connected', 'Authenticating…');
    wsSend({ type: 'auth', token: myToken });
  };
  socket.onclose   = () => { setStatus('disconnected', 'Reconnecting…'); setTimeout(() => connectSocket(sessionId, password, roomPassword), 3000); };
  socket.onerror   = e => console.error('Socket error:', e);
  socket.onmessage = async ({ data }) => {
    let msg; try { msg = JSON.parse(data); } catch { return; }
    await handleSignal(msg, sessionId, password, roomPassword);
  };
}

function wsSend(obj) {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(obj));
}

async function handleSignal(msg, sessionId, password, roomPassword) {
  switch (msg.type) {

    case 'auth_ok':
      setStatus('connected', `Authenticated as ${msg.username}`);
      wsSend({ type: 'join', sessionId, password, roomPassword });
      break;

    case 'auth_error':
      setStatus('error', 'Auth failed — please reload'); break;

    case 'joined':
      myActorId = msg.actorId;
      setStatus('in_room', `In room "${msg.sessionId}"`);
      // Load existing files
      if (msg.files?.length) msg.files.forEach(f => renderFile(f));
      // Load transcript history
      if (msg.transcripts?.length) msg.transcripts.forEach(t => renderTranscript(t));
      // Connect to existing peers
      for (const p of msg.peers) {
        pendingNames.set(p.id, p.name);
        await createPeerConnection(p.id, p.name, p.role, true);
      }
      updatePeerCount();
      break;

    case 'peer_joined':
      pendingNames.set(msg.peerId, msg.name);
      addChatEvent(`${msg.name} joined`);
      updatePeerCount();
      break;

    case 'peer_left': {
      const leftName = peers.get(msg.peerId)?.name || msg.name || 'Someone';
      removePeer(msg.peerId);
      addChatEvent(`${leftName} left`);
      updatePeerCount();
      break;
    }

    case 'participants_update':
      renderParticipants(msg.participants); break;

    case 'offer':  await handleOffer(msg); break;

    case 'answer': {
      const p = peers.get(msg.senderId);
      if (p) await p.pc.setRemoteDescription(msg.sdp);
      break;
    }

    case 'ice_candidate': {
      const p = peers.get(msg.senderId);
      if (p && msg.candidate) try { await p.pc.addIceCandidate(msg.candidate); } catch {}
      break;
    }

    case 'screen_started':
      addChatEvent(`🖥 ${msg.senderName} started screen sharing`); break;
    case 'screen_stopped':
      addChatEvent(`🖥 ${msg.senderName} stopped screen sharing`); break;
    case 'recording_started':
      addChatEvent(`🔴 ${msg.senderName} started recording`); break;
    case 'recording_stopped':
      addChatEvent(`⏹ ${msg.senderName} stopped recording`); break;

    case 'photo':
      addPhotoToGallery(msg.dataURL, `${msg.senderName} (${msg.filter||'raw'})`, false); break;

    case 'file_shared':
      renderFile(msg.file); break;

    case 'reaction':
      showFlyingEmoji(msg.emoji, msg.senderName); break;

    case 'transcript':
      renderTranscript(msg);
      if (captionsOn || true) $('captionsText').textContent = msg.text;
      break;

    case 'chat':
      addChatMessage(msg.senderName, msg.text, false); break;

    case 'ctrl_mute_audio':
      if (msg.targetId === myActorId) { audioOn = true; toggleAudio(); addChatEvent(`🔇 Muted by ${msg.senderName}`); }
      break;
    case 'ctrl_mute_video':
      if (msg.targetId === myActorId) { videoOn = true; toggleVideo(); addChatEvent(`📵 Camera off by ${msg.senderName}`); }
      break;
    case 'kicked':
      alert(`You were removed: ${msg.reason}`);
      doLeave(); break;

    case 'error':
      if (msg.reason === 'wrong_password') $('joinError').textContent = 'Wrong room password';
      else setStatus('error', msg.reason);
      break;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// RTCPeerConnection
// ═══════════════════════════════════════════════════════════════════════════
async function createPeerConnection(peerId, peerName, peerRole, isInitiator) {
  if (peers.has(peerId)) return;

  const pc = new RTCPeerConnection(ICE_CONFIG);
  if (localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

  // Build tile
  const wrapper  = document.createElement('div');
  wrapper.className = 'remote-wrapper';
  wrapper.id     = `wrapper-${peerId}`;

  const video    = document.createElement('video');
  video.autoplay = true; video.playsInline = true; video.className = 'remote-video';

  const overlay  = document.createElement('div');
  overlay.className = 'tile-overlay';

  const nameEl   = document.createElement('span');
  nameEl.className = 'tile-name';
  nameEl.textContent = peerName || peerId.slice(0,8);

  const bar      = document.createElement('div');
  bar.className  = 'tile-bar';

  bar.append(
    mkTileBtn('⛶', 'Spotlight',   () => toggleSpotlight(peerId)),
    mkTileBtn('🔇', 'Mute audio',  () => { wsSend({ type:'ctrl_mute_audio', targetId:peerId }); addChatEvent(`You muted ${peerName}`); }),
    mkTileBtn('📵', 'Mute video',  () => { wsSend({ type:'ctrl_mute_video', targetId:peerId }); addChatEvent(`You turned off ${peerName}'s camera`); }),
    mkTileBtn('⛔', 'Kick',        () => { if(confirm(`Kick ${peerName}?`)) { wsSend({ type:'ctrl_kick', targetId:peerId }); } }, 'danger'),
  );

  overlay.append(nameEl, bar);
  wrapper.onclick = () => toggleSpotlight(peerId);
  wrapper.append(video, overlay);
  $('remoteGrid').appendChild(wrapper);

  peers.set(peerId, { pc, video, name: peerName, role: peerRole });

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) wsSend({ type:'ice_candidate', targetId:peerId, candidate });
  };
  pc.oniceconnectionstatechange = () => {
    const w = $(`wrapper-${peerId}`);
    if (w) w.dataset.ice = pc.iceConnectionState;
  };
  pc.ontrack = ({ streams }) => { video.srcObject = streams[0]; };
  pc.onnegotiationneeded = async () => {
    if (!isInitiator) return;
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      wsSend({ type:'offer', targetId:peerId, sdp:pc.localDescription });
    } catch (e) { console.error('offer error:', e); }
  };

  if (isInitiator) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    wsSend({ type:'offer', targetId:peerId, sdp:pc.localDescription });
  }
}

function mkTileBtn(icon, title, onclick, extraClass='') {
  const btn = document.createElement('button');
  btn.className = 'tile-btn' + (extraClass ? ' '+extraClass : '');
  btn.title = title; btn.textContent = icon;
  btn.onclick = e => { e.stopPropagation(); onclick(); };
  return btn;
}

async function handleOffer(msg) {
  const { senderId, sdp } = msg;
  const name = pendingNames.get(senderId) || msg.senderName || senderId.slice(0,6);
  pendingNames.delete(senderId);
  if (!peers.has(senderId)) await createPeerConnection(senderId, name, msg.senderRole, false);
  const { pc } = peers.get(senderId);
  await pc.setRemoteDescription(sdp);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  wsSend({ type:'answer', targetId:senderId, sdp:pc.localDescription });
}

function removePeer(peerId) {
  const p = peers.get(peerId);
  if (p) { p.pc.close(); peers.delete(peerId); }
  $(`wrapper-${peerId}`)?.remove();
  if (spotlightId === peerId) clearSpotlight();
}

// ═══════════════════════════════════════════════════════════════════════════
// Spotlight
// ═══════════════════════════════════════════════════════════════════════════
function toggleSpotlight(id) {
  if (spotlightId === id) { clearSpotlight(); return; }
  clearSpotlight();
  spotlightId = id;
  const t = id === 'local' ? $('localWrapper') : $(`wrapper-${id}`);
  if (t) t.classList.add('spotlight');
  $('remoteGrid').classList.add('has-spotlight');
}
function clearSpotlight() {
  const t = spotlightId === 'local' ? $('localWrapper') : $(`wrapper-${spotlightId}`);
  t?.classList.remove('spotlight');
  $('remoteGrid').classList.remove('has-spotlight');
  spotlightId = null;
}
$('localWrapper').onclick = () => toggleSpotlight('local');

// ═══════════════════════════════════════════════════════════════════════════
// Participants panel
// ═══════════════════════════════════════════════════════════════════════════
function renderParticipants(list) {
  const me = list.find(p => p.id === myActorId);
  const others = list.filter(p => p.id !== myActorId);
  const all = me ? [{ ...me, isMe: true }, ...others] : others;

  const html = all.map(p => {
    const initial = (p.name||'?')[0].toUpperCase();
    const muteIcons = `${p.audioMuted?'🔇':''}${p.videoMuted?'📵':''}`;
    const actions   = p.isMe ? '' : `
      <div class="participant-actions">
        <button title="Mute audio" onclick="wsSend({type:'ctrl_mute_audio',targetId:'${p.id}'})">🔇</button>
        <button title="Mute video" onclick="wsSend({type:'ctrl_mute_video',targetId:'${p.id}'})">📵</button>
        <button title="Kick"       onclick="if(confirm('Kick ${escapeHtml(p.name)}?'))wsSend({type:'ctrl_kick',targetId:'${p.id}'})">⛔</button>
      </div>`;
    return `<div class="participant-row">
      <div class="participant-avatar">${initial}</div>
      <span class="participant-name">${escapeHtml(p.name)}${p.isMe?' (you)':''}  ${muteIcons}</span>
      <span class="participant-role ${p.role==='admin'?'admin':''}">${p.role}</span>
      ${actions}
    </div>`;
  }).join('');

  $('participantList').innerHTML = html;

  // Also render admin participant list
  if (myRole === 'admin') {
    $('adminParticipantList').innerHTML = others.map(p => `
      <div class="participant-row">
        <span class="participant-name">${escapeHtml(p.name)}</span>
        <div class="participant-actions">
          <button onclick="wsSend({type:'ctrl_mute_audio',targetId:'${p.id}'})">🔇</button>
          <button onclick="wsSend({type:'ctrl_kick',targetId:'${p.id}'})">⛔</button>
        </div>
      </div>`).join('');
  }
}

function adminMuteAll() { wsSend({ type: 'admin_mute_all' }); addChatEvent('🔇 You muted everyone'); }

// ═══════════════════════════════════════════════════════════════════════════
// File sharing
// ═══════════════════════════════════════════════════════════════════════════
function shareFile(input) {
  const file = input.files[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) { alert('Max file size is 5 MB'); return; }

  const reader = new FileReader();
  reader.onload = () => {
    wsSend({
      type: 'file_share', name: file.name,
      size: file.size, fileType: file.type,
      dataURL: reader.result,
    });
  };
  reader.readAsDataURL(file);
  input.value = '';
}

function renderFile(file) {
  const list = $('fileList');
  const card = document.createElement('div');
  card.className = 'file-card';
  const size = file.size < 1024*1024
    ? `${(file.size/1024).toFixed(1)} KB`
    : `${(file.size/1024/1024).toFixed(1)} MB`;
  card.innerHTML = `
    <div class="file-card-name">📎 ${escapeHtml(file.name)}</div>
    <div class="file-card-meta">${size} · Shared by ${escapeHtml(file.senderName)}</div>
    <a href="${file.dataURL}" download="${escapeHtml(file.name)}">⬇ Download</a>`;
  list.prepend(card);
}

// ═══════════════════════════════════════════════════════════════════════════
// Photo + pixel filters
// ═══════════════════════════════════════════════════════════════════════════
const FILTERS = {
  grayscale(d) { for(let i=0;i<d.length;i+=4){const g=(d[i]+d[i+1]+d[i+2])/3;d[i]=d[i+1]=d[i+2]=g;} },
  invert(d)    { for(let i=0;i<d.length;i+=4){d[i]=255-d[i];d[i+1]=255-d[i+1];d[i+2]=255-d[i+2];} },
  sepia(d)     { for(let i=0;i<d.length;i+=4){const r=d[i],g=d[i+1],b=d[i+2];d[i]=Math.min(255,r*.393+g*.769+b*.189);d[i+1]=Math.min(255,r*.349+g*.686+b*.168);d[i+2]=Math.min(255,r*.272+g*.534+b*.131);} },
  redboost(d)  { for(let i=0;i<d.length;i+=4){d[i]=Math.min(255,d[i]*1.5);d[i+1]*=.7;d[i+2]*=.7;} },
  pixelate(d,w,h){ const s=10;for(let y=0;y<h;y+=s)for(let x=0;x<w;x+=s){const idx=(y*w+x)*4,r=d[idx],g=d[idx+1],b=d[idx+2];for(let py=0;py<s&&y+py<h;py++)for(let px=0;px<s&&x+px<w;px++){const i=((y+py)*w+(x+px))*4;d[i]=r;d[i+1]=g;d[i+2]=b;}} },
  none()       {},
};

function captureAndProcess() {
  const canvas = $('canvas'), ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const vid = $('localVideo');
  try {
    ctx.drawImage(vid, 0, 0, W, H);
    const id = ctx.getImageData(0,0,W,H);
    const filter = $('filterSelect').value || 'grayscale';
    if (FILTERS[filter]) FILTERS[filter](id.data, W, H);
    ctx.putImageData(id, 0, 0);
    const dataURL = canvas.toDataURL('image/jpeg', 0.8);
    addPhotoToGallery(dataURL, `You (${filter})`, true);
    wsSend({ type:'photo', dataURL, filter });
  } catch(e) {
    console.warn('Canvas tainted, raw capture:', e.message);
    ctx.drawImage(vid, 0, 0, W, H);
    const dataURL = canvas.toDataURL('image/jpeg', 0.8);
    addPhotoToGallery(dataURL, 'You (raw)', true);
    wsSend({ type:'photo', dataURL, filter:'none' });
  }
}

function addPhotoToGallery(dataURL, label, isLocal) {
  const card = document.createElement('div');
  card.className = 'photo-card' + (isLocal ? ' local' : '');
  const img = document.createElement('img'); img.src = dataURL; img.title = label;
  const lbl = document.createElement('span'); lbl.textContent = label;
  card.append(img, lbl);
  $('photoGallery').prepend(card);
  while ($('photoGallery').children.length > 40) $('photoGallery').lastChild.remove();
}

// ═══════════════════════════════════════════════════════════════════════════
// Transcript
// ═══════════════════════════════════════════════════════════════════════════
function renderTranscript(entry) {
  const log = $('transcriptLog');
  // Remove last interim if exists
  const last = log.lastElementChild;
  if (last && last.classList.contains('interim')) last.remove();

  const div = document.createElement('div');
  div.className = 'transcript-entry' + (entry.final ? '' : ' interim');
  div.innerHTML = `<strong>${escapeHtml(entry.senderName||'?')} ${new Date(entry.ts||Date.now()).toLocaleTimeString()}</strong>${escapeHtml(entry.text)}`;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

// ═══════════════════════════════════════════════════════════════════════════
// Chat
// ═══════════════════════════════════════════════════════════════════════════
function sendChat() {
  const text = $('chatInput').value.trim();
  if (!text) return;
  wsSend({ type:'chat', text });
  addChatMessage('You', text, true);
  $('chatInput').value = '';
}
function addChatMessage(name, text, isMe) {
  const div = document.createElement('div');
  div.className = 'chat-msg' + (isMe ? ' me' : '');
  div.innerHTML = `<strong>${escapeHtml(name)}</strong>${escapeHtml(text)}`;
  $('chatLog').appendChild(div);
  $('chatLog').scrollTop = $('chatLog').scrollHeight;
}
function addChatEvent(text) {
  const div = document.createElement('div');
  div.className = 'chat-event'; div.textContent = `• ${text}`;
  $('chatLog').appendChild(div);
  $('chatLog').scrollTop = $('chatLog').scrollHeight;
}

// ═══════════════════════════════════════════════════════════════════════════
// Sidebar tabs
// ═══════════════════════════════════════════════════════════════════════════
function sidebarTab(name) {
  document.querySelectorAll('.stab').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.stab-content').forEach(c => c.style.display='none');
  event.target.classList.add('active');
  $(`tab-${name}`).style.display = 'block';
}

// ═══════════════════════════════════════════════════════════════════════════
// UI helpers
// ═══════════════════════════════════════════════════════════════════════════
function setStatus(state, text) {
  $('statusDot').className   = 'dot ' + state;
  $('statusText').textContent = text;
}
function updatePeerCount() { $('peerCount').textContent = peers.size; }
function escapeHtml(s='') { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ═══════════════════════════════════════════════════════════════════════════
// Leave
// ═══════════════════════════════════════════════════════════════════════════
function doLeave() {
  stopCaptions();
  stopRecording();
  stopScreen();
  peers.forEach((_, id) => removePeer(id));
  socket?.close();
  localStream?.getTracks().forEach(t => t.stop());
  $('localVideo').srcObject = null;
  $('confScreen').style.display = 'none';
  $('joinScreen').style.display  = 'flex';
  setStatus('disconnected', 'Left');
}

// Expose globals called from inline HTML onclick
window.toggleSpotlight  = toggleSpotlight;
window.sendReaction     = sendReaction;
window.toggleAudio      = toggleAudio;
window.toggleVideo      = toggleVideo;
window.toggleScreen     = toggleScreen;
window.toggleRecord     = toggleRecord;
window.toggleCaptions   = toggleCaptions;
window.exportTranscript = exportTranscript;
window.captureAndProcess= captureAndProcess;
window.sendChat         = sendChat;
window.doLogin          = doLogin;
window.doRegister       = doRegister;
window.switchAuthTab    = switchAuthTab;
window.doJoin           = doJoin;
window.doLeave          = doLeave;
window.showAdminPanel   = showAdminPanel;
window.hideAdminPanel   = hideAdminPanel;
window.adminTab         = adminTab;
window.adminMuteAll     = adminMuteAll;
window.adminCloseSession= adminCloseSession;
window.shareFile        = shareFile;
window.wsSend           = wsSend;
window.sidebarTab       = sidebarTab;
