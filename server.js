const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const config = require('./config.json');

const logger = require('./src/logger');
const db = require('./src/database');
const cameraManager = require('./src/camera-manager');
const motionDetector = require('./src/motion-detector');
const humanDetector = require('./src/human-detector');
const recorder = require('./src/recorder');
const alertManager = require('./src/alert-manager');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  maxHttpBufferSize: 5e7
});

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// API Routes
// ============================================================

// -- Dashboard Stats
app.get('/api/stats', (req, res) => {
  try {
    const stats = db.getDashboardStats();
    stats.camera_stats = cameraManager.getStats();
    stats.motion_stats = motionDetector.getStats();
    stats.human_stats = humanDetector.getStats();
    stats.recorder_stats = recorder.getStats();
    stats.alert_stats = alertManager.getStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -- Cameras
app.get('/api/cameras', (req, res) => {
  try {
    const cams = cameraManager.getAllCameras().map(c => ({
      ...c,
      status: cameraManager.getCameraStatus(c.id)
    }));
    res.json(cams);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/cameras/:id', (req, res) => {
  try {
    const cam = cameraManager.getCamera(parseInt(req.params.id));
    if (!cam) return res.status(404).json({ error: 'Camera not found' });
    res.json({ ...cam, status: cameraManager.getCameraStatus(cam.id) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/cameras', (req, res) => {
  try {
    const { name, stream_url, snapshot_url, location } = req.body;
    if (!name || !stream_url) {
      return res.status(400).json({ error: 'Name and stream_url required' });
    }
    const result = db.addCamera({ name, stream_url, snapshot_url, location });
    const cam = cameraManager.registerCamera({
      id: result.lastInsertRowid,
      name,
      stream_url,
      snapshot_url,
      location,
      enabled: true,
      fps: 5
    });
    res.json(cam);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/cameras/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    cameraManager.updateCameraConfig(id, req.body);
    db.updateCamera(id, req.body);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/cameras/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    cameraManager.stopStream(id);
    db.deleteCamera(id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/cameras/:id/test', async (req, res) => {
  try {
    const result = await cameraManager.testConnection(parseInt(req.params.id));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/cameras/:id/stream/start', async (req, res) => {
  try {
    await cameraManager.startStream(parseInt(req.params.id));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/cameras/:id/settings', async (req, res) => {
  try {
    const cam = cameraManager.getCamera(parseInt(req.params.id));
    if (!cam) return res.status(404).json({ error: 'Camera not found' });
    const settings = await cameraManager.fetchSettings(parseInt(req.params.id));
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/cameras/:id/settings', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const settings = req.body;
    const result = await cameraManager.applySettings(id, settings);
    if (result.success) {
      const cfgPath = path.join(__dirname, 'config.json');
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      const camCfg = cfg.cameras.find(c => c.id === id);
      if (camCfg) {
        camCfg.settings = { ...camCfg.settings, ...settings };
        fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
      }
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/cameras/:id/stream/stop', (req, res) => {
  try {
    cameraManager.stopStream(parseInt(req.params.id));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/cameras/:id/snapshot', async (req, res) => {
  try {
    const frame = await cameraManager.takeSnapshot(parseInt(req.params.id));
    if (!frame) return res.status(404).json({ error: 'No frame available' });
    res.set('Content-Type', 'image/jpeg');
    res.send(frame);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/cameras/:id/live.jpg', (req, res) => {
  const camId = parseInt(req.params.id);
  const frame = cameraManager.getCurrentFrame(camId);
  if (!frame) {
    return res.status(404).json({ error: 'No frame available' });
  }
  res.set({
    'Content-Type': 'image/jpeg',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0'
  });
  res.send(frame);
});

// -- Recordings
app.get('/api/recordings', (req, res) => {
  try {
    const camera_id = req.query.camera_id ? parseInt(req.query.camera_id) : null;
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    const recordings = db.getRecordings(camera_id, limit, offset);
    res.json(recordings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/recordings/:id/files', (req, res) => {
  try {
    const recId = parseInt(req.params.id);
    const recs = db.getRecordings(null, 1000, 0);
    const rec = recs.find(r => r.id === recId);
    if (!rec) return res.status(404).json({ error: 'Recording not found' });
    const files = recorder.getRecordingFiles(rec.camera_id, rec.type);
    res.json({ recording: rec, files });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/recordings', (req, res) => {
  try {
    db.deleteOldRecordings(0);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -- Motion Events
app.get('/api/motion-events', (req, res) => {
  try {
    const camera_id = req.query.camera_id ? parseInt(req.query.camera_id) : null;
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;
    const events = db.getMotionEvents(camera_id, limit, offset);
    res.json(events);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -- Human Detections
app.get('/api/human-detections', (req, res) => {
  try {
    const camera_id = req.query.camera_id ? parseInt(req.query.camera_id) : null;
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;
    const detections = db.getHumanDetections(camera_id, limit, offset);
    res.json(detections);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -- Alerts
app.get('/api/alerts', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    const acknowledged = req.query.acknowledged !== undefined
      ? req.query.acknowledged === 'true' ? true : req.query.acknowledged === 'false' ? false : null
      : null;
    const alerts = db.getAlerts(limit, offset, acknowledged);
    res.json(alerts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/alerts/:id/acknowledge', (req, res) => {
  try {
    alertManager.acknowledgeAlert(parseInt(req.params.id));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/alerts/acknowledge-all', (req, res) => {
  try {
    alertManager.acknowledgeAll();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -- Logs
app.get('/api/logs', (req, res) => {
  try {
    const level = req.query.level || null;
    const limit = parseInt(req.query.limit) || 200;
    const offset = parseInt(req.query.offset) || 0;
    const logs = db.getLogs(level, limit, offset);
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/logs', (req, res) => {
  try {
    db.cleanOldLogs(0);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -- Config
app.get('/api/config', (req, res) => {
  res.json(config);
});

app.put('/api/config', (req, res) => {
  try {
    Object.assign(config, req.body);
    fs.writeFileSync(
      path.join(__dirname, 'config.json'),
      JSON.stringify(config, null, 2)
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -- Motion detection control
app.post('/api/motion/enable', (req, res) => {
  motionDetector.enable();
  res.json({ success: true, enabled: true });
});

app.post('/api/motion/disable', (req, res) => {
  motionDetector.disable();
  res.json({ success: true, enabled: false });
});

app.put('/api/motion/settings', (req, res) => {
  if (req.body.sensitivity) motionDetector.setSensitivity(req.body.sensitivity);
  if (req.body.threshold) motionDetector.setThreshold(req.body.threshold);
  res.json(motionDetector.getStats());
});

// -- Human detection control
app.post('/api/human-detection/enable', (req, res) => {
  humanDetector.enable();
  res.json({ success: true, enabled: true });
});

app.post('/api/human-detection/disable', (req, res) => {
  humanDetector.disable();
  res.json({ success: true, enabled: false });
});

app.put('/api/human-detection/settings', (req, res) => {
  if (req.body.confidence_threshold) {
    humanDetector.setConfidenceThreshold(req.body.confidence_threshold);
  }
  res.json(humanDetector.getStats());
});

// -- Static file serving for snapshots/recordings
app.use('/snapshots', express.static(path.join(__dirname, 'snapshots')));
app.use('/recordings', express.static(path.join(__dirname, 'recordings')));

// Catch-all for SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================================
// WebSocket (Socket.IO)
// ============================================================

io.on('connection', (socket) => {
  logger.info(`Client connected: ${socket.id}`, 'websocket');

  // Client joins a camera room
  socket.on('subscribe_camera', (cameraId) => {
    socket.join(`camera_${cameraId}`);
    logger.debug(`Client ${socket.id} subscribed to camera ${cameraId}`, 'websocket');
  });

  socket.on('unsubscribe_camera', (cameraId) => {
    socket.leave(`camera_${cameraId}`);
  });

  // Request immediate snapshot
  socket.on('request_snapshot', async (cameraId) => {
    const frame = await cameraManager.takeSnapshot(cameraId);
    if (frame) {
      const base64 = frame.toString('base64');
      socket.emit('snapshot', { cameraId, data: `data:image/jpeg;base64,${base64}` });
    }
  });

  // Acknowledge alert
  socket.on('acknowledge_alert', (alertId) => {
    alertManager.acknowledgeAlert(alertId);
  });

  socket.on('acknowledge_all_alerts', () => {
    alertManager.acknowledgeAll();
  });

  socket.on('disconnect', () => {
    logger.debug(`Client disconnected: ${socket.id}`, 'websocket');
  });
});

// ============================================================
// Background Pipeline
// ============================================================

async function processFrame({ cameraId, frame, camera }) {
  // Record continuous frames
  await recorder.recordFrame(cameraId, frame, 'continuous');

  // Broadcast live frame via WebSocket (base64 for direct display)
  io.to(`camera_${cameraId}`).emit('frame', {
    cameraId,
    timestamp: Date.now(),
    cameraName: camera.name,
    data: frame.toString('base64')
  });

  // Motion detection
  const motionResult = await motionDetector.detect(cameraId, frame);
  if (motionResult && motionResult.motion && !motionResult.cooldown) {
    // Trigger motion recording
    await recorder.triggerMotionRecording(cameraId, frame);

    // Fire motion alert
    await alertManager.fireAlert(
      cameraId,
      'motion',
      `Motion detected on ${camera.name} (score: ${motionResult.score.toFixed(1)})`,
      motionResult.snapshot
    );

    // Broadcast motion event
    io.emit('motion_event', {
      cameraId,
      cameraName: camera.name,
      score: motionResult.score,
      snapshot: motionResult.snapshot,
      timestamp: new Date().toISOString()
    });
  }

  // Human detection (only every N frames to save CPU)
  const humanResult = await humanDetector.detect(cameraId, frame);
  if (humanResult && humanResult.detected) {
    // Fire human alert
    await alertManager.fireAlert(
      cameraId,
      'human',
      `Human detected on ${camera.name} (${humanResult.count} person(s))`,
      humanResult.snapshot
    );

    // Broadcast human detection
    io.emit('human_detection', {
      cameraId,
      cameraName: camera.name,
      count: humanResult.count,
      humans: humanResult.humans,
      snapshot: humanResult.snapshot,
      timestamp: new Date().toISOString()
    });
  }
}

// ============================================================
// System Events/Logging
// ============================================================

// Log emitted events
cameraManager.on('frame', (data) => {
  processFrame(data).catch(err => {
    logger.error(`Frame processing error: ${err.message}`, 'pipeline');
  });
});

cameraManager.on('error', ({ cameraId, error, camera }) => {
  io.emit('camera_error', { cameraId, error, timestamp: new Date().toISOString() });
  alertManager.fireAlert(cameraId, 'error', `Camera ${camera?.name || cameraId} error: ${error}`);
});

alertManager.on('alert', (alert) => {
  io.emit('new_alert', alert);
});

alertManager.on('alert_acknowledged', ({ alertId }) => {
  io.emit('alert_acknowledged', { alertId });
});

alertManager.on('all_alerts_acknowledged', () => {
  io.emit('all_alerts_acknowledged');
});

// ============================================================
// Startup
// ============================================================

async function startup() {
  logger.info('Starting Watchtower...', 'system');

  // Ensure directories
  for (const dir of ['recordings', 'snapshots', 'logs', 'data']) {
    const d = path.join(__dirname, dir);
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }

  // Initialize components
  db.getDb();
  logger.info('Database initialized', 'system');

  await recorder.init();
  logger.info('Recorder initialized', 'system');

  const camCount = await cameraManager.init();
  logger.info(`Camera manager initialized with ${camCount} cameras`, 'system');

  // Start all camera streams
  for (const cam of cameraManager.getAllCameras()) {
    if (cam.enabled) {
      cameraManager.startStream(cam.id).then(ok => {
        logger.info(`Camera stream started: ${cam.name} (${ok ? 'OK' : 'FAILED'})`, 'system');
        io.emit('camera_status', { cameraId: cam.id, status: ok ? 'connected' : 'error' });
      });
    }
  }

  // Start HTTP server FIRST so it's available immediately
  const port = config.server.port || 3000;
  const host = config.server.host || '0.0.0.0';

  server.listen(port, host, () => {
    logger.info(`Server listening on http://${host}:${port}`, 'system');
    logger.info(`Dashboard: http://localhost:${port}`, 'system');

    alertManager.fireAlert(null, 'info', 'Watchtower started successfully').catch(() => {});
  });

  // Defer heavy initialization (TF model loading) so server can accept connections
  setImmediate(async () => {
    await humanDetector.initialize();
  });

  // Periodic stats broadcast
  setInterval(() => {
    try {
      const stats = db.getDashboardStats();
      stats.camera_stats = cameraManager.getStats();
      stats.motion_stats = motionDetector.getStats();
      stats.human_stats = humanDetector.getStats();
      stats.recorder_stats = recorder.getStats();
      stats.unread_alerts = alertManager.getUnacknowledgedCount();
      io.emit('stats_update', stats);
    } catch (err) {
      // silent
    }
  }, 5000);

  // Periodic log cleanup
  setInterval(() => {
    try {
      db.cleanOldLogs(30);
    } catch (err) {
      // silent
    }
  }, 3600000); // hourly
}

// Graceful shutdown
async function shutdown() {
  logger.info('Shutting down...', 'system');
  cameraManager.shutdown();
  motionDetector.shutdown();
  humanDetector.shutdown();
  recorder.shutdown();
  alertManager.shutdown();
  io.close();
  server.close(() => {
    logger.info('Server stopped', 'system');
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (err) => {
  logger.error(`Uncaught exception: ${err.message}`, 'system');
  logger.error(err.stack || '', 'system');
});
process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled rejection: ${reason}`, 'system');
});

startup();
