const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;

// In-memory state
let questions = [];
let sessions = {};
let clients = [];       // SSE clients (all)
let audienceClients = {}; // sessionId -> count of audience SSE connections
let questionIdCounter = 1;

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  clients = clients.filter(res => {
    try { res.write(msg); return true; }
    catch { return false; }
  });
}

function broadcastAudienceCounts() {
  // For each session, count how many audience clients are connected
  const counts = {};
  Object.keys(audienceClients).forEach(sid => {
    counts[sid] = audienceClients[sid] || 0;
  });
  broadcast({ type: 'audience_counts', counts });
}

function generateSessionId() {
  return Math.random().toString(36).substr(2, 8).toUpperCase();
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE, PATCH');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Static
  if (pathname === '/' || pathname === '/index.html') {
    serveFile(res, path.join(__dirname, 'index.html'), 'text/html');
    return;
  }

  // SSE — main event stream (presenter + general)
  if (pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    // Build audience counts
    const counts = {};
    Object.keys(audienceClients).forEach(sid => { counts[sid] = audienceClients[sid] || 0; });
    res.write(`data: ${JSON.stringify({ type: 'init', questions, sessions, audienceCounts: counts })}\n\n`);
    clients.push(res);
    req.on('close', () => { clients = clients.filter(c => c !== res); });
    return;
  }

  // SSE — audience presence tracking (one connection per audience tab)
  if (pathname === '/api/presence') {
    const sid = parsed.query.sessionId;
    if (!sid) { res.writeHead(400); res.end(); return; }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write(': connected\n\n');
    audienceClients[sid] = (audienceClients[sid] || 0) + 1;
    broadcastAudienceCounts();
    req.on('close', () => {
      audienceClients[sid] = Math.max(0, (audienceClients[sid] || 1) - 1);
      broadcastAudienceCounts();
    });
    return;
  }

  // Sessions
  if (pathname === '/api/sessions' && req.method === 'POST') {
    readBody(req, body => {
      const { name } = JSON.parse(body);
      const id = generateSessionId();
      sessions[id] = { id, name: name || 'My Session', created: Date.now(), active: true };
      audienceClients[id] = 0;
      broadcast({ type: 'session_created', session: sessions[id] });
      jsonResponse(res, sessions[id]);
    });
    return;
  }

  if (pathname === '/api/sessions' && req.method === 'GET') {
    jsonResponse(res, Object.values(sessions));
    return;
  }

  if (pathname.startsWith('/api/sessions/') && req.method === 'PATCH') {
    const sid = pathname.split('/')[3];
    readBody(req, body => {
      const updates = JSON.parse(body);
      if (!sessions[sid]) { res.writeHead(404); res.end(); return; }
      if ('active' in updates) sessions[sid].active = updates.active;
      if ('name' in updates) sessions[sid].name = updates.name;
      broadcast({ type: 'session_updated', session: sessions[sid] });
      jsonResponse(res, sessions[sid]);
    });
    return;
  }

  if (pathname.startsWith('/api/sessions/') && req.method === 'DELETE') {
    const sid = pathname.split('/')[3];
    delete sessions[sid];
    delete audienceClients[sid];
    questions = questions.filter(q => q.sessionId !== sid);
    broadcast({ type: 'session_deleted', sessionId: sid });
    jsonResponse(res, { ok: true });
    return;
  }

  // Export session as JSON (used by frontend to build CSV/PDF)
  if (pathname.startsWith('/api/sessions/') && pathname.endsWith('/export') && req.method === 'GET') {
    const sid = pathname.split('/')[3];
    const session = sessions[sid];
    if (!session) { res.writeHead(404); res.end(); return; }
    const qs = questions.filter(q => q.sessionId === sid);
    jsonResponse(res, { session, questions: qs });
    return;
  }

  // Questions
  if (pathname === '/api/questions' && req.method === 'POST') {
    readBody(req, body => {
      const { sessionId, text, author, participantId } = JSON.parse(body);
      if (!text || text.trim().length === 0) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'empty question' })); return;
      }
      const q = {
        id: questionIdCounter++,
        sessionId,
        text: text.trim().substring(0, 500),
        author: (author || 'Anonymous').substring(0, 50),
        participantId: participantId || null,
        votes: 0,
        answered: false,
        pinned: false,
        created: Date.now()
      };
      questions.push(q);
      broadcast({ type: 'question_added', question: q });
      jsonResponse(res, q);
    });
    return;
  }

  if (pathname === '/api/questions' && req.method === 'GET') {
    const sid = parsed.query.sessionId;
    const filtered = sid ? questions.filter(q => q.sessionId === sid) : questions;
    jsonResponse(res, filtered);
    return;
  }

  if (pathname.startsWith('/api/questions/') && pathname.split('/')[3] !== 'upvote' && req.method === 'PATCH') {
    const qid = parseInt(pathname.split('/')[3]);
    readBody(req, body => {
      const updates = JSON.parse(body);
      const q = questions.find(q => q.id === qid);
      if (!q) { res.writeHead(404); res.end(); return; }
      if ('answered' in updates) q.answered = updates.answered;
      if ('pinned' in updates) q.pinned = updates.pinned;
      if ('votes' in updates) q.votes = updates.votes;
      broadcast({ type: 'question_updated', question: q });
      jsonResponse(res, q);
    });
    return;
  }

  if (pathname.startsWith('/api/questions/') && req.method === 'DELETE') {
    const qid = parseInt(pathname.split('/')[3]);
    questions = questions.filter(q => q.id !== qid);
    broadcast({ type: 'question_deleted', questionId: qid });
    jsonResponse(res, { ok: true });
    return;
  }

  if (pathname === '/api/questions/upvote' && req.method === 'POST') {
    readBody(req, body => {
      const { questionId } = JSON.parse(body);
      const q = questions.find(q => q.id === questionId);
      if (!q) { res.writeHead(404); res.end(); return; }
      q.votes++;
      broadcast({ type: 'question_updated', question: q });
      jsonResponse(res, q);
    });
    return;
  }

  if (pathname === '/api/clear' && req.method === 'POST') {
    readBody(req, body => {
      const { sessionId } = JSON.parse(body);
      if (sessionId) questions = questions.filter(q => q.sessionId !== sessionId);
      else questions = [];
      broadcast({ type: 'cleared', sessionId });
      jsonResponse(res, { ok: true });
    });
    return;
  }

  res.writeHead(404); res.end('Not found');
});

function serveFile(res, filePath, contentType) {
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

function jsonResponse(res, data) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req, cb) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => cb(body));
}

server.listen(PORT, () => {
  console.log(`\n🚀 SlideQ&A running at http://localhost:${PORT}`);
  console.log(`📋 Presenter: http://localhost:${PORT}/?mode=presenter`);
  console.log(`👥 Audience:  http://localhost:${PORT}/?mode=audience`);
  console.log(`\nShare your server IP with audience members on the same network.\n`);
});
