const express = require('express');
const { getDb, all } = require('../db/database');
const router = express.Router();

router.get('/', async (_req, res) => {
  try {
    const db     = await getDb();
    const floors = all(db, 'SELECT id, label, model_file FROM floors ORDER BY id');
    res.json({ floors });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch floors' });
  }
});

module.exports = router;