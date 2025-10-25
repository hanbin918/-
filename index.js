// Hiby (하이비)
// 익명 5인 채팅방 서비스
// - 닉네임: 유저가 직접 정함 / 중복 불가 / (지금은 1분 쿨다운, 실제는 3일 가능)
// - 욕설하면 5분 뮤트
// - 비슷한 말 도배하면 3분 뮤트
// - 방 만들 때 비번(4자리 숫자) 선택 가능
// - 방은 최대 5명, 방 안 비면 자동 삭제

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

// ==============================
// 상태 저장용 메모리
// ==============================
const users = {
  // socket.id: {
  //   name: "닉네임",
  //   lastRename: timestamp,
  //   muteUntil: timestamp,
  //   recentMsgs: [ {text, time} ],
  //   roomId: "현재 들어간 방 id 또는 null"
  // }
};

const takenNames = new Set(); // 이미 쓰는 닉네임들
const rooms = {
  // roomId: {
  //   name: "방 이름",
  //   password: "1234" or null,
  //   users: { socketId: "닉네임", ... }
  // }
};

// 욕설 목록
const badWords = [
  "시발",
  "씨발",
  "씨ㅂ",
  "병신",
  "병1신",
  "좆",
  "ㅈ같",
  "fuck",
  "shit",
  "bitch",
  "개새끼",
];

// 시간 값(ms)
const RENAME_COOLDOWN = 60 * 1000; // 테스트용: 1분
// 실제 서비스 전환 시 3일:
// const RENAME_COOLDOWN = 3 * 24 * 60 * 60 * 1000;

const MUTE_PROFANITY_MS = 5 * 60 * 1000; // 욕설 -> 5분
const MUTE_SPAM_MS = 3 * 60 * 1000; // 도배 -> 3분

// 스팸 판정 기준
const SPAM_CHECK_WINDOW = 10 * 1000; // 최근 10초 안 메시지들만 본다
const SPAM_SIMILAR_THRESHOLD = 0.8; // 80% 이상 비슷하면 "같은 말"이라고 침
const SPAM_MIN_REPEATS = 3; // 같은/유사 메시지 3번이면 스팸 처리

// ==============================
// 유틸 함수들
// ==============================

// 랜덤 방 ID 생성
function makeRoomId() {
  return Math.random().toString(36).slice(2, 8);
}

// 아주 단순한 문자열 유사도 추정
function similarity(a, b) {
  if (!a || !b) return 0;
  const lenA = a.length;
  const lenB = b.length;
  if (lenA === 0 || lenB === 0) return 0;

  let sameCount = 0;
  const short = lenA < lenB ? a : b;
  const long = lenA < lenB ? b : a;
  for (let ch of short) {
    if (long.includes(ch)) sameCount++;
  }

  const ratioCommon = sameCount / short.length;
  const ratioLen = Math.min(lenA, lenB) / Math.max(lenA, lenB);
  return (ratioCommon + ratioLen) / 2;
}

// 욕설 체크
function hasBadWord(text) {
  const lowered = text.toLowerCase();
  return badWords.some((bw) => lowered.includes(bw));
}

// 도배 / 스팸 체크
function isSpam(userData, newText) {
  const now = Date.now();

  // 최근 SPAM_CHECK_WINDOW 안 메시지들만 남긴다
  const recent = userData.recentMsgs.filter(
    (m) => now - m.time <= SPAM_CHECK_WINDOW
  );

  let similarCount = 0;
  for (const msg of recent) {
    if (similarity(msg.text, newText) >= SPAM_SIMILAR_THRESHOLD) {
      similarCount++;
    }
  }

  // 현재 메시지 push
  recent.push({ text: newText, time: now });
  userData.recentMsgs = recent;

  // 비슷한 메시지가 연속으로 많이 나오면 스팸
  return similarCount + 1 >= SPAM_MIN_REPEATS;
}

// 방에 아무도 없으면 방 삭제
function cleanupEmptyRooms() {
  for (const [roomId, room] of Object.entries(rooms)) {
    if (Object.keys(room.users).length === 0) {
      delete rooms[roomId];
    }
  }
}

// 프론트에 보내줄 방 목록
function serializeRooms() {
  return Object.entries(rooms).map(([id, room]) => ({
    id,
    name: room.name,
    locked: room.password ? true : false,
    count: Object.keys(room.users).length,
    max: 5,
  }));
}

