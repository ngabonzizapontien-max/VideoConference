'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// VIDEOCONF — Client App
// Features: 20 actors · STUN/TURN/ICE · sessions · photo+filters
//           spotlight expand · remote mute audio/video · kick · chat
// ═══════════════════════════════════════════════════════════════════════════

const ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    {
      urls: ['stun:coturn:3478','turn:coturn:3478','turns:coturn:5349'],
      username: 'user',
      credential: 'password123',
    },
  ],
  iceCandidatePoolSize: 10,
};

// ── Session persistence ───────────────────────────────────────────────────
const SESSION_KEY = 'vc_session';
function savedSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY)) || {}; }
  catch { return {}; }
}
function saveSession(obj) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(obj));
}

// ── DOM refs ──────────────────────────────────────────────────────────────
const localVideo     = document.getElementById('localVideo');
const localWrapper   = document.getElementById('localWrapper');
const canvas         = document.getElementById('canvas');
const ctx            = canvas.getContext('2d');
const remoteGrid     = document.getElementById('remoteGrid');
const chatLog        = document.getElementById('chatLog');
const chatInput      = document.getElementById('chatInput');
const peerCount      = document.getElementById('peerCount');
const statusDot      = document.getElementById('statusDot');
const statusText     = document.getElementById('statusText');
const photoGallery   = document.getElementById('photoGallery');
const sessionIdInput = document.getElementById('sessionIdInput');
const nameInput      = document.getElementById('nameInput');
const filterSelect   = document.getElementById('filterSelect');

// ── State ─────────────────────────────────────────────────────────────────
let localStream = null;
let myActorId   = null;
let myName      = null;
let sessionId   = null;
let socket      = null;
let spotlightId = null;

// peers: Map<peerId, { pc, video, name }>
const peers = new Map();

// ── Restore session ───────────────────────────────────────────────────────
const prev = savedSession();
if (prev.sessionId) sessionIdInput.value = prev.sessionId;
if (prev.name)      nameInput.value      = prev.name;

// ═══════════════════════════════════════════════════════════════════════════
// getUserMedia
// ═══════════════════════════════════════════════════════════════════════════
async function startMedia() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, frameRate: 30 },
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    localVideo.srcObject = localStream;
    setStatus('media_ok', 'Camera ready');
    return true;
  } catch (err) {
    setStatus('error', 'Camera denied: ' + err.message);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// WebSocket
// ═══════════════════════════════════════════════════════════════════════════
function connectSocket() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  socket = new WebSocket(`${proto}://${location.host}`);
  socket.onopen    = () => { setStatus('connected', 'Connected'); joinRoom(); };
  socket.onclose   = () => { setStatus('disconnected', 'Reconnecting…'); setTimeout(connectSocket, 3000); };
  socket.onerror   = (e) => console.error('Socket error:', e);
  socket.onmessage = async ({ data }) => {
    let msg; try { msg = JSON.parse(data); } catch { return; }
    await handleSignal(msg);
  };
}

function wsSend(obj) {
  if (socket && socket.readyState === WebSocket.OPEN)
    socket.send(JSON.stringify(obj));
}

function joinRoom() {
  sessionId = sessionIdInput.value.trim() || 'default';
  myName    = nameInput.value.trim()      || `Actor-${Date.now().toString(36)}`;
  saveSession({ sessionId, name: myName });
  wsSend({ type: 'join', sessionId, name: myName });
}

