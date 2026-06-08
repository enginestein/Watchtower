const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '..', 'data', 'watchtower.db');

let db;

function ensureDatabaseDir() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function getDb() {
  if (!db) {
    ensureDatabaseDir();
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema();
  }
  return db;
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cameras (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      stream_url TEXT NOT NULL,
      snapshot_url TEXT,
      location TEXT,
      enabled INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS recordings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      camera_id INTEGER,
      filename TEXT NOT NULL,
      start_time DATETIME,
      end_time DATETIME,
      duration INTEGER,
      size INTEGER,
      type TEXT DEFAULT 'continuous'
    );

    CREATE TABLE IF NOT EXISTS motion_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      camera_id INTEGER,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      snapshot TEXT,
      motion_score REAL
    );

    CREATE TABLE IF NOT EXISTS human_detections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      camera_id INTEGER,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      snapshot TEXT,
      confidence REAL,
      bbox TEXT
    );

    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      source TEXT
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      camera_id INTEGER,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      acknowledged INTEGER DEFAULT 0,
      snapshot TEXT
    );

    CREATE TABLE IF NOT EXISTS frames (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      camera_id INTEGER,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      filepath TEXT NOT NULL,
      type TEXT DEFAULT 'continuous'
    );
  `);
}

const db_api = {
  getDb,

  // Cameras
  getCameras() {
    return getDb().prepare('SELECT * FROM cameras ORDER BY id').all();
  },

  getCamera(id) {
    return getDb().prepare('SELECT * FROM cameras WHERE id = ?').get(id);
  },

  addCamera({ name, stream_url, snapshot_url, location }) {
    const stmt = getDb().prepare(
      'INSERT INTO cameras (name, stream_url, snapshot_url, location) VALUES (?, ?, ?, ?)'
    );
    return stmt.run(name, stream_url, snapshot_url, location);
  },

  updateCamera(id, fields) {
    const keys = Object.keys(fields);
    const setClause = keys.map(k => `${k} = ?`).join(', ');
    const values = keys.map(k => fields[k]);
    getDb().prepare(`UPDATE cameras SET ${setClause} WHERE id = ?`).run(...values, id);
  },

  deleteCamera(id) {
    getDb().prepare('DELETE FROM cameras WHERE id = ?').run(id);
  },

  // Recordings
  getRecordings(camera_id, limit = 50, offset = 0) {
    const query = camera_id
      ? 'SELECT * FROM recordings WHERE camera_id = ? ORDER BY start_time DESC LIMIT ? OFFSET ?'
      : 'SELECT * FROM recordings ORDER BY start_time DESC LIMIT ? OFFSET ?';
    const params = camera_id ? [camera_id, limit, offset] : [limit, offset];
    return getDb().prepare(query).all(...params);
  },

  addRecording({ camera_id, filename, start_time, end_time, duration, size, type }) {
    return getDb().prepare(
      'INSERT INTO recordings (camera_id, filename, start_time, end_time, duration, size, type) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(camera_id, filename, start_time, end_time, duration, size, type);
  },

  updateRecording(id, fields) {
    const keys = Object.keys(fields);
    const setClause = keys.map(k => `${k} = ?`).join(', ');
    const values = keys.map(k => fields[k]);
    getDb().prepare(`UPDATE recordings SET ${setClause} WHERE id = ?`).run(...values, id);
  },

  deleteOldRecordings(retentionDays) {
    const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString();
    return getDb().prepare(
      "DELETE FROM recordings WHERE start_time < ?"
    ).run(cutoff);
  },

  // Motion events
  getMotionEvents(camera_id, limit = 100, offset = 0) {
    const query = camera_id
      ? 'SELECT * FROM motion_events WHERE camera_id = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?'
      : 'SELECT * FROM motion_events ORDER BY timestamp DESC LIMIT ? OFFSET ?';
    const params = camera_id ? [camera_id, limit, offset] : [limit, offset];
    return getDb().prepare(query).all(...params);
  },

  addMotionEvent({ camera_id, snapshot, motion_score }) {
    return getDb().prepare(
      'INSERT INTO motion_events (camera_id, snapshot, motion_score) VALUES (?, ?, ?)'
    ).run(camera_id, snapshot, motion_score);
  },

  getMotionEventCount(camera_id, since) {
    const query = camera_id
      ? 'SELECT COUNT(*) as count FROM motion_events WHERE camera_id = ? AND timestamp > ?'
      : 'SELECT COUNT(*) as count FROM motion_events WHERE timestamp > ?';
    const params = camera_id ? [camera_id, since] : [since];
    return getDb().prepare(query).get(...params);
  },

  // Human detections
  getHumanDetections(camera_id, limit = 100, offset = 0) {
    const query = camera_id
      ? 'SELECT * FROM human_detections WHERE camera_id = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?'
      : 'SELECT * FROM human_detections ORDER BY timestamp DESC LIMIT ? OFFSET ?';
    const params = camera_id ? [camera_id, limit, offset] : [limit, offset];
    return getDb().prepare(query).all(...params);
  },

  addHumanDetection({ camera_id, snapshot, confidence, bbox }) {
    return getDb().prepare(
      'INSERT INTO human_detections (camera_id, snapshot, confidence, bbox) VALUES (?, ?, ?, ?)'
    ).run(camera_id, snapshot, confidence, JSON.stringify(bbox));
  },

  getHumanDetectionCount(camera_id, since) {
    const query = camera_id
      ? 'SELECT COUNT(*) as count FROM human_detections WHERE camera_id = ? AND timestamp > ?'
      : 'SELECT COUNT(*) as count FROM human_detections WHERE timestamp > ?';
    const params = camera_id ? [camera_id, since] : [since];
    return getDb().prepare(query).get(...params);
  },

  // Logs
  getLogs(level, limit = 200, offset = 0) {
    const query = level
      ? 'SELECT * FROM logs WHERE level = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?'
      : 'SELECT * FROM logs ORDER BY timestamp DESC LIMIT ? OFFSET ?';
    const params = level ? [level, limit, offset] : [limit, offset];
    return getDb().prepare(query).all(...params);
  },

  addLog({ level, message, source }) {
    return getDb().prepare(
      'INSERT INTO logs (level, message, source) VALUES (?, ?, ?)'
    ).run(level, message, source);
  },

  getLogCount(level) {
    const query = level
      ? 'SELECT COUNT(*) as count FROM logs WHERE level = ?'
      : 'SELECT COUNT(*) as count FROM logs';
    const params = level ? [level] : [];
    return getDb().prepare(query).get(...params);
  },

  cleanOldLogs(daysToKeep = 30) {
    const cutoff = new Date(Date.now() - daysToKeep * 86400000).toISOString();
    getDb().prepare("DELETE FROM logs WHERE timestamp < ?").run(cutoff);
  },

  // Alerts
  getAlerts(limit = 50, offset = 0, acknowledged = null) {
    let query = 'SELECT * FROM alerts';
    const params = [];
    if (acknowledged !== null) {
      query += ' WHERE acknowledged = ?';
      params.push(acknowledged ? 1 : 0);
    }
    query += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);
    return getDb().prepare(query).all(...params);
  },

  addAlert({ camera_id, type, message, snapshot }) {
    return getDb().prepare(
      'INSERT INTO alerts (camera_id, type, message, snapshot) VALUES (?, ?, ?, ?)'
    ).run(camera_id, type, message, snapshot);
  },

  getUnacknowledgedAlertCount() {
    return getDb().prepare(
      'SELECT COUNT(*) as count FROM alerts WHERE acknowledged = 0'
    ).get();
  },

  acknowledgeAlert(id) {
    getDb().prepare('UPDATE alerts SET acknowledged = 1 WHERE id = ?').run(id);
  },

  acknowledgeAllAlerts() {
    getDb().prepare('UPDATE alerts SET acknowledged = 1 WHERE acknowledged = 0').run();
  },

  // Frames
  addFrame({ camera_id, filepath, type }) {
    return getDb().prepare(
      'INSERT INTO frames (camera_id, filepath, type) VALUES (?, ?, ?)'
    ).run(camera_id, filepath, type);
  },

  getDateRangeCount(field, table) {
    const result = getDb().prepare(`
      SELECT DATE(${field}) as date, COUNT(*) as count
      FROM ${table}
      GROUP BY DATE(${field})
      ORDER BY date DESC
      LIMIT 30
    `).all();
    return result;
  },

  getStats() {
    return {
      recordings: getDb().prepare('SELECT COUNT(*) as count FROM recordings').get().count,
      motion_events: getDb().prepare('SELECT COUNT(*) as count FROM motion_events').get().count,
      human_detections: getDb().prepare('SELECT COUNT(*) as count FROM human_detections').get().count,
      alerts: getDb().prepare('SELECT COUNT(*) as count FROM alerts').get().count,
      unacknowledged_alerts: getDb().prepare('SELECT COUNT(*) as count FROM alerts WHERE acknowledged = 0').get().count,
      logs: getDb().prepare('SELECT COUNT(*) as count FROM logs').get().count,
      cameras: getDb().prepare('SELECT COUNT(*) as count FROM cameras').get().count,
      frames: getDb().prepare('SELECT COUNT(*) as count FROM frames').get().count
    };
  },

  getDashboardStats() {
    const now = new Date().toISOString();
    const today = now.split('T')[0];
    const last24h = new Date(Date.now() - 86400000).toISOString();
    const last7d = new Date(Date.now() - 7 * 86400000).toISOString();

    return {
      total_recordings: getDb().prepare('SELECT COUNT(*) as count FROM recordings').get().count,
      recordings_today: getDb().prepare('SELECT COUNT(*) as count FROM recordings WHERE DATE(start_time) = ?').get(today).count,
      recordings_24h: getDb().prepare('SELECT COUNT(*) as count FROM recordings WHERE start_time > ?').get(last24h).count,
      motion_events: getDb().prepare('SELECT COUNT(*) as count FROM motion_events').get().count,
      motion_events_24h: getDb().prepare('SELECT COUNT(*) as count FROM motion_events WHERE timestamp > ?').get(last24h).count,
      humans_detected: getDb().prepare('SELECT COUNT(*) as count FROM human_detections').get().count,
      humans_detected_24h: getDb().prepare('SELECT COUNT(*) as count FROM human_detections WHERE timestamp > ?').get(last24h).count,
      alerts_24h: getDb().prepare('SELECT COUNT(*) as count FROM alerts WHERE timestamp > ?').get(last24h).count,
      unread_alerts: getDb().prepare('SELECT COUNT(*) as count FROM alerts WHERE acknowledged = 0').get().count,
      active_cameras: getDb().prepare('SELECT COUNT(*) as count FROM cameras WHERE enabled = 1').get().count,
      storage_used: getDb().prepare('SELECT COALESCE(SUM(size), 0) as total FROM recordings').get().total
    };
  },

  getRecordingsTimeline(days = 7) {
    const since = new Date(Date.now() - days * 86400000).toISOString();
    return getDb().prepare(`
      SELECT DATE(start_time) as date, COUNT(*) as count, COALESCE(SUM(duration), 0) as total_duration
      FROM recordings
      WHERE start_time > ?
      GROUP BY DATE(start_time)
      ORDER BY date ASC
    `).all(since);
  }
};

module.exports = db_api;