// 방 참여자 목록 브로드캐스트
function broadcastUserList(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  const nicknameList = Object.values(room.users);
  io.to(roomId).emit("userList", {
    roomId,
    roomName: room.name,
    count: nicknameList.length,
    max: 5,
    nicknameList,
  });
}

// 시스템 메시지 전송
function broadcastSystem(roomId, text) {
  const room = rooms[roomId];
  if (!room) return;
  const ts = Date.now();
  io.to(roomId).emit("systemMessage", {
    roomId,
    text,
    timestamp: ts,
  });
}

// 방 입장 처리 (비번 체크까지)
function handleJoinRoom(socket, roomId, passwordTry) {
  const u = users[socket.id];
  if (!u || !u.name) {
    socket.emit("joinResult", {
      ok: false,
      error: "먼저 닉네임을 설정해 주세요.",
    });
    return;
  }

  const room = rooms[roomId];
  if (!room) {
    socket.emit("joinResult", {
      ok: false,
      error: "존재하지 않는 방입니다.",
    });
    return;
  }

  // 인원 제한
  if (Object.keys(room.users).length >= 5) {
    socket.emit("joinResult", {
      ok: false,
      error: "이 방은 이미 가득 찼어요 (5/5).",
    });
    return;
  }

  // 비밀번호가 있는 방이면 확인
  if (room.password) {
    if (!passwordTry) {
      socket.emit("joinResult", {
        ok: false,
        needPassword: true,
        roomId,
        roomName: room.name,
        count: Object.keys(room.users).length,
        error: "비밀번호가 필요한 방입니다.",
      });
      return;
    }
    if (passwordTry !== room.password) {
      socket.emit("joinResult", {
        ok: false,
        needPassword: true,
        roomId,
        roomName: room.name,
        count: Object.keys(room.users).length,
        error: "비밀번호가 맞지 않아요.",
      });
      return;
    }
  }

  // 기존 방에서 빼주기
  if (u.roomId && rooms[u.roomId]) {
    const oldRoom = rooms[u.roomId];
    if (oldRoom.users[socket.id]) {
      const prevNick = oldRoom.users[socket.id];
      delete oldRoom.users[socket.id];
      broadcastSystem(u.roomId, `${prevNick} 님이 나갔어요.`);
      broadcastUserList(u.roomId);
    }
  }

  // 새 방에 등록
  u.roomId = roomId;
  room.users[socket.id] = u.name;
  socket.join(roomId);

  broadcastSystem(roomId, `${u.name} 님이 입장했어요.`);
  broadcastUserList(roomId);

  socket.emit("joinResult", {
    ok: true,
    roomId,
    roomName: room.name,
    count: Object.keys(room.users).length,
    max: 5,
    nicknameList: Object.values(room.users),
  });

  // 혹시 비어 있는 방 정리
  cleanupEmptyRooms();
  io.emit("roomsUpdate", serializeRooms());
}

// 방 나가기 처리
function handleLeaveRoom(socket, roomId) {
  const u = users[socket.id];
  if (!u) return;

  const room = rooms[roomId];
  if (!room) return;

  if (room.users[socket.id]) {
    const nickname = room.users[socket.id];
    delete room.users[socket.id];
    broadcastSystem(roomId, `${nickname} 님이 나갔어요.`);
    broadcastUserList(roomId);
  }

  socket.leave(roomId);

  if (u.roomId === roomId) {
    u.roomId = null;
  }

  cleanupEmptyRooms();
  io.emit("roomsUpdate", serializeRooms());
}

// 채팅 전송 처리
function handleChat(socket, roomId, text) {
  const u = users[socket.id];
  if (!u || !u.name) return;
  if (u.roomId !== roomId) return;

  const room = rooms[roomId];
  if (!room) return;

  const now = Date.now();

  // mute 체크
  if (u.muteUntil && now < u.muteUntil) {
    socket.emit("muted", {
      roomId,
      reason: "채팅 제한 중",
      until: u.muteUntil,
    });
    return;
  }

  const cleanText = (text || "").trim();
  if (!cleanText) return;

  // 욕설이면 바로 5분 뮤트
  if (hasBadWord(cleanText)) {
    u.muteUntil = now + MUTE_PROFANITY_MS;
    socket.emit("muted", {
      roomId,
      reason: "욕설 사용",
      until: u.muteUntil,
    });
    return;
  }

  // 스팸이면 3분 뮤트
  if (isSpam(u, cleanText)) {
    u.muteUntil = now + MUTE_SPAM_MS;
    socket.emit("muted", {
      roomId,
      reason: "반복/도배",
      until: u.muteUntil,
    });
    return;
  }

  // 정상 채팅이면 방 전체로 브로드캐스트
  const ts = Date.now();
  io.to(roomId).emit("chatMessage", {
    roomId,
    nickname: u.name,
    text: cleanText,
    timestamp: ts,
  });
}