// ═══════════════════════════════════════════════════════════════════════════
// Signaling
// ═══════════════════════════════════════════════════════════════════════════
async function handleSignal(msg) {
  switch (msg.type) {

    case 'joined':
      myActorId = msg.actorId;
      setStatus('in_room', `Room "${msg.sessionId}" · ${myName}`);
      for (const peer of msg.peers)
        await createPeerConnection(peer.id, peer.name, true);
      updatePeerCount();
      break;

    case 'peer_joined':
      addChatEvent(`${msg.name} joined`);
      updatePeerCount();
      break;

    case 'peer_left':
      removePeer(msg.peerId);
      addChatEvent(`A peer left`);
      updatePeerCount();
      break;

    case 'offer':  await handleOffer(msg); break;

    case 'answer': {
      const p = peers.get(msg.senderId);
      if (p) await p.pc.setRemoteDescription(msg.sdp);
      break;
    }

    case 'ice_candidate': {
      const p = peers.get(msg.senderId);
      if (p && msg.candidate)
        try { await p.pc.addIceCandidate(msg.candidate); } catch {}
      break;
    }

    case 'photo':  displayRemotePhoto(msg); break;
    case 'chat':   addChatMessage(msg.senderName, msg.text, false); break;

    // ── Remote control commands received ───────────────────────────────
    case 'ctrl_mute_audio':
      if (msg.targetId === myActorId) {
        setLocalAudio(false);
        addChatEvent(`🔇 You were muted by ${msg.senderName}`);
      }
      break;

    case 'ctrl_mute_video':
      if (msg.targetId === myActorId) {
        setLocalVideo(false);
        addChatEvent(`📵 Your camera was turned off by ${msg.senderName}`);
      }
      break;

    case 'ctrl_kick':
      if (msg.targetId === myActorId) {
        addChatEvent(`⛔ You were kicked by ${msg.senderName}`);
        document.getElementById('btnLeave').click();
      }
      break;

    case 'error': setStatus('error', msg.reason); break;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// RTCPeerConnection
// ═══════════════════════════════════════════════════════════════════════════
async function createPeerConnection(peerId, peerName, isInitiator) {
  if (peers.has(peerId)) return;

  const pc = new RTCPeerConnection(ICE_CONFIG);
  if (localStream)
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

  // ── Build video tile ────────────────────────────────────────────────────
  const wrapper = document.createElement('div');
  wrapper.className = 'remote-wrapper';
  wrapper.id = `wrapper-${peerId}`;

  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  video.className = 'remote-video';

  const label = document.createElement('span');
  label.className = 'peer-label';
  label.textContent = peerName || peerId.slice(0, 8);

  // ── Tile action bar ─────────────────────────────────────────────────────
  const bar = document.createElement('div');
  bar.className = 'tile-bar';

  const btnExpand = mkTileBtn('⛶', 'Expand / Spotlight', () => toggleSpotlight(peerId));
  const btnMuteA  = mkTileBtn('🔇', 'Mute audio', () => {
    wsSend({ type: 'ctrl_mute_audio', targetId: peerId });
    addChatEvent(`You muted ${peerName}'s audio`);
  });
  const btnMuteV  = mkTileBtn('📵', 'Turn off camera', () => {
    wsSend({ type: 'ctrl_mute_video', targetId: peerId });
    addChatEvent(`You turned off ${peerName}'s camera`);
  });
  const btnKick   = mkTileBtn('⛔', 'Kick', () => {
    if (confirm(`Kick ${peerName}?`)) {
      wsSend({ type: 'ctrl_kick', targetId: peerId });
      addChatEvent(`You kicked ${peerName}`);
    }
  }, 'danger');

  bar.append(btnExpand, btnMuteA, btnMuteV, btnKick);

  // Click anywhere on tile = spotlight
  wrapper.onclick = () => toggleSpotlight(peerId);

  wrapper.append(video, label, bar);
  remoteGrid.appendChild(wrapper);

  peers.set(peerId, { pc, video, name: peerName });

  // ── ICE ─────────────────────────────────────────────────────────────────
  pc.onicecandidate = ({ candidate }) => {
    if (candidate) wsSend({ type: 'ice_candidate', targetId: peerId, candidate });
  };
  pc.oniceconnectionstatechange = () => {
    const w = document.getElementById(`wrapper-${peerId}`);
    if (w) w.dataset.ice = pc.iceConnectionState;
  };
  pc.ontrack = ({ streams }) => { video.srcObject = streams[0]; };
  pc.onnegotiationneeded = async () => {
    if (!isInitiator) return;
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      wsSend({ type: 'offer', targetId: peerId, sdp: pc.localDescription });
    } catch (e) { console.error('offer error:', e); }
  };

  if (isInitiator) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    wsSend({ type: 'offer', targetId: peerId, sdp: pc.localDescription });
  }
}

