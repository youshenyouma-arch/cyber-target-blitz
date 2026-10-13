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
  if (!fs.existsSync(DATA_FILE)) {
    return { players: {}, monthlyScores: {}, monthlyRatings: {} };
  }
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch (e) { return { players: {}, monthlyScores: {}, monthlyRatings: {} }; }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function getCurrentMonthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function calcElo(ratingA, ratingB, actualScoreA) {
  const K = 32;
  const expectedA = 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
  return Math.round(ratingA + K * (actualScoreA - expectedA));
}

let waitingPlayer = null;
let rooms = {};

io.on('connection', (socket) => {
  let pName = "ゲスト";
  let pRate = 1500;

  socket.on('init_player', (name) => {
    pName = name || "名無し";
    const data = loadData();
    if (!data.players[pName]) {
      data.players[pName] = { rate: 1500, games: 0, wins: 0 };
      saveData(data);
    }
    pRate = data.players[pName].rate;
    socket.emit('player_data', { name: pName, rate: pRate });
  });

  socket.on('get_rankings', () => {
    const data = loadData();
    const monthKey = getCurrentMonthKey();
    const scores = data.monthlyScores[monthKey] || [];
    const ratings = Object.entries(data.players)
      .map(([name, val]) => ({ name, rate: val.rate }))
      .sort((a, b) => b.rate - a.rate)
      .slice(0, 50);
    socket.emit('rankings_data', { scores, ratings, monthKey });
  });

  socket.on('join_queue', () => {
    if (waitingPlayer && waitingPlayer.id !== socket.id) {
      const roomId = 'room_' + Date.now();
      const p1 = waitingPlayer;
      const p2 = socket;
      waitingPlayer = null;

      p1.join(roomId); p2.join(roomId);

      rooms[roomId] = {
        id: roomId,
        p1: { id: p1.id, name: p1.pName, rate: p1.pRate, score: 0, combo: 1.0, comboCount: 0 },
        p2: { id: p2.id, name: p2.pName, rate: p2.pRate, score: 0, combo: 1.0, comboCount: 0 },
        stage: 'ノーマルモード',
        timeLeft: 60,
        targets: {},
        targetSeq: 0
      };

      io.to(roomId).emit('match_found', { roomId, stage: rooms[roomId].stage });
      startRoomGame(roomId);
    } else {
      waitingPlayer = socket;
      waitingPlayer.pName = pName;
      waitingPlayer.pRate = pRate;
      socket.emit('waiting_for_opponent');
    }
  });

  socket.on('hit_target', ({ roomId, targetId, reactionTime }) => {
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
      opponent.score -= stolen; player.score += stolen + 300;
      delete room.targets[targetId];
      io.to(roomId).emit('target_destroyed', { targetId, pts: `+${stolen + 300}` });
      updateRoomState(roomId);
      return;
    }

    delete room.targets[targetId];
    let pts = 100;
    if (t.type === 'gold') pts = 1000;
    if (t.type === 'bomb') { pts = -500; player.combo = 1.0; }
    if (t.type === 'ghost') pts = 500;
    if (t.type === 'timestop') { pts = 200; io.to(opponent.id).emit('apply_debuff', { type: 'FREEZE', duration: 3000 }); }
    if (t.type === 'mirror') { pts = 200; io.to(opponent.id).emit('apply_debuff', { type: 'REVERSE', duration: 3000 }); }

    if (pts > 0) {
      player.score += Math.round(pts * player.combo);
      player.comboCount++;
      player.combo = Math.min(3.0, 1.0 + player.comboCount * 0.05);
    } else {
      player.score += pts;
    }

    io.to(roomId).emit('target_destroyed', { targetId, pts });
    updateRoomState(roomId);
  });

  socket.on('miss_click', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;
    const player = (room.p1.id === socket.id) ? room.p1 : room.p2;
    player.combo = 1.0; player.comboCount = 0;
    socket.emit('apply_stun', { duration: 1000 });
    updateRoomState(roomId);
  });
});

function startRoomGame(roomId) {
  const room = rooms[roomId];
  room.timer = setInterval(() => {
    room.timeLeft--;
    if (room.timeLeft <= 0) {
      clearInterval(room.timer); clearInterval(room.spawnTimer);
      finishRoomGame(roomId);
      return;
    }
    io.to(roomId).emit('time_update', { timeLeft: room.timeLeft });
  }, 1000);

  room.spawnTimer = setInterval(() => {
    if (Object.keys(room.targets).length >= 8) return;
    room.targetSeq++;
    const tid = 't_' + room.targetSeq;
    const rand = Math.random();
    let type = 'normal';
    if (rand < 0.15) type = 'bomb';
    else if (rand < 0.25) type = 'ghost';
    else if (rand < 0.30) type = 'gold';
    else if (rand < 0.35) type = 'barrel';
    else if (rand < 0.40) type = 'timestop';
    else if (rand < 0.45) type = 'mirror';

    const tObj = { id: tid, type, x: Math.random() * 75 + 10, y: Math.random() * 60 + 20, hp: 10, createdAt: Date.now() };
    room.targets[tid] = tObj;
    io.to(roomId).emit('spawn_target', tObj);

    setTimeout(() => {
      if (room.targets[tid]) {
        delete room.targets[tid];
        io.to(roomId).emit('target_expired', { targetId: tid });
      }
    }, type === 'ghost' ? 600 : 3000);
  }, 600);
}

function updateRoomState(roomId) {
  const room = rooms[roomId];
  if (room) io.to(roomId).emit('room_state', { p1: room.p1, p2: room.p2 });
}

function finishRoomGame(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  let winner = null, p1R = 0.5, p2R = 0.5;
  if (room.p1.score > room.p2.score) { winner = room.p1.name; p1R = 1; p2R = 0; }
  else if (room.p2.score > room.p1.score) { winner = room.p2.name; p1R = 0; p2R = 1; }

  const nR1 = calcElo(room.p1.rate, room.p2.rate, p1R);
  const nR2 = calcElo(room.p2.rate, room.p1.rate, p2R);

  io.to(roomId).emit('game_over', { winner, p1: { name: room.p1.name, score: room.p1.score, newRate: nR1 }, p2: { name: room.p2.name, score: room.p2.score, newRate: nR2 } });
  delete rooms[roomId];
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server on port ${PORT}`));
