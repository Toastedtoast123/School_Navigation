const express = require('express');
const { getDb, all, get } = require('../db/database');
const router = express.Router();

let _graphCache = null;

async function getFullGraph(db) {
  if (_graphCache) return _graphCache;
  const edges = all(db, 'SELECT from_id, to_id FROM edges');
  const graph = {};
  for (const { from_id, to_id } of edges) {
    if (!graph[from_id]) graph[from_id] = [];
    graph[from_id].push(to_id);
  }
  _graphCache = buildCrossFloorEdges(graph);
  return _graphCache;
}

function buildCrossFloorEdges(graph) {
  const aug = { ...graph };
  const link = (a, b) => {
    if (!aug[a]) aug[a] = [];
    if (!aug[b]) aug[b] = [];
    if (!aug[a].includes(b)) aug[a].push(b);
    if (!aug[b].includes(a)) aug[b].push(a);
  };

  for (let f = 1; f <= 5; f++) {
    // B2 staircase
    // F1.B2.up → F2.B2.up1 → F2.B2.up → F3.B2.up1 → ...
    link(`F${f}_B2.up`,    `F${f+1}_B2.up1`);   // departure → arrival landing next floor
    link(`F${f}_B2.down`,  `F${f-1}_B2.down1`); // same for down side

    // B4 staircase — same pattern
    link(`F${f}_B4.up`,    `F${f+1}_B4.up1`);
    link(`F${f}_B4.down`,  `F${f-1}_B4.down1`);

    // Elevator
    link(`F${f}_Elevator`, `F${f+1}_Elevator`);
  }

  return aug;
}

function resolveNodeId(db, raw) {
  if (/^F\d+_/.test(raw)) return raw;
  const row = get(db, 'SELECT node_id FROM rooms WHERE display_name=? LIMIT 1', [raw]);
  return row ? row.node_id : null;
}

function bfs(graph, start, end) {
  if (start === end) return [start];
  const queue   = [[start, [start]]];
  const visited = new Set([start]);
  while (queue.length) {
    const [cur, path] = queue.shift();
    for (const nb of (graph[cur] || [])) {
      if (nb === end) return [...path, nb];
      if (!visited.has(nb)) { visited.add(nb); queue.push([nb, [...path, nb]]); }
    }
  }
  return null;
}

function groupByFloor(path) {
  const segs = {};
  for (const id of path) {
    const f = Number(id.match(/^F(\d+)_/)?.[1] || 0);
    if (!segs[f]) segs[f] = [];
    segs[f].push(id);
  }
  return segs;
}

router.get('/', async (req, res) => {
  const { from, to } = req.query;

  if (typeof from !== 'string' || typeof to !== 'string') {
    return res.status(400).json({ error: 'Both "from" and "to" must be strings.' });
  }
  if (!from || !to) return res.status(400).json({ error: 'Both "from" and "to" are required.' });
  if (from.length > 80 || to.length > 80) {
    return res.status(400).json({ error: 'Room names are too long.' });
  }
  // Avoid weird input / abuse; allow common room naming patterns.
  const safeRe = /^[A-Za-z0-9 ._\-()\[\]]+$/;
  if (!safeRe.test(from) || !safeRe.test(to)) {
    return res.status(400).json({ error: 'Invalid room name format.' });
  }


  try {
    const db     = await getDb();
    const fromId = resolveNodeId(db, from);
    const toId   = resolveNodeId(db, to);

    if (!fromId) return res.status(404).json({ error: `Room "${from}" not found.` });
    if (!toId)   return res.status(404).json({ error: `Room "${to}" not found.` });
    if (fromId === toId) return res.status(400).json({ error: 'Start and destination are the same.' });

    const graph = await getFullGraph(db);
    const path  = bfs(graph, fromId, toId);

    if (!path) return res.status(404).json({ error: `No path found between "${from}" and "${to}".` });

    const steps = path.map(id => {
      const row = get(db, 'SELECT node_id, display_name, floor_id, x, y, z FROM rooms WHERE node_id=?', [id]);
      return row
        ? { nodeId: id, displayName: row.display_name, floor: row.floor_id, x: row.x, y: row.y, z: row.z }
        : { nodeId: id, displayName: id.replace(/^F\d+_/, ''), floor: null, x: 0, y: 0, z: 0 };
    });

    const segments = groupByFloor(path);
    const floors   = Object.keys(segments).map(Number).sort((a, b) => a - b);

    res.json({ from: fromId, to: toId, path, steps, segments, floors });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Route calculation failed.' });
  }
});

function requireApiKey(req) {
  const expected = process.env.API_KEY;
  // If API_KEY isn't configured, fail closed to avoid accidental insecure deployment.
  if (!expected) return false;
  const provided = req.header('x-api-key');
  return typeof provided === 'string' && provided === expected;
}



router.post('/clear-cache', (req, res) => {
  if (!requireApiKey(req)) return res.status(401).json({ error: 'Unauthorized' });
  _graphCache = null;
  res.json({ message: 'Cache cleared.' });
});


module.exports = router;