function mkTileBtn(icon, title, onclick, extraClass = '') {
  const btn = document.createElement('button');
  btn.className = 'tile-btn' + (extraClass ? ' ' + extraClass : '');
  btn.title = title;
  btn.textContent = icon;
  btn.onclick = (e) => { e.stopPropagation(); onclick(); };
  return btn;
}

async function handleOffer(msg) {
  const { senderId, sdp, senderName } = msg;
  if (!peers.has(senderId))
    await createPeerConnection(senderId, senderName, false);
  const { pc } = peers.get(senderId);
  await pc.setRemoteDescription(sdp);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  wsSend({ type: 'answer', targetId: senderId, sdp: pc.localDescription });
}

function removePeer(peerId) {
  const p = peers.get(peerId);
  if (p) { p.pc.close(); peers.delete(peerId); }
  document.getElementById(`wrapper-${peerId}`)?.remove();
  if (spotlightId === peerId) clearSpotlight();
}

// ═══════════════════════════════════════════════════════════════════════════
// Spotlight — expand any tile to fill the video section
// ═══════════════════════════════════════════════════════════════════════════
function toggleSpotlight(id) {
  if (spotlightId === id) { clearSpotlight(); return; }
  clearSpotlight();
  spotlightId = id;
  const target = id === 'local'
    ? localWrapper
    : document.getElementById(`wrapper-${id}`);
  if (target) target.classList.add('spotlight');
  remoteGrid.classList.add('has-spotlight');
}

function clearSpotlight() {
  const target = spotlightId === 'local'
    ? localWrapper
    : document.getElementById(`wrapper-${spotlightId}`);
  target?.classList.remove('spotlight');
  remoteGrid.classList.remove('has-spotlight');
  spotlightId = null;
}

// Click local video to spotlight it
localWrapper.onclick = () => toggleSpotlight('local');

// ═══════════════════════════════════════════════════════════════════════════
// Local mute controls
// ═══════════════════════════════════════════════════════════════════════════
function setLocalAudio(enabled) {
  if (!localStream) return;
  localStream.getAudioTracks().forEach(t => t.enabled = enabled);
  document.getElementById('btnToggleAudio').textContent = enabled ? '🎤 Mute' : '🔇 Unmute';
}
function setLocalVideo(enabled) {
  if (!localStream) return;
  localStream.getVideoTracks().forEach(t => t.enabled = enabled);
  document.getElementById('btnToggleVideo').textContent = enabled ? '📷 Cam off' : '📵 Cam on';
}

// ═══════════════════════════════════════════════════════════════════════════
// Photo + pixel filters
// ═══════════════════════════════════════════════════════════════════════════
const FILTERS = {
  grayscale(data) {
    for (let i = 0; i < data.length; i += 4) {
      const g = (data[i]+data[i+1]+data[i+2])/3;
      data[i] = data[i+1] = data[i+2] = g;
    }
  },
  invert(data) {
    for (let i = 0; i < data.length; i += 4) {
      data[i]=255-data[i]; data[i+1]=255-data[i+1]; data[i+2]=255-data[i+2];
    }
  },
  sepia(data) {
    for (let i = 0; i < data.length; i += 4) {
      const r=data[i],g=data[i+1],b=data[i+2];
      data[i]  =Math.min(255,r*.393+g*.769+b*.189);
      data[i+1]=Math.min(255,r*.349+g*.686+b*.168);
      data[i+2]=Math.min(255,r*.272+g*.534+b*.131);
    }
  },
  redboost(data) {
    for (let i = 0; i < data.length; i += 4) {
      data[i]=Math.min(255,data[i]*1.5);
      data[i+1]*=0.7; data[i+2]*=0.7;
    }
  },
  pixelate(data,w,h) {
    const s=10;
    for (let y=0;y<h;y+=s)
      for (let x=0;x<w;x+=s) {
        const idx=(y*w+x)*4,r=data[idx],g=data[idx+1],b=data[idx+2];
        for (let py=0;py<s&&y+py<h;py++)
          for (let px=0;px<s&&x+px<w;px++) {
            const i=((y+py)*w+(x+px))*4;
            data[i]=r; data[i+1]=g; data[i+2]=b;
          }
      }
  },
  none() {},
};

