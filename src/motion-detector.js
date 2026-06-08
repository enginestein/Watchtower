const { EventEmitter } = require('events');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const db = require('./database');
const logger = require('./logger');
const config = require('../config.json');

class MotionDetector extends EventEmitter {
  constructor() {
    super();
    this.previousFrames = new Map();
    this.motionCooldowns = new Map();
    this.processing = new Set();
    this.enabled = config.motion_detection?.enabled !== false;
    this.threshold = config.motion_detection?.threshold || 5.0;
    this.sensitivity = config.motion_detection?.sensitivity || 25;
    this.cooldownMs = config.motion_detection?.cooldown_ms || 2000;
    this.motionCounts = new Map();
  }

  async detect(cameraId, frameBuffer) {
    if (!this.enabled) return null;
    if (this.processing.has(cameraId)) return null;

    this.processing.add(cameraId);

    try {
      const result = await this._detectMotion(cameraId, frameBuffer);
      return result;
    } catch (err) {
      logger.error(`Motion detection error on camera ${cameraId}: ${err.message}`, 'motion-detector');
      return null;
    } finally {
      this.processing.delete(cameraId);
    }
  }

  async _detectMotion(cameraId, frameBuffer) {
    const grayKey = `${cameraId}_gray`;
    const prevGray = this.previousFrames.get(grayKey);

    let grayBuffer;
    try {
      grayBuffer = await sharp(frameBuffer)
        .grayscale()
        .jpeg({ quality: 30 })
        .toBuffer();
    } catch (err) {
      logger.debug(`Image processing error: ${err.message}`, 'motion-detector');
      return null;
    }

    if (!prevGray || prevGray.length !== grayBuffer.length) {
      this.previousFrames.set(grayKey, grayBuffer);
      return null;
    }

    const diff = this._computeDifference(prevGray, grayBuffer);
    this.previousFrames.set(grayKey, grayBuffer);

    if (diff === null) return null;

    const motionDetected = diff > this.threshold;

    if (motionDetected) {
      const now = Date.now();
      const lastMotion = this.motionCooldowns.get(cameraId) || 0;

      if (now - lastMotion < this.cooldownMs) {
        return { motion: true, score: diff, cooldown: true };
      }

      this.motionCooldowns.set(cameraId, now);

      const count = (this.motionCounts.get(cameraId) || 0) + 1;
      this.motionCounts.set(cameraId, count);

      let snapshotPath = null;
      if (config.storage?.snapshots_path) {
        snapshotPath = await this._saveSnapshot(cameraId, frameBuffer);
      }

      try {
        db.addMotionEvent({
          camera_id: cameraId,
          snapshot: snapshotPath,
          motion_score: diff
        });
      } catch (err) {
        logger.error(`Failed to save motion event: ${err.message}`, 'motion-detector');
      }

      logger.info(`Motion detected on camera ${cameraId} (score: ${diff.toFixed(1)})`, 'motion-detector');

      this.emit('motion', {
        cameraId,
        score: diff,
        timestamp: new Date().toISOString(),
        snapshot: snapshotPath,
        eventCount: count
      });

      return { motion: true, score: diff, snapshot: snapshotPath };
    }

    return { motion: false, score: diff };
  }

  _computeDifference(prev, curr) {
    try {
      if (!prev || !curr || prev.length !== curr.length) return null;

      let diffPixels = 0;
      const totalPixels = Math.min(prev.length, curr.length);

      for (let i = 0; i < totalPixels; i++) {
        const delta = Math.abs(prev[i] - curr[i]);
        if (delta > this.sensitivity) {
          diffPixels++;
        }
      }

      const percentage = (diffPixels / totalPixels) * 100;
      return percentage;
    } catch (err) {
      logger.error(`Difference computation error: ${err.message}`, 'motion-detector');
      return null;
    }
  }

  async _saveSnapshot(cameraId, frameBuffer) {
    try {
      const snapDir = path.join(config.storage.snapshots_path, 'motion', String(cameraId));
      if (!fs.existsSync(snapDir)) {
        fs.mkdirSync(snapDir, { recursive: true });
      }

      const filename = `motion_${cameraId}_${Date.now()}.jpg`;
      const filepath = path.join(snapDir, filename);

      const resized = await sharp(frameBuffer)
        .resize(640, 480, { fit: 'inside' })
        .jpeg({ quality: 70 })
        .toBuffer();

      fs.writeFileSync(filepath, resized);
      return path.relative(path.join(__dirname, '..'), filepath);
    } catch (err) {
      logger.error(`Snapshot save error: ${err.message}`, 'motion-detector');
      return null;
    }
  }

  setSensitivity(level) {
    this.sensitivity = Math.max(5, Math.min(100, level));
    logger.info(`Motion sensitivity set to ${this.sensitivity}`, 'motion-detector');
  }

  setThreshold(level) {
    this.threshold = Math.max(0.5, Math.min(50, level));
    logger.info(`Motion threshold set to ${this.threshold}`, 'motion-detector');
  }

  enable() {
    this.enabled = true;
    logger.info('Motion detection enabled', 'motion-detector');
  }

  disable() {
    this.enabled = false;
    this.reset();
    logger.info('Motion detection disabled', 'motion-detector');
  }

  reset(cameraId) {
    if (cameraId) {
      this.previousFrames.delete(`${cameraId}_gray`);
      this.motionCooldowns.delete(cameraId);
      this.processing.delete(cameraId);
    } else {
      this.previousFrames.clear();
      this.motionCooldowns.clear();
      this.processing.clear();
    }
  }

  getStats(cameraId) {
    return {
      enabled: this.enabled,
      sensitivity: this.sensitivity,
      threshold: this.threshold,
      cooldownMs: this.cooldownMs,
      motionCount: cameraId
        ? (this.motionCounts.get(cameraId) || 0)
        : Array.from(this.motionCounts.values()).reduce((s, c) => s + c, 0)
    };
  }

  shutdown() {
    this.reset();
    this.removeAllListeners();
    logger.info('Motion detector shut down', 'motion-detector');
  }
}

module.exports = new MotionDetector();
