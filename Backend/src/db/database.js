/**
 * database.js  –  uses sql.js (pure JS, no native build needed)
 */
const path   = require('path');
const fs     = require('fs');
const initSqlJs = require('sql.js');

const DB_PATH = path.join(__dirname, '../../data/campus.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

let _db = null;

async function getDb() {
  if (_db) return _db;

  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    _db = new SQL.Database(fileBuffer);
    migrateLabelColumns(_db);
  } else {
    _db = new SQL.Database();
    createSchema(_db);
    seed(_db);
    persist(_db);
  }

  return _db;
}

// Adds label_x/label_y/label_z/label_color to an EXISTING rooms table if
// they're missing — lets you reposition a room's floating label
// independently of its actual x/y/z, without losing your current database.
function migrateLabelColumns(db) {
  const existingCols = all(db, "PRAGMA table_info(rooms)").map(c => c.name);
  const toAdd = [
    ['label_x', 'REAL'],
    ['label_y', 'REAL'],
    ['label_z', 'REAL'],
    ['label_color', 'TEXT'],
    ['offset_label', 'TEXT'],
  ].filter(([name]) => !existingCols.includes(name));

  if (toAdd.length === 0) return;

  for (const [name, type] of toAdd) {
    db.run(`ALTER TABLE rooms ADD COLUMN ${name} ${type}`);
  }
  persist(db);
  console.log(`✅  Migrated rooms table — added: ${toAdd.map(c => c[0]).join(', ')}`);
}

function persist(db) {
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

function createSchema(db) {
  db.run(`
    CREATE TABLE IF NOT EXISTS floors (
      id         INTEGER PRIMARY KEY,
      label      TEXT NOT NULL,
      model_file TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS rooms (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      floor_id     INTEGER NOT NULL,
      node_id      TEXT NOT NULL,
      display_name TEXT NOT NULL,
      x REAL NOT NULL DEFAULT 0,
      y REAL NOT NULL DEFAULT 0,
      z REAL NOT NULL DEFAULT 0,
      is_navigable INTEGER NOT NULL DEFAULT 1,
      label_x REAL,
      label_y REAL,
      label_z REAL,
      label_color TEXT,
      offset_label TEXT,
      UNIQUE(floor_id, node_id)
    );
    CREATE TABLE IF NOT EXISTS edges (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      floor_id INTEGER NOT NULL,
      from_id  TEXT NOT NULL,
      to_id    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(floor_id, from_id);
    CREATE INDEX IF NOT EXISTS idx_rooms_floor ON rooms(floor_id);
  `);
}

function seed(db) {
  console.log('🌱  Seeding database...');
  const RAW = require('./seedData');

  const floorMeta = [
    { id: 1, label: 'Floor 1', model_file: '../models/floor1.glb'  },
    { id: 2, label: 'Floor 2', model_file: '../models/floor2s.glb' },
    { id: 3, label: 'Floor 3', model_file: '../models/floor3.glb'  },
    { id: 4, label: 'Floor 4', model_file: '../models/floor4s.glb' },
    { id: 5, label: 'Floor 5', model_file: '../models/floor5s.glb' },
    { id: 6, label: 'Floor 6', model_file: '../models/floor6s.glb' },
  ];

  const HALLWAY_PREFIXES = ['Hallway', 'B2.', 'B4.', 'B2-', 'B4-', 'Elevator', 'Entrance', 'Exit', 'CR.'];
  const isNavigable = name => !HALLWAY_PREFIXES.some(p => name.startsWith(p));

  for (const f of floorMeta) {
    db.run('INSERT OR IGNORE INTO floors VALUES (?,?,?)', [f.id, f.label, f.model_file]);
  }

  // seedData.js exports per-floor keys ('1'..'6') PLUS a top-level
  // `roomLabels` map — skip anything that isn't a numeric floor key here.
  for (const [floorNum, floorEntry] of Object.entries(RAW)) {
    if (!/^\d+$/.test(floorNum)) continue;
    const { graph, connectionPoints } = floorEntry || {};
    if (!graph || !connectionPoints) continue;

    const fid = Number(floorNum);
    const pk  = id => id.startsWith(`F${fid}_`) ? id : `F${fid}_${id}`;

    // Optional custom label positions for this floor, keyed by room id
    // (matches the `id` field used in RAW.roomLabels[floorNum]).
    const labelOverrides = {};
    for (const lbl of (RAW.roomLabels?.[floorNum] || [])) {
      labelOverrides[lbl.id] = lbl;
    }

    for (const [rawName, pos] of Object.entries(connectionPoints)) {
      const override = labelOverrides[rawName];
      db.run(
        'INSERT OR IGNORE INTO rooms (floor_id,node_id,display_name,x,y,z,is_navigable,label_x,label_y,label_z,label_color,offset_label) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        [
          fid, pk(rawName), rawName, pos.x, pos.y, pos.z, isNavigable(rawName) ? 1 : 0,
          override?.x ?? null,
          override?.y ?? null,
          override?.z ?? null,
          override?.color ?? null,
          override?.offsetLabel ?? null,
        ]
      );
    }

    for (const [rawFrom, neighbours] of Object.entries(graph)) {
      for (const rawTo of neighbours) {
        db.run(
          'INSERT INTO edges (floor_id,from_id,to_id) VALUES (?,?,?)',
          [fid, pk(rawFrom), pk(rawTo)]
        );
      }
    }
  }

  persist(db);
  console.log('✅  Database seeded.');
}

// Helper: run a SELECT and return all rows as objects
function all(db, sql, params = []) {
  const stmt   = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

// Helper: run a SELECT and return first row or null
function get(db, sql, params = []) {
  const rows = all(db, sql, params);
  return rows[0] || null;
}

module.exports = { getDb, all, get, persist };