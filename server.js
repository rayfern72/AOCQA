const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;

// In-memory state
let questions = [];
let sessions = {};
let clients = []; // SSE clients
let questionIdCounter = 1;

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  clients = clients.filter(res => {
    try { res.write(msg); return true; }
    catch { return false; }
  });
}

function generateSessionId() {
  return Math.random().toString(36).substr(2, 8).toUpperCase();
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204); res.end(); return;
  }

  // Serve static files
  if (pathname === '/' || pathname === '/index.html') {
    serveFile(res, path.join(__dirname, 'index.html'), 'text/html');
    return;
  }

  // SSE endpoint for real-time updates
  if (pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write(`data: ${JSON.stringify({ type: 'init', questions, sessions })}\n\n`);
    clients.push(res);
    req.on('close', () => { clients = clients.filter(c => c !== res); });
    return;
  }

  // API Routes
  if (pathname === '/api/sessions' && req.method === 'POST') {
    readBody(req, body => {
      const { name } = JSON.parse(body);
      const id = generateSessionId();
      sessions[id] = { id, name: name || 'My Session', created: Date.now(), active: true };
      broadcast({ type: 'session_created', session: sessions[id] });
      jsonResponse(res, sessions[id]);
    });
    return;
  }

  if (pathname === '/api/sessions' && req.method === 'GET') {
    jsonResponse(res, Object.values(sessions));
    return;
  }

  if (pathname.startsWith('/api/sessions/') && req.method === 'DELETE') {
    const sid = pathname.split('/')[3];
    delete sessions[sid];
    broadcast({ type: 'session_deleted', sessionId: sid });
    jsonResponse(res, { ok: true });
    return;
  }

  if (pathname === '/api/questions' && req.method === 'POST') {
    readBody(req, body => {
      const { sessionId, text, author } = JSON.parse(body);
      if (!text || text.trim().length === 0) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'empty question' })); return;
      }
      const q = {
        id: questionIdCounter++,
        sessionId,
        text: text.trim().substring(0, 500),
        author: (author || 'Anonymous').substring(0, 50),
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

  if (pathname.startsWith('/api/questions/') && req.method === 'PATCH') {
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
