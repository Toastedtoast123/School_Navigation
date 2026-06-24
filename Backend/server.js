const express = require('express');
const cors    = require('cors');
const path    = require('path');
const helmet  = require('helmet');
const rateLimit = require('express-rate-limit');

const roomsRouter  = require('./src/routes/rooms');
const routeRouter  = require('./src/routes/route');
const floorsRouter = require('./src/routes/floors');

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Middleware ──────────────────────────────────────────────────────────────
require('dotenv').config();

const corsOrigin = process.env.CORS_ORIGIN || '*';
app.use(
  cors({
    origin: corsOrigin === '' ? '*' : corsOrigin,
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'x-api-key'],
  })
);


app.use(helmet());

// Prevent request body abuse (you mostly use GET)
app.use(express.json({ limit: '100kb' }));

// Global rate limit (basic protection)
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    limit: 300,                // max requests per IP
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// Optional: stricter limiting on the expensive route calculations
app.use(
  '/api/route',
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 60,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

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