// ==============================
// 클라이언트 HTML
// ==============================

app.get("/", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Hiby (하이비)</title>
<style>
  body {
    margin:0;
    background:#0f172a;
    color:#f8fafc;
    font-family: system-ui,-apple-system,BlinkMacSystemFont,"Pretendard",Roboto,sans-serif;
  }
  .wrapper {
    max-width:480px;
    margin:2rem auto;
    padding:1rem;
  }
  .title {
    font-size:1.5rem;
    font-weight:700;
    text-align:center;
    color:#fff;
  }
  .subtitle {
    text-align:center;
    color:#94a3b8;
    font-size:0.9rem;
    margin-bottom:1.5rem;
  }
  .card {
    background:#1e253a;
    border-radius:1rem;
    padding:1rem 1rem 1.25rem;
    box-shadow:0 20px 40px rgba(0,0,0,0.6);
    margin-bottom:1rem;
    border:1px solid #2a334d;
  }
  .row {
    display:flex;
    gap:0.5rem;
    align-items:center;
    flex-wrap:wrap;
  }
  .between { justify-content:space-between; }
  .input {
    flex:1;
    background:#0f172a;
    border:1px solid #475569;
    border-radius:0.6rem;
    padding:0.7rem 0.8rem;
    color:#f8fafc;
    font-size:0.9rem;
    outline:none;
  }
  .input:focus { border-color:#818cf8; }
  .btn {
    background:#4f46e5;
    border:0;
    border-radius:0.6rem;
    padding:0.7rem 0.9rem;
    color:#fff;
    font-weight:600;
    font-size:0.9rem;
    cursor:pointer;
  }
  .btn.ghost {
    background:transparent;
    border:1px solid #475569;
    color:#cbd5e1;
  }
  .status {
    color:#facc15;
    font-size:0.8rem;
    margin-top:0.5rem;
  }
  .danger {
    color:#f87171;
    font-size:0.8rem;
    margin-top:0.5rem;
  }
  .roomList {
    list-style:none;
    padding:0;
    margin:0;
  }
  .roomItem {
    display:flex;
    justify-content:space-between;
    align-items:center;
    background:#0f172a;
    border:1px solid #2a334d;
    border-radius:0.75rem;
    padding:0.9rem 1rem;
    cursor:pointer;
    margin-bottom:0.6rem;
  }
  .roomItem:hover { background:#1e253a; }
  .roomInfo { display:flex; flex-direction:column; }
  .roomName {
    font-weight:600;
    color:#fff;
    font-size:0.95rem;
    display:flex;
    gap:0.4rem;
    align-items:center;
  }
  .lockIcon {
    font-size:0.8rem;
    color:#facc15;
    background:#4f46e51a;
    border:1px solid #4f46e5;
    border-radius:0.4rem;
    padding:0.1rem 0.4rem;
  }
  .roomMeta {
    font-size:0.8rem;
    color:#94a3b8;
  }
  .enterHint {
    font-size:0.8rem;
    color:#818cf8;
    font-weight:500;
  }
  .footer {
    text-align:center;
    color:#475569;
    font-size:0.7rem;
    margin-top:2rem;
  }
  .overlay {
    position:fixed;
    inset:0;
    background:#0f172a;
    display:none;
    flex-direction:column;
    max-width:480px;
    margin:0 auto;
    border-left:1px solid #2a334d;
    border-right:1px solid #2a334d;
  }
  .panelHeader {
    flex-shrink:0;
    background:#1e253a;
    border-bottom:1px solid #2a334d;
    padding:0.8rem 1rem;
    display:flex;
    justify-content:space-between;
    align-items:flex-start;
  }
  .panelTitle {
    color:#fff;
    font-size:1rem;
    font-weight:600;
  }
  .panelSubtitle {
    color:#94a3b8;
    font-size:0.7rem;
    margin-top:0.2rem;
  }
  .panelBody {
    flex:1;
    overflow-y:auto;
    padding:1rem;
    background:#0f172a;
    display:flex;
    flex-direction:column;
    gap:0.75rem;
  }
  .chatLog {
    flex:1;
    overflow-y:auto;
    display:flex;
    flex-direction:column;
    gap:0.75rem;
  }
  .bubble {
    max-width:80%;
    background:#1e253a;
    border:1px solid #2a334d;
    border-radius:0.8rem;
    padding:0.6rem 0.75rem;
    font-size:0.9rem;
    line-height:1.4;
    word-break:break-word;
  }
  .me {
    background:#4f46e5;
    border:1px solid #6366f1;
    align-self:flex-end;
  }
  .system {
    background:transparent;
    border:0;
    color:#94a3b8;
    font-size:0.75rem;
    text-align:center;
    max-width:100%;
  }
  .bubbleHeader {
    display:flex;
    gap:0.5rem;
    font-size:0.7rem;
    color:#94a3b8;
    margin-bottom:0.3rem;
    align-items:baseline;
  }
  .me .bubbleHeader { color:#c7c9ff; }
  .bubbleNick {
    font-weight:600;
    color:#fff;
    font-size:0.7rem;
  }
  .me .bubbleNick { color:#fff; }
  .bubbleText {
    color:#f8fafc;
    font-size:0.9rem;
    white-space:pre-wrap;
  }
  .bubbleTime {
    font-size:0.7rem;
    color:#94a3b8;
  }
  .inputBar {
    flex-shrink:0;
    display:flex;
    gap:0.5rem;
    border-top:1px solid #2a334d;
    background:#1e253a;
    padding:0.8rem 1rem;
  }
  .textField {
    flex:1;
    background:#0f172a;
    border:1px solid #475569;
    border-radius:0.6rem;
    padding:0.7rem 0.8rem;
    color:#f8fafc;
    font-size:0.9rem;
    outline:none;
  }
  .textField:focus { border-color:#818cf8; }
  .muteNotice {
    color:#f87171;
    font-size:0.8rem;
    text-align:center;
  }
</style>
</head>
<body>
  <div class="wrapper" id="homeView">
    <h1 class="title">Hiby</h1>
    <p class="subtitle">익명 5인 소규모 실시간 톡룸</p>

    <div class="card">
      <h2 style="margin-top:0;">닉네임</h2>
      <div class="row">
        <input id="nicknameInput" class="input" placeholder="닉네임 입력 (중복불가)" />
        <button class="btn" id="setNickBtn">설정 / 변경</button>
      </div>
      <p class="status" id="nickStatus"></p>
      <p class="danger" id="nickError"></p>
      <small style="color:#64748b;font-size:0.7rem;">(닉네임은 1분에 한 번만 바꿀 수 있어요 · 실제 서비스에선 3일)</small>
    </div>

    <div class="card">
      <h2 style="margin-top:0;">방 만들기</h2>
      <div class="row">
        <input id="roomNameInput" class="input" placeholder="방 이름 (예: 잡담 / 고민 / 게임)" />
      </div>
      <div class="row">
        <input id="roomPassInput" class="input" placeholder="4자리 비밀번호(선택)" maxlength="4" />
        <button class="btn" id="createRoomBtn">생성</button>
      </div>
      <p class="status" id="roomCreateStatus"></p>
      <p class="danger" id="roomCreateError"></p>
    </div>

    <div class="card">
      <div class="row between">
        <h2 style="margin-top:0;">열린 방</h2>
        <button class="btn ghost" id="randomJoinBtn">랜덤 입장</button>
      </div>
      <ul class="roomList" id="roomList"></ul>
    </div>

    <div class="footer">
      <small>욕설 금지 · 스팸 금지 · 불법적 내용 금지</small><br/>
      <small>하이비는 아무도 없으면 방을 지워요 🔥</small>
    </div>
  </div>

  <!-- 잠금방 비번 입력 화면 -->
  <div class="overlay" id="lockOverlay">
    <div class="panelHeader">
      <div>
        <div class="panelTitle">🔒 잠금 방 입장</div>
        <div class="panelSubtitle" id="lockRoomName">방 이름</div>
      </div>
      <button class="btn" id="lockCancelBtn" style="padding:0.45rem 0.6rem;font-size:0.8rem;border-radius:0.5rem;">취소</button>
    </div>
    <div class="panelBody" style="gap:1rem;">
      <div>
        <div style="color:#fff;font-size:0.9rem;margin-bottom:0.5rem;">비밀번호 4자리</div>
        <input id="lockPassInput" class="textField" maxlength="4" placeholder="****" style="width:100%;"/>
        <p class="danger" id="lockError"></p>
      </div>
      <button class="btn" id="lockEnterBtn" style="width:100%;">입장</button>
    </div>
  </div>

  <!-- 실제 채팅 화면 -->
  <div class="overlay" id="chatOverlay">
    <div class="panelHeader">
      <div>
        <div class="panelTitle" id="chatRoomTitle">방 이름...</div>
        <div class="panelSubtitle" id="chatRoomSubtitle">0/5 명 · 내 닉네임 ???</div>
      </div>
      <button class="btn" id="leaveBtn" style="padding:0.45rem 0.6rem;font-size:0.8rem;border-radius:0.5rem;">나가기</button>
    </div>

    <div class="panelBody">
      <div class="chatLog" id="chatLog"></div>
      <div class="muteNotice" id="muteNotice" style="display:none;"></div>
    </div>

    <div class="inputBar">
      <input class="textField" id="chatInput" placeholder="메시지 보내기..." />
      <button class="btn" id="sendBtn">보내기</button>
    </div>
  </div>

  <script src="/socket.io/socket.io.js"></script>
  <script>
    let socket = null;
    let mySocketId = null;
    let myName = null;
    let currentRoomId = null;
    let pendingLockedRoomId = null;
    let pendingLockedRoomName = null;

    const homeView = document.getElementById("homeView");

    const nicknameInput = document.getElementById("nicknameInput");
    const setNickBtn = document.getElementById("setNickBtn");
    const nickStatus = document.getElementById("nickStatus");
    const nickError = document.getElementById("nickError");

    const roomNameInput = document.getElementById("roomNameInput");
    const roomPassInput = document.getElementById("roomPassInput");
    const createRoomBtn = document.getElementById("createRoomBtn");
    const roomCreateStatus = document.getElementById("roomCreateStatus");
    const roomCreateError = document.getElementById("roomCreateError");

    const roomListEl = document.getElementById("roomList");
    const randomJoinBtn = document.getElementById("randomJoinBtn");

    const lockOverlay = document.getElementById("lockOverlay");
    const lockRoomName = document.getElementById("lockRoomName");
    const lockPassInput = document.getElementById("lockPassInput");
    const lockError = document.getElementById("lockError");
    const lockEnterBtn = document.getElementById("lockEnterBtn");
    const lockCancelBtn = document.getElementById("lockCancelBtn");

    const chatOverlay = document.getElementById("chatOverlay");
    const chatRoomTitle = document.getElementById("chatRoomTitle");
    const chatRoomSubtitle = document.getElementById("chatRoomSubtitle");
    const chatLogEl = document.getElementById("chatLog");
    const muteNotice = document.getElementById("muteNotice");

    const chatInput = document.getElementById("chatInput");
    const sendBtn = document.getElementById("sendBtn");
       const leaveBtn = document.getElementById("leaveBtn");

    function ensureSocket() {
      if (!socket) {
        socket = io("/", { transports:["websocket"] });

        socket.on("connect", ()=>{
          mySocketId = socket.id;
        });

        socket.on("roomsUpdate",(list)=>{
          renderRooms(list);
        });

        socket.on("nickResult",(res)=>{
          if (res.ok) {
            myName = res.name;
            nickError.textContent = "";
            nickStatus.textContent = "닉네임이 설정/변경되었습니다: " + myName;
            nicknameInput.value = "";
          } else {
            nickStatus.textContent = "";
            nickError.textContent = res.error || "닉네임 설정 실패";
          }
        });

        socket.on("roomCreated",(res)=>{
          if (res.ok) {
            roomCreateError.textContent = "";
            roomCreateStatus.textContent = "방이 만들어졌어요!";
            roomNameInput.value = "";
            roomPassInput.value = "";
            tryJoinRoom(res.roomId, res.locked, null);
          } else {
            roomCreateStatus.textContent = "";
            roomCreateError.textContent = res.error || "방 생성 실패";
          }
        });

        socket.on("joinResult",(res)=>{
          if (!res.ok) {
            if (res.needPassword) {
              pendingLockedRoomId = res.roomId;
              pendingLockedRoomName = res.roomName;
              lockRoomName.textContent = res.roomName + " (" + res.count + "/5)";
              lockPassInput.value = "";
              lockError.textContent = res.error || "";
              showLockOverlay(true);
            } else {
              alert(res.error || "입장 실패");
            }
            return;
          }

          currentRoomId = res.roomId;
          showLockOverlay(false);
          showChatOverlay(true);

          chatLogEl.innerHTML = "";
          updateChatHeader(res.roomName, res.count, res.max, res.nicknameList);
        });

        socket.on("userList",(info)=>{
          if (info.roomId === currentRoomId) {
            updateChatHeader(info.roomName, info.count, info.max, info.nicknameList);
          }
        });

        socket.on("systemMessage",(msg)=>{
          if (msg.roomId !== currentRoomId) return;
          pushSystemMessage(msg.text, msg.timestamp);
        });

        socket.on("chatMessage",(msg)=>{
          if (msg.roomId !== currentRoomId) return;
          pushChatMessage(msg.nickname, msg.text, msg.timestamp);
        });

        socket.on("muted",(m)=>{
          if (m.roomId !== currentRoomId) return;
          showMuteNotice(m.reason, m.until);
        });
      }
    }

    function renderRooms(list){
      roomListEl.innerHTML = "";
      if (list.length === 0) {
        const li = document.createElement("li");
        li.style.color="#64748b";
        li.style.fontSize="0.9rem";
        li.style.padding="0.5rem 0";
        li.textContent = "아직 방이 없어요. 첫 방의 주인이 돼봐 ✨";
        roomListEl.appendChild(li);
        return;
      }

      list.forEach(r=>{
        const li = document.createElement("li");
        li.className = "roomItem";

        const left = document.createElement("div");
        left.className = "roomInfo";

        const nm = document.createElement("div");
        nm.className = "roomName";

        const nameSpan = document.createElement("span");
        nameSpan.textContent = r.name;
        nm.appendChild(nameSpan);

        if (r.locked) {
          const lockSpan = document.createElement("span");
          lockSpan.className = "lockIcon";
          lockSpan.textContent = "🔒";
          nm.appendChild(lockSpan);
        }

        const meta = document.createElement("div");
        meta.className = "roomMeta";
        meta.textContent = r.count + "/" + r.max + " 명";

        left.appendChild(nm);
        left.appendChild(meta);

        const hint = document.createElement("div");
        hint.className = "enterHint";
        hint.textContent = "입장 ›";

        li.appendChild(left);
        li.appendChild(hint);

        li.addEventListener("click", ()=>{
          tryJoinRoom(r.id, r.locked, null);
        });

        roomListEl.appendChild(li);
      });
    }

    function showLockOverlay(show){
      lockOverlay.style.display = show ? "flex" : "none";
      if (show) {
        chatOverlay.style.display = "none";
      }
    }

    function showChatOverlay(show){
      chatOverlay.style.display = show ? "flex" : "none";
      if (show) {
        lockOverlay.style.display = "none";
        homeView.style.display = "none";
      } else {
        homeView.style.display = "block";
      }
    }

    function pushChatMessage(nick, text, ts){
      const wrap = document.createElement("div");
      wrap.className = "bubble";
      if (nick === myName) {
        wrap.classList.add("me");
      } else {
        wrap.classList.add("other");
      }

      const head = document.createElement("div");
      head.className="bubbleHeader";

      const nickSpan = document.createElement("span");
      nickSpan.className="bubbleNick";
      nickSpan.textContent = nick;

      const timeSpan = document.createElement("span");
      timeSpan.className="bubbleTime";
      const t = new Date(ts);
      timeSpan.textContent = t.toLocaleTimeString("ko-KR",{hour:"2-digit",minute:"2-digit"});

      head.appendChild(nickSpan);
      head.appendChild(timeSpan);

      const body = document.createElement("div");
      body.className="bubbleText";
      body.textContent = text;

      wrap.appendChild(head);
      wrap.appendChild(body);

      chatLogEl.appendChild(wrap);
      chatLogEl.scrollTop = chatLogEl.scrollHeight;
    }

    function pushSystemMessage(text, ts){
      const wrap = document.createElement("div");
      wrap.className = "bubble system";
      const t = new Date(ts);
      wrap.textContent = text + "  (" + t.toLocaleTimeString("ko-KR",{hour:"2-digit",minute:"2-digit"}) + ")";
      chatLogEl.appendChild(wrap);
      chatLogEl.scrollTop = chatLogEl.scrollHeight;
    }

    function updateChatHeader(roomName, count, max, nicknameList){
      chatRoomTitle.textContent = roomName;
      const namesJoined = nicknameList.join(", ");
      chatRoomSubtitle.textContent = count + "/" + max + " 명 · " + "내 닉네임 " + (myName || "???") + " · 참여자: " + namesJoined;
    }

    function showMuteNotice(reason, untilTs){
      const now = Date.now();
      const remainMs = untilTs - now;
      if (remainMs <= 0) {
        muteNotice.style.display = "none";
        return;
      }
      const remainSec = Math.ceil(remainMs / 1000);
      muteNotice.style.display = "block";
      muteNotice.textContent = "⛔ 채팅 제한 (" + reason + "). " + remainSec + "초 후 다시 가능";

      const interval = setInterval(()=>{
        const now2 = Date.now();
        const remain2 = untilTs - now2;
        if (remain2 <= 0) {
          muteNotice.style.display = "none";
          clearInterval(interval);
        } else {
          const sec2 = Math.ceil(remain2/1000);
          muteNotice.textContent = "⛔ 채팅 제한 (" + reason + "). " + sec2 + "초 후 다시 가능";
        }
      },1000);
    }

    setNickBtn.addEventListener("click", ()=>{
      ensureSocket();
      const desired = nicknameInput.value.trim();
      socket.emit("setNickname", { desiredName: desired });
    });

    createRoomBtn.addEventListener("click", ()=>{
      ensureSocket();
      const rn = roomNameInput.value.trim();
      const pw = roomPassInput.value.trim();
      socket.emit("createRoom", { roomName: rn, password: pw });
    });

    randomJoinBtn.addEventListener("click", ()=>{
      ensureSocket();
      socket.emit("requestRandomRoom");
    });

    lockEnterBtn.addEventListener("click", ()=>{
      ensureSocket();
      const pw = lockPassInput.value.trim();
      socket.emit("joinRoom", { roomId: pendingLockedRoomId, password: pw });
    });

    lockCancelBtn.addEventListener("click", ()=>{
      pendingLockedRoomId = null;
      pendingLockedRoomName = null;
      showLockOverlay(false);
      homeView.style.display = "block";
    });

    function sendChat(){
      const text = chatInput.value.trim();
      if (!text) return;
      if (!currentRoomId) return;
      ensureSocket();
      socket.emit("sendChat", { roomId: currentRoomId, text });
      chatInput.value = "";
    }

    sendBtn.addEventListener("click", sendChat);
    chatInput.addEventListener("keydown",(e)=>{
      if(e.key==="Enter") sendChat();
    });

    leaveBtn.addEventListener("click", ()=>{
      ensureSocket();
      socket.emit("leaveRoom", { roomId: currentRoomId });
      currentRoomId = null;
      showChatOverlay(false);
      chatLogEl.innerHTML = "";
    });

    function tryJoinRoom(roomId, locked, passMaybe){
      ensureSocket();
      socket.emit("joinRoom", { roomId, password: passMaybe || null });
    }

    ensureSocket();
    setInterval(()=>{
      if (socket) socket.emit("getRooms");
    }, 2000);
  </script>
</body>
</html>
  `);
});

// ==============================
// 소켓 연결 처리
// ==============================
io.on("connection", (socket) => {
  console.log("새 연결:", socket.id);

  // 새 유저 기본 상태
  users[socket.id] = {
    name: null,
    lastRename: 0,
    muteUntil: 0,
    recentMsgs: [],
    roomId: null,
  };

  // 방 목록 요청
  socket.on("getRooms", () => {
    socket.emit("roomsUpdate", serializeRooms());
  });

  // 랜덤 입장
  socket.on("requestRandomRoom", () => {
    const list = Object.entries(rooms)
      .filter(([id, room]) => Object.keys(room.users).length < 5)
      .map(([id, room]) => ({ id, room }));

    if (list.length === 0) {
      socket.emit("joinResult", {
        ok: false,
        error: "들어갈 빈자리가 있는 방이 없어요.",
      });
      return;
    }

    const pick = list[Math.floor(Math.random() * list.length)];
    const roomObj = pick.room;

    if (roomObj.password) {
      socket.emit("joinResult", {
        ok: false,
        needPassword: true,
        roomId: pick.id,
        roomName: roomObj.name,
        count: Object.keys(roomObj.users).length,
        error: "비밀번호가 필요한 방입니다.",
      });
      return;
    }

    handleJoinRoom(socket, pick.id, null);
  });

  // 닉네임 설정/변경
  socket.on("setNickname", ({ desiredName }) => {
    const u = users[socket.id];
    if (!u) return;

    const now = Date.now();
    const cleanName = (desiredName || "").trim();

    if (!cleanName) {
      socket.emit("nickResult", {
        ok: false,
        error: "닉네임을 입력해 주세요.",
      });
      return;
    }
    if (cleanName.length > 20) {
      socket.emit("nickResult", {
        ok: false,
        error: "닉네임이 너무 길어요 (20자 이하).",
      });
      return;
    }
    if (u.name && now - u.lastRename < RENAME_COOLDOWN) {
      const waitMs = RENAME_COOLDOWN - (now - u.lastRename);
      const waitSec = Math.ceil(waitMs / 1000);
      socket.emit("nickResult", {
        ok: false,
        error:
          "닉네임은 아직 바꿀 수 없어요. " +
          waitSec +
          "초 뒤에 다시 시도해 주세요.",
      });
      return;
    }
    if (takenNames.has(cleanName) && u.name !== cleanName) {
      socket.emit("nickResult", {
        ok: false,
        error: "이미 사용 중인 닉네임이에요.",
      });
      return;
    }

    // 기존 닉네임 반납
    if (u.name && takenNames.has(u.name)) {
      takenNames.delete(u.name);
    }

    // 새 닉네임 점유
    takenNames.add(cleanName);
    u.name = cleanName;
    u.lastRename = now;

    socket.emit("nickResult", { ok: true, name: cleanName });

    // 방 안에 있으면 리스트 갱신
    if (u.roomId && rooms[u.roomId]) {
      rooms[u.roomId].users[socket.id] = cleanName;
      broadcastUserList(u.roomId);
    }
  });

  // 방 생성
  socket.on("createRoom", ({ roomName, password }) => {
    const u = users[socket.id];
    if (!u || !u.name) {
      socket.emit("roomCreated", {
        ok: false,
        error: "먼저 닉네임을 설정해 주세요.",
      });
      return;
    }

    const nm = (roomName || "").trim();
    if (!nm) {
      socket.emit("roomCreated", {
        ok: false,
        error: "방 이름을 입력해 주세요.",
      });
      return;
    }
    if (nm.length > 30) {
      socket.emit("roomCreated", {
        ok: false,
        error: "방 이름이 너무 길어요 (30자 이하).",
      });
      return;
    }

    let pw = (password || "").trim();
    if (pw === "") pw = null;
    if (pw !== null) {
      // 비밀번호는 4자리 숫자만
      if (!/^[0-9]{4}$/.test(pw)) {
        socket.emit("roomCreated", {
          ok: false,
          error: "비밀번호는 4자리 숫자만 가능합니다.",
        });
        return;
      }
    }

    const id = makeRoomId();
    rooms[id] = {
      name: nm,
      password: pw,
      users: {},
    };

    socket.emit("roomCreated", {
      ok: true,
      roomId: id,
      locked: pw ? true : false,
    });

    io.emit("roomsUpdate", serializeRooms());
  });

  // 방 입장
  socket.on("joinRoom", ({ roomId, password }) => {
    handleJoinRoom(socket, roomId, password || null);
  });

  // 방 나가기
  socket.on("leaveRoom", ({ roomId }) => {
    handleLeaveRoom(socket, roomId);
  });

  // 채팅 보내기
  socket.on("sendChat", ({ roomId, text }) => {
    handleChat(socket, roomId, text);
  });

  // 연결 끊기
  socket.on("disconnect", () => {
    console.log("연결 종료:", socket.id);

    const u = users[socket.id];
    if (u) {
      // 방에서 빼주기
      if (u.roomId && rooms[u.roomId]) {
        const roomId = u.roomId;
        const room = rooms[roomId];

        if (room.users[socket.id]) {
          const nickname = room.users[socket.id];
          delete room.users[socket.id];
          broadcastSystem(roomId, `${nickname} 님이 나갔어요.`);
          broadcastUserList(roomId);
        }
      }

      // 닉네임 반납
      if (u.name && takenNames.has(u.name)) {
        takenNames.delete(u.name);
      }

      delete users[socket.id];
    }

    cleanupEmptyRooms();
    io.emit("roomsUpdate", serializeRooms());
  });
});


// ==============================
// 서버 시작 (Render용)
// ==============================
const PORT = process.env.PORT || 10000;
// Render는 무조건 process.env.PORT 값을 준다
// (우리가 그냥 3000만 고집하면 배포 실패 가능)

server.listen(PORT, "0.0.0.0", () => {
  console.log("✅ Hiby 서버 가동 중 (port " + PORT + ")");
});

