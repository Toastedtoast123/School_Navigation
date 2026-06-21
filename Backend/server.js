const express = require('express');
const cors    = require('cors');
const path    = require('path');
const db      = require('./src/db/database');

const roomsRouter  = require('./src/routes/rooms');
const routeRouter  = require('./src/routes/route');
const floorsRouter = require('./src/routes/floors');

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// Serve your existing frontend files statically
// Point this to the folder where your index.html, room1.html, etc. live
app.use(express.static(path.join(__dirname, 'public')));

// ── API Routes ──────────────────────────────────────────────────────────────
app.use('/api/rooms',  roomsRouter);
app.use('/api/route',  routeRouter);
app.use('/api/floors', floorsRouter);

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── 404 fallback for API ─────────────────────────────────────────────────────
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'API endpoint not found' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🏫  Campus Navigation API running at http://localhost:${PORT}`);
  console.log(`   GET  /api/health`);
  console.log(`   GET  /api/floors`);
  console.log(`   GET  /api/rooms?floor=1`);
  console.log(`   GET  /api/route?from=Library&to=Admission\n`);
});
