const express = require('express');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'dll_store.db');
const MAX_FILE_BYTES = 200 * 1024 * 1024; 

// ---------- Database setup ----------
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS files (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    filename    TEXT NOT NULL,
    size_bytes  INTEGER NOT NULL,
    sha256      TEXT NOT NULL,
    content     BLOB NOT NULL,
    uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

const insertStmt = db.prepare(
  `INSERT INTO files (filename, size_bytes, sha256, content) VALUES (?, ?, ?, ?)`
);
const listStmt = db.prepare(
  `SELECT id, filename, size_bytes, sha256, uploaded_at FROM files ORDER BY id DESC`
);
const getMetaStmt = db.prepare(
  `SELECT id, filename, size_bytes, sha256, uploaded_at FROM files WHERE id = ?`
);
const getContentStmt = db.prepare(
  `SELECT filename, content FROM files WHERE id = ?`
);
const deleteStmt = db.prepare(`DELETE FROM files WHERE id = ?`);

// ---------- App setup ----------
const app = express();

// raw binary uploads (Content-Type: application/octet-stream)
app.use(
  '/api/files',
  express.raw({ type: 'application/octet-stream', limit: MAX_FILE_BYTES })
);

// multipart/form-data uploads (field name: "file")
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES },
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ---------- Routes ----------

// documentation page at root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'docs.html'));
});

/**
 * POST /api/files
 * Two ways to upload:
 *  1) multipart/form-data with a field called "file"
 *  2) raw body with Content-Type: application/octet-stream
 *     and a "?filename=whatever.dll" query param
 */
app.post('/api/files', (req, res, next) => {
  const contentType = req.headers['content-type'] || '';

  if (contentType.startsWith('multipart/form-data')) {
    return upload.single('file')(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message });
      if (!req.file) {
        return res.status(400).json({ error: 'No file field found (expected field name "file").' });
      }
      return storeFile(req.file.originalname, req.file.buffer, res);
    });
  }

  if (contentType.startsWith('application/octet-stream')) {
    const filename = req.query.filename;
    if (!filename) {
      return res.status(400).json({ error: 'Missing required query param "filename".' });
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: 'Empty or missing request body.' });
    }
    return storeFile(filename, req.body, res);
  }

  return res.status(415).json({
    error:
      'Unsupported Content-Type. Use multipart/form-data (field "file") or application/octet-stream with ?filename=.',
  });
});

function storeFile(filename, buffer, res) {
  if (buffer.length > MAX_FILE_BYTES) {
    return res.status(413).json({ error: `File exceeds max size of ${MAX_FILE_BYTES} bytes.` });
  }
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const info = insertStmt.run(filename, buffer.length, sha256, buffer);
  const meta = getMetaStmt.get(info.lastInsertRowid);
  return res.status(201).json(meta);
}

// GET /api/files - list metadata for all stored files (no bytes)
app.get('/api/files', (req, res) => {
  res.json(listStmt.all());
});

// GET /api/files/:id/meta - metadata only for one file
app.get('/api/files/:id/meta', (req, res) => {
  const meta = getMetaStmt.get(req.params.id);
  if (!meta) return res.status(404).json({ error: 'File not found.' });
  res.json(meta);
});

// GET /api/files/:id - download the raw bytes
app.get('/api/files/:id', (req, res) => {
  const row = getContentStmt.get(req.params.id);
  if (!row) return res.status(404).json({ error: 'File not found.' });

  res.set('Content-Type', 'application/x-msdownload');
  res.set('Content-Disposition', `attachment; filename="${row.filename}"`);
  res.set('Content-Length', row.content.length);
  res.send(row.content);
});

// DELETE /api/files/:id - remove a stored file
app.delete('/api/files/:id', (req, res) => {
  const info = deleteStmt.run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'File not found.' });
  res.status(204).send();
});

// Basic error handler (e.g. multer file-too-large)
app.use((err, req, res, next) => {
  if (err) {
    return res.status(400).json({ error: err.message });
  }
  next();
});
