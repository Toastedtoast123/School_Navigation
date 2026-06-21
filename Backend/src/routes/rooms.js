const express = require('express');
const { getDb, all } = require('../db/database');
const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const db = await getDb();
    const { floor } = req.query;

    if (floor) {
      const rooms = all(db,
        'SELECT node_id, display_name, floor_id, x, y, z FROM rooms WHERE floor_id=? AND is_navigable=1 ORDER BY display_name',
        [Number(floor)]
      );
      return res.json({ floor: Number(floor), rooms });
    }

    const rooms = all(db,
      'SELECT node_id, display_name, floor_id, x, y, z FROM rooms WHERE is_navigable=1 ORDER BY floor_id, display_name'
    );
    res.json({ rooms });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch rooms' });
  }
});

router.get('/graph/:floor', async (req, res) => {
  try {
    const db      = await getDb();
    const floorId = Number(req.params.floor);

    const nodes = all(db,
      'SELECT node_id, display_name, x, y, z, is_navigable, label_x, label_y, label_z, label_color, offset_label FROM rooms WHERE floor_id=?',
      [floorId]
    );
    const edges = all(db,
      'SELECT from_id, to_id FROM edges WHERE floor_id=?',
      [floorId]
    );

    const graph = {};
    for (const { from_id, to_id } of edges) {
      if (!graph[from_id]) graph[from_id] = [];
      graph[from_id].push(to_id);
    }

    const connectionPoints = {};
    for (const { node_id, display_name, x, y, z, offset_label } of nodes) {
      connectionPoints[node_id] = { x, y, z, displayName: display_name, offsetLabel: offset_label || undefined };
    }

    // Independent floating-label positions. Falls back to the room's own
    // x/y/z (+ a small y-offset) for any room that hasn't had a custom
    // label_x/y/z set yet, so every navigable room still gets a label.
    const HALLWAY_PREFIX   = 'Hallway';
    const STAIR_SUFFIXES   = ['B2.up', 'B2.up1', 'B2.down', 'B2.down1', 'B4.up', 'B4.up1', 'B4.down', 'B4.down1'];
    const LABEL_Y_OFFSET   = 10;

    const roomLabels = [];
    for (const node of nodes) {
      const name = node.display_name || '';
      if (name.startsWith(HALLWAY_PREFIX)) continue;
      if (STAIR_SUFFIXES.some((s) => name.endsWith(s))) continue;

      roomLabels.push({
        id:          node.node_id,
        text:        name,
        // overrides `text` in the frontend when present
        offsetLabel: node.offset_label || undefined,
        x:           node.label_x ?? node.x,
        y:           node.label_y ?? (node.y + LABEL_Y_OFFSET),
        z:           node.label_z ?? (node.z || 0),
        color:       node.label_color || undefined,
      });
    }

    res.json({ floor: floorId, graph, connectionPoints, roomLabels });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch floor graph' });
  }
});

module.exports = router;