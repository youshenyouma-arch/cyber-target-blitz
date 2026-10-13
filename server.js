const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));
app.use(express.static(path.join(__dirname, 'public')));

const DATA_FILE = path.join(__dirname, 'data.json');

function loadData() {
  if (!fs.existsSync(DATA_FILE)) return { players: {} };
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch (e) { return { players: {} }; }
}

function saveData(data) {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); } catch (e) {}
}

function calcElo(ratingA, ratingB, actualScoreA) {
  const K = 32;
  const expectedA = 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
  return Math.round(ratingA + K * (actualScoreA - expectedA));
}

// ★ 全7種類のマップ定義
const STAGES = [
  { id: 'city', name: 'サイバーシティ 🏙️', desc: '標準的なハイスピードステージ' },
  { id: 'diner', name: 'カオスダイナー 🍔', desc: '画面全体が激しく揺れ動く！' },
  { id: 'wind', name: 'ウィンドバレー 🌪️', desc: '強風で的が左右に大きく流される！' },
  { id: 'disco', name: 'ネオンディスコ 🪩', desc: '背景が七色に点滅・チカチカ変化！' },
  { id: 'gravity', name: 'グラビティゾーン 🚀', desc: '無重力！的が上へ向かって浮き上がる' },
  { id: 'warp', name: 'クロノスワープ ⏳', desc: '時空が歪み的のスピードが伸縮！' },
  { id: 'ink', name: 'インクファクトリー 🦑', desc: '定期的にインクが飛び散り視界遮断！' }
];

let waitingPlayer = null;
let rooms = {};

io.on('connection', (socket) => {
  socket.pName = "ゲスト_" + Math.floor(Math.random() * 1000);
  socket.pRate = 1500;

  socket.on('init_player', (name) => {
    socket.pName = name && name.trim() ? name.trim() : "名無し";
    const data = loadData();
    if (!data.players[socket.pName]) {
      data.players[socket.pName] = { rate: 1500, games: 0 };
      saveData(data);
    }
    socket.pRate = data.players[socket.pName].rate;
    socket.emit('player_data', { name: socket.pName, rate: socket.pRate });
  });

  socket.on('get_rankings', () => {
    const data = loadData();
    const ratings = Object.entries(data.players)
      .map(([name, val]) => ({ name, rate: val.rate }))
      .sort((a, b) => b.rate - a.rate)
      .slice(0, 50);
    socket.emit('rankings_data', { ratings });
  });

  // --- ソロモード開始 ---
  socket.on('start_solo', () => {
    const roomId = 'solo_' + socket.id;
    const stage = STAGES[Math.floor(Math.random() * STAGES.length)];
    
    rooms[roomId] = {
      id: roomId,
      isSolo: true,
      p1: { id: socket.id, name: socket.pName, rate: socket.pRate, score: 0, combo: 1.0, comboCount: 0 },
      p2: { id: 'bot', name: 'CPU', rate: 1500, score: 0, combo: 1.0, comboCount: 0 },
      stage: stage,
      timeLeft: 60,
      targets: {},
      targetSeq: 0,
      isStarted: true
    };

    socket.join(roomId);
    socket.emit('match_found', { roomId, stage, isSolo: true });
    
    let count = 3;
    const countTimer = setInterval(() => {
      io.to(roomId).emit('countdown', count);
      count--;
      if (count < 0) {
        clearInterval(countTimer);
        if (rooms[roomId]) {
          io.to(roomId).emit('start_game');
          startRoomGame(roomId);
        }
      }
    }, 1000);
  });

  // --- 対戦キュー参加 ---
  socket.on('join_queue', () => {
    if (waitingPlayer && waitingPlayer.id !== socket.id) {
      const roomId = 'room_' + Date.now();
      const p1 = waitingPlayer;
      const p2 = socket;
      waitingPlayer = null;

      p1.join(roomId); p2.join(roomId);
      const stage = STAGES[Math.floor(Math.random() * STAGES.length)];

      rooms[roomId] = {
        id: roomId,
        isSolo: false,
        p1: { id: p1.id, name: p1.pName, rate: p1.pRate, score: 0, combo: 1.0, comboCount: 0 },
        p2: { id: p2.id, name: p2.pName, rate: p2.pRate, score: 0, combo: 1.0, comboCount: 0 },
        stage: stage,
        timeLeft: 60,
        targets: {},
        targetSeq: 0,
        isStarted: false
      };

      io.to(roomId).emit('match_found', { roomId, stage, isSolo: false });

      let count = 3;
      const countTimer = setInterval(() => {
        io.to(roomId).emit('countdown', count);
        count--;
        if (count < 0) {
          clearInterval(countTimer);
          if (rooms[roomId]) {
            rooms[roomId].isStarted = true;
            io.to(roomId).emit('start_game');
            startRoomGame(roomId);
          }
        }
      }, 1000);

    } else {
      waitingPlayer = socket;
      socket.emit('waiting_for_opponent');
    }
  });

  socket.on('hit_target', ({ roomId, targetId }) => {
    const room = rooms[roomId];
    if (!room || !room.targets[targetId]) return;

    const t = room.targets[targetId];
    const isP1 = room.p1.id === socket.id;
    const player = isP1 ? room.p1 : room.p2;
    const opponent = isP1 ? room.p2 : room.p1;

    if (t.type === 'barrel') {
      t.hp--;
      io.to(roomId).emit('barrel_damaged', { targetId, hp: t.hp });
      if (t.hp > 0) return;

      const stolen = Math.round(opponent.score * 0.15);
      opponent.score = Math.max(0, opponent.score - stolen);
      player.score += stolen + 300;
      delete room.targets[targetId];
      io.to(roomId).emit('target_destroyed', { targetId });
      updateRoomState(roomId);
      return;
    }

    delete room.targets[targetId];
    let pts = 100;
    if (t.type === 'gold') pts = 800;
    if (t.type === 'bomb') { pts = -400; player.combo = 1.0; player.comboCount = 0; }
    if (t.type === 'ghost') pts = 500;
    if (t.type === 'timestop') { pts = 200; if(!room.isSolo) io.to(opponent.id).emit('apply_debuff', { type: 'FREEZE', duration: 2500 }); }
    if (t.type === 'mirror') { pts = 200; if(!room.isSolo) io.to(opponent.id).emit('apply_debuff', { type: 'REVERSE', duration: 4000 }); }

    if (pts > 0) {
      player.score += Math.round(pts * player.combo);
      player.comboCount++;
      player.combo = Math.min(3.0, 1.0 + player.comboCount * 0.05);
    } else {
      player.score = Math.max(0, player.score + pts);
    }

    io.to(roomId).emit('target_destroyed', { targetId });
    updateRoomState(roomId);
  });
});

