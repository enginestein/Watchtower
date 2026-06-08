const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const db = require('./database');
const logger = require('./logger');
const config = require('../config.json');

class Recorder extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map();
    this.enabled = config.recording?.enabled !== false;
    this.continuous = config.recording?.continuous !== false;
    this.motionOnly = config.recording?.motion_only === true;
    this.segmentDuration = (config.recording?.segment_duration_sec || 300) * 1000;
    this.retentionDays = config.recording?.retention_days || 14;
    this.continuousFps = config.recording?.continuous_fps || 1;
    this.motionFps = config.recording?.motion_fps || 5;
    this.basePath = path.resolve(config.storage?.recordings_path || './recordings');
    this.lastFrameTime = new Map();
    this.motionActive = new Map();
  }

  async init() {
    if (!fs.existsSync(this.basePath)) {
      fs.mkdirSync(this.basePath, { recursive: true });
    }
    if (this.enabled && this.continuous) {
      for (const cam of (config.cameras || [])) {
        if (cam.enabled !== false) {
          this.startSession(cam.id, 'continuous');
        }
      }
    }
    logger.info('Recorder initialized', 'recorder');
  }

  startSession(cameraId, type = 'continuous') {
    if (!this.enabled) return null;

    if (this.sessions.has(cameraId)) {
      const existing = this.sessions.get(cameraId);
      if (existing.type === type) return existing;
      this.stopSession(cameraId);
    }

    const sessionDir = path.join(this.basePath, String(cameraId), type);
    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true });
    }

    const sessionId = `${cameraId}_${type}_${Date.now()}`;
    const sessionStart = new Date().toISOString();

    const session = {
      id: sessionId,
      cameraId,
      type,
      startTime: Date.now(),
      startTimeISO: sessionStart,
      dir: sessionDir,
      frameCount: 0,
      frames: [],
      active: true
    };

    this.sessions.set(cameraId, session);
    logger.info(`Recording session started: camera=${cameraId} type=${type}`, 'recorder');

    this.emit('session_start', {
      cameraId,
      sessionId,
      type,
      startTime: sessionStart
    });

    return session;
  }

  async recordFrame(cameraId, frameBuffer, frameType = 'continuous') {
    if (!this.enabled) return;

    let session = this.sessions.get(cameraId);
    const isMotionFrame = frameType === 'motion';

    if (this.motionOnly && !isMotionFrame) return;

    if (!session || session.type !== frameType) {
      if (session && session.type !== frameType) {
        this.stopSession(cameraId);
      }
      session = this.startSession(cameraId, frameType);
      if (!session) return;
    }

    const now = Date.now();

    // Throttle based on fps
    const fps = isMotionFrame ? this.motionFps : this.continuousFps;
    const minInterval = 1000 / fps;
    const lastTime = this.lastFrameTime.get(`${cameraId}_${frameType}`) || 0;
    if (now - lastTime < minInterval) return;
    this.lastFrameTime.set(`${cameraId}_${frameType}`, now);

    try {
      const metadata = await sharp(frameBuffer).metadata();
      const filename = `${frameType}_${now}.jpg`;
      const filepath = path.join(session.dir, filename);

      await sharp(frameBuffer)
        .resize(800, 600, { fit: 'inside' })
        .jpeg({ quality: 75 })
        .toFile(filepath);

      session.frameCount++;
      session.frames.push(filepath);

      try {
        db.addFrame({
          camera_id: cameraId,
          filepath: path.relative(path.join(__dirname, '..'), filepath),
          type: frameType
        });
      } catch (err) {
        // silent
      }

      // Check if segment should be finalized
      if (now - session.startTime >= this.segmentDuration) {
        await this.finalizeSegment(cameraId);
        this.startSession(cameraId, frameType);
      }
    } catch (err) {
      logger.error(`Frame recording error: ${err.message}`, 'recorder');
    }
  }

  async stopSession(cameraId) {
    const session = this.sessions.get(cameraId);
    if (!session) return null;

    session.active = false;
    await this.finalizeSegment(cameraId);
    return session;
  }

  async finalizeSegment(cameraId) {
    const session = this.sessions.get(cameraId);
    if (!session || session.frameCount === 0) {
      this.sessions.delete(cameraId);
      return null;
    }

    const endTime = new Date().toISOString();
    const duration = Math.round((Date.now() - session.startTime) / 1000);

    let totalSize = 0;
    for (const fp of session.frames) {
      try {
        totalSize += fs.statSync(fp).size;
      } catch (e) { /* ignore */ }
    }

    const recording = {
      camera_id: cameraId,
      filename: `${session.type}_${cameraId}_${session.startTime}.jpg`,
      start_time: session.startTimeISO,
      end_time: endTime,
      duration,
      size: totalSize,
      type: session.type
    };

    // Remove individual frames - just keep them as directory structure
    // The recording entry tracks the session

    try {
      const result = db.addRecording(recording);
      recording.id = result.lastInsertRowid;
    } catch (err) {
      logger.error(`Failed to save recording record: ${err.message}`, 'recorder');
    }

    this.emit('segment_finalized', {
      cameraId,
      recording,
      frameCount: session.frameCount
    });

    logger.info(
      `Segment finalized: camera=${cameraId} type=${session.type} frames=${session.frameCount} duration=${duration}s`,
      'recorder'
    );

    this.sessions.delete(cameraId);

    // Cleanup old recordings
    this.cleanupOldRecordings();

    return recording;
  }

  async triggerMotionRecording(cameraId, frameBuffer) {
    if (!this.enabled || !frameBuffer) return;

    const isMotionActive = this.motionActive.get(cameraId) || false;

    // Check if we're within 3 seconds of last motion (cooldown overlap)
    if (!isMotionActive) {
      this.motionActive.set(cameraId, true);
      // Start a motion recording session alongside continuous
      await this.recordFrame(cameraId, frameBuffer, 'motion');
    } else {
      await this.recordFrame(cameraId, frameBuffer, 'motion');
    }

    // Auto-disable motion recording after 3 seconds of no motion
    if (this.motionTimers && this.motionTimers[cameraId]) {
      clearTimeout(this.motionTimers[cameraId]);
    }
    if (!this.motionTimers) this.motionTimers = {};
    this.motionTimers[cameraId] = setTimeout(() => {
      this.motionActive.set(cameraId, false);
      this.stopSession(cameraId);
    }, 3000);
  }

  async getRecordingPath(cameraId, recordingId) {
    const rec = db.getRecordings(cameraId, 1, 0);
    if (!rec || rec.length === 0) return null;
    const dir = path.join(this.basePath, String(cameraId));
    return dir;
  }

  getRecordingFiles(cameraId, type = null) {
    const camDir = path.join(this.basePath, String(cameraId));
    if (!fs.existsSync(camDir)) return [];

    const typeDir = type ? path.join(camDir, type) : camDir;
    if (!fs.existsSync(typeDir)) return [];

    try {
      const projectRoot = path.resolve(__dirname, '..');
      const files = fs.readdirSync(typeDir)
        .filter(f => f.endsWith('.jpg'))
        .sort()
        .map(f => {
          const absPath = path.join(typeDir, f);
          return {
            filename: f,
            path: path.relative(projectRoot, absPath),
            timestamp: parseInt(f.split('_').pop()?.replace('.jpg', '') || '0'),
            size: fs.statSync(absPath).size
          };
        });
      return files;
    } catch (err) {
      logger.error(`Error reading recording files: ${err.message}`, 'recorder');
      return [];
    }
  }

  cleanupOldRecordings() {
    try {
      const cutoff = Date.now() - this.retentionDays * 86400000;
      const result = db.deleteOldRecordings(this.retentionDays);

      // Remove old frame files
      const camIds = fs.readdirSync(this.basePath);
      for (const camId of camIds) {
        const camDir = path.join(this.basePath, camId);
        if (!fs.statSync(camDir).isDirectory()) continue;
        for (const type of fs.readdirSync(camDir)) {
          const typeDir = path.join(camDir, type);
          if (!fs.statSync(typeDir).isDirectory()) continue;
          for (const file of fs.readdirSync(typeDir)) {
            const filepath = path.join(typeDir, file);
            const fileTime = fs.statSync(filepath).mtimeMs;
            if (fileTime < cutoff) {
              fs.unlinkSync(filepath);
            }
          }
        }
      }

      if (result.changes > 0) {
        logger.info(`Cleaned up ${result.changes} old recording records`, 'recorder');
      }
    } catch (err) {
      logger.error(`Cleanup error: ${err.message}`, 'recorder');
    }
  }

  enable() {
    this.enabled = true;
    logger.info('Recording enabled', 'recorder');
  }

  disable() {
    this.enabled = false;
    for (const cameraId of this.sessions.keys()) {
      this.stopSession(cameraId);
    }
    logger.info('Recording disabled', 'recorder');
  }

  getStats() {
    return {
      enabled: this.enabled,
      continuous: this.continuous,
      motionOnly: this.motionOnly,
      sessions: this.sessions.size,
      retentionDays: this.retentionDays,
      segmentDuration: this.segmentDuration
    };
  }

  shutdown() {
    for (const cameraId of this.sessions.keys()) {
      this.stopSession(cameraId);
    }
    this.removeAllListeners();
    logger.info('Recorder shut down', 'recorder');
  }
}

module.exports = new Recorder();
