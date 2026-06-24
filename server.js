const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    const file = fs.readFileSync(path.join(__dirname, 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(file);
  } else {
    res.writeHead(404); res.end('Not found');
  }
});

const wss = new WebSocketServer({ server });
const rooms = {};

function uid() { return Math.random().toString(36).slice(2, 8).toUpperCase(); }

function broadcastAll(room, msg) {
  const data = JSON.stringify(msg);
  room.clients.forEach(c => { if (c.ws.readyState === 1) c.ws.send(data); });
}
function broadcast(room, msg, excludeId) {
  const data = JSON.stringify(msg);
  room.clients.forEach(c => { if (c.id !== excludeId && c.ws.readyState === 1) c.ws.send(data); });
}

function getRoomList() {
  return Object.values(rooms)
    .filter(r => !r.started && r.clients.length < 4)
    .map(r => ({ code: r.code, count: r.clients.length, host: r.clients[0]?.name || '?' }));
}

wss.on('connection', (ws) => {
  ws.id = uid();

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'get_rooms') {
      ws.send(JSON.stringify({ type: 'room_list', rooms: getRoomList() })); return;
    }
    if (msg.type === 'create_room') {
      const code = uid();
      rooms[code] = { code, clients: [], started: false };
      ws.name = msg.name || 'Joueur'; ws.roomCode = code; ws.isHost = true;
      rooms[code].clients.push({ id: ws.id, name: ws.name, ws });
      ws.send(JSON.stringify({ type: 'room_created', code, playerId: ws.id }));
      broadcastAll(rooms[code], { type: 'room_update', players: rooms[code].clients.map(c => ({ id: c.id, name: c.name })) });
      return;
    }
    if (msg.type === 'join_room') {
      const room = rooms[msg.code];
      if (!room) { ws.send(JSON.stringify({ type: 'error', msg: 'Salle introuvable' })); return; }
      if (room.started) { ws.send(JSON.stringify({ type: 'error', msg: 'Partie déjà en cours' })); return; }
      if (room.clients.length >= 4) { ws.send(JSON.stringify({ type: 'error', msg: 'Salle pleine' })); return; }
      ws.name = msg.name || 'Joueur'; ws.roomCode = msg.code; ws.isHost = false;
      room.clients.push({ id: ws.id, name: ws.name, ws });
      ws.send(JSON.stringify({ type: 'room_joined', code: msg.code, playerId: ws.id }));
      broadcastAll(room, { type: 'room_update', players: room.clients.map(c => ({ id: c.id, name: c.name })) });
      return;
    }
    if (msg.type === 'start_game') {
      const room = rooms[ws.roomCode];
      if (!room || !ws.isHost || room.clients.length < 2) return;
      room.started = true;
      const gs = buildGameState(room.clients);
      room.gs = gs;
      broadcastAll(room, { type: 'game_start', gameState: gs });
      return;
    }
    if (msg.type === 'game_state') {
      const room = rooms[ws.roomCode]; if (!room) return;
      room.gs = msg.gameState;
      broadcast(room, { type: 'game_state', gameState: msg.gameState }, ws.id);
      return;
    }
    if (msg.type === 'black3_play') {
      const room = rooms[ws.roomCode]; if (!room) return;
      broadcast(room, msg, ws.id); return;
    }
    if (msg.type === 'chat') {
      const room = rooms[ws.roomCode]; if (!room) return;
      const text = String(msg.text || '').slice(0, 200);
      if (!text.trim()) return;
      broadcastAll(room, { type: 'chat', name: ws.name || 'Joueur', text, senderId: ws.id });
      return;
    }
  });

  ws.on('close', () => {
    if (!ws.roomCode || !rooms[ws.roomCode]) return;
    const room = rooms[ws.roomCode];
    room.clients = room.clients.filter(c => c.id !== ws.id);
    if (room.clients.length === 0) { delete rooms[ws.roomCode]; return; }
    if (!room.started) broadcastAll(room, { type: 'room_update', players: room.clients.map(c => ({ id: c.id, name: c.name })) });
    else broadcastAll(room, { type: 'player_left', name: ws.name });
  });
});

function buildGameState(clients) {
  const SUITS = ['hearts', 'diamonds', 'clubs', 'spades'];
  const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  let deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push({ rank: r, suit: s, id: uid() });
  for (let i = deck.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [deck[i], deck[j]] = [deck[j], deck[i]]; }

  const players = clients.map((c, i) => ({
    id: c.id, name: c.name, idx: i,
    hidden: deck.splice(0, 3),
    open: deck.splice(0, 3),
    hand: deck.splice(0, 6),
    done: false,
    swapDone: false
  }));

  return {
    version: 1, players, deck, pile: [], discardCount: 0,
    currentPlayer: 0, direction: 1, pileVisible: null,
    swapPhase: true, pendingBlack3: null, lastEvent: null,
    log: ['🃏 Partie lancée ! Phase d\'échange — choisissez vos cartes visibles.']
  };
}

server.listen(PORT, () => console.log('Palace server running on port ' + PORT));