function captureAndProcess() {
  const W=canvas.width, H=canvas.height;
  ctx.drawImage(localVideo,0,0,W,H);
  const imageData=ctx.getImageData(0,0,W,H);
  const filter=filterSelect.value||'grayscale';
  if (FILTERS[filter]) FILTERS[filter](imageData.data,W,H);
  ctx.putImageData(imageData,0,0);
  const dataURL=canvas.toDataURL('image/jpeg',0.8);
  addPhotoToGallery(dataURL,`You (${filter})`,true);
  wsSend({ type:'photo', dataURL, filter });
}

function displayRemotePhoto(msg) {
  addPhotoToGallery(msg.dataURL,`${msg.senderName} (${msg.filter||'raw'})`,false);
}

function addPhotoToGallery(dataURL,label,isLocal) {
  const card=document.createElement('div');
  card.className='photo-card'+(isLocal?' local':'');
  const img=document.createElement('img');
  img.src=dataURL; img.title=label;
  const lbl=document.createElement('span');
  lbl.textContent=label;
  card.append(img,lbl);
  photoGallery.prepend(card);
  while (photoGallery.children.length>40) photoGallery.lastChild.remove();
}

// ═══════════════════════════════════════════════════════════════════════════
// Chat
// ═══════════════════════════════════════════════════════════════════════════
function sendChat() {
  const text=chatInput.value.trim();
  if (!text) return;
  wsSend({ type:'chat', text });
  addChatMessage('You',text,true);
  chatInput.value='';
}
function addChatMessage(name,text,isMe) {
  const div=document.createElement('div');
  div.className='chat-msg'+(isMe?' me':'');
  div.innerHTML=`<strong>${name}:</strong> ${escapeHtml(text)}`;
  chatLog.appendChild(div);
  chatLog.scrollTop=chatLog.scrollHeight;
}
function addChatEvent(text) {
  const div=document.createElement('div');
  div.className='chat-event';
  div.textContent=`• ${text}`;
  chatLog.appendChild(div);
  chatLog.scrollTop=chatLog.scrollHeight;
}
function escapeHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ═══════════════════════════════════════════════════════════════════════════
// UI
// ═══════════════════════════════════════════════════════════════════════════
function setStatus(state,text) {
  statusDot.className='dot '+state;
  statusText.textContent=text;
}
function updatePeerCount() { peerCount.textContent=peers.size; }

// ── Buttons ───────────────────────────────────────────────────────────────
document.getElementById('btnJoin').onclick = async () => {
  const ok = await startMedia();
  if (ok) connectSocket();
};
document.getElementById('btnCapture').onclick = captureAndProcess;
document.getElementById('btnSendChat').onclick = sendChat;
chatInput.addEventListener('keydown', e => { if (e.key==='Enter') sendChat(); });

let audioOn=true, videoOn=true;
document.getElementById('btnToggleAudio').onclick = () => {
  audioOn=!audioOn; setLocalAudio(audioOn);
};
document.getElementById('btnToggleVideo').onclick = () => {
  videoOn=!videoOn; setLocalVideo(videoOn);
};

document.getElementById('btnLeave').onclick = () => {
  peers.forEach((_,id)=>removePeer(id));
  if (socket) socket.close();
  localStream?.getTracks().forEach(t=>t.stop());
  localVideo.srcObject=null;
  setStatus('disconnected','Left the room');
};