function startRoomGame(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  room.timer = setInterval(() => {
    room.timeLeft--;
    io.to(roomId).emit('time_update', { timeLeft: room.timeLeft });
    if (room.timeLeft <= 0) {
      clearInterval(room.timer);
      clearInterval(room.spawnTimer);
      finishRoomGame(roomId);
    }
  }, 1000);

  room.spawnTimer = setInterval(() => {
    if (!rooms[roomId]) return;
    if (Object.keys(room.targets).length >= 7) return;

    room.targetSeq++;
    const tid = 't_' + room.targetSeq;
    const rand = Math.random();
    let type = 'normal';
    if (rand < 0.15) type = 'bomb';
    else if (rand < 0.28) type = 'ghost';
    else if (rand < 0.38) type = 'gold';
    else if (rand < 0.45) type = 'barrel';
    else if (rand < 0.52) type = 'timestop';
    else if (rand < 0.60) type = 'mirror';

    const tObj = { 
      id: tid, 
      type, 
      x: Math.floor(Math.random() * 70 + 15), 
      y: Math.floor(Math.random() * 55 + 20), 
      hp: 8 
    };
    room.targets[tid] = tObj;
    io.to(roomId).emit('spawn_target', tObj);

    setTimeout(() => {
      if (room.targets[tid]) {
        delete room.targets[tid];
        io.to(roomId).emit('target_expired', { targetId: tid });
      }
    }, type === 'ghost' ? 700 : 3200);
  }, 500);
}

function updateRoomState(roomId) {
  const room = rooms[roomId];
  if (room) io.to(roomId).emit('room_state', { p1: room.p1, p2: room.p2 });
}

function finishRoomGame(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  if (room.isSolo) {
    io.to(roomId).emit('game_over', { 
      winner: room.p1.name, 
      p1: { name: room.p1.name, score: room.p1.score, oldRate: room.p1.rate, newRate: room.p1.rate },
      isSolo: true
    });
  } else {
    let winnerName = "引き分け";
    let p1WinVal = 0.5, p2WinVal = 0.5;

    if (room.p1.score > room.p2.score) {
      winnerName = room.p1.name; p1WinVal = 1; p2WinVal = 0;
    } else if (room.p2.score > room.p1.score) {
      winnerName = room.p2.name; p1WinVal = 0; p2WinVal = 1;
    }

    const nR1 = calcElo(room.p1.rate, room.p2.rate, p1WinVal);
    const nR2 = calcElo(room.p2.rate, room.p1.rate, p2WinVal);

    const data = loadData();
    if (!data.players[room.p1.name]) data.players[room.p1.name] = { rate: 1500 };
    if (!data.players[room.p2.name]) data.players[room.p2.name] = { rate: 1500 };
    data.players[room.p1.name].rate = nR1;
    data.players[room.p2.name].rate = nR2;
    saveData(data);

    io.to(roomId).emit('game_over', { 
      winner: winnerName, 
      p1: { name: room.p1.name, score: room.p1.score, oldRate: room.p1.rate, newRate: nR1 }, 
      p2: { name: room.p2.name, score: room.p2.score, oldRate: room.p2.rate, newRate: nR2 },
      isSolo: false
    });
  }

  delete rooms[roomId];
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
