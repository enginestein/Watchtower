const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
const db = require('./database');
const logger = require('./logger');
const sharp = require('sharp');
const config = require('../config.json');

class HumanDetector extends EventEmitter {
  constructor() {
    super();
    this.enabled = config.human_detection?.enabled !== false;
    this.confidenceThreshold = config.human_detection?.confidence_threshold || 0.5;
    this.intervalMs = config.human_detection?.interval_ms || 2000;
    this.processing = new Set();
    this.lastDetection = new Map();
    this.totalDetections = 0;
    this.modelLoaded = false;
    this.model = null;
  }

  async initialize() {
    if (!this.enabled) {
      logger.info('Human detection disabled by config', 'human-detector');
      return false;
    }

    try {
      const tf = require('@tensorflow/tfjs-node');
      const cocoSsd = require('@tensorflow-models/coco-ssd');
      this.model = await cocoSsd.load();
      this.modelLoaded = true;
      logger.info('COCO-SSD model loaded successfully', 'human-detector');
      return true;
    } catch (err) {
      logger.warn(`TensorFlow.js not available: ${err.message}. Human detection disabled.`, 'human-detector');
      logger.info('Install with: npm install @tensorflow/tfjs-node @tensorflow-models/coco-ssd', 'human-detector');
      this.enabled = false;
      return false;
    }
  }

  async detect(cameraId, frameBuffer) {
    if (!this.enabled || !this.modelLoaded) return null;
    if (this.processing.has(cameraId)) return null;

    const now = Date.now();
    const lastDetect = this.lastDetection.get(cameraId) || 0;
    if (now - lastDetect < this.intervalMs) return null;

    this.processing.add(cameraId);
    this.lastDetection.set(cameraId, now);

    try {
      return await this._detectHumans(cameraId, frameBuffer);
    } catch (err) {
      logger.error(`Human detection error on camera ${cameraId}: ${err.message}`, 'human-detector');
      return null;
    } finally {
      this.processing.delete(cameraId);
    }
  }

  async _detectHumans(cameraId, frameBuffer) {
    const tf = require('@tensorflow/tfjs-node');

    let imageBuffer = frameBuffer;
    try {
      const metadata = await sharp(imageBuffer).metadata();
      if (metadata.width > 640) {
        imageBuffer = await sharp(imageBuffer)
          .resize(640)
          .jpeg({ quality: 80 })
          .toBuffer();
      }
    } catch (err) {
      logger.debug(`Image resize error: ${err.message}`, 'human-detector');
    }

    const imgTensor = tf.node.decodeImage(imageBuffer, 3);
    let predictions;

    try {
      predictions = await this.model.detect(imgTensor);
    } finally {
      imgTensor.dispose();
    }

    const humans = predictions.filter(p =>
      p.class === 'person' && p.score >= this.confidenceThreshold
    );

    if (humans.length === 0) return { detected: false, humans: [], count: 0 };

    this.totalDetections++;

    let snapshotPath = null;
    if (config.storage?.snapshots_path) {
      snapshotPath = await this._saveDetectionSnapshot(cameraId, frameBuffer, humans);
    }

    const detectionRecord = {
      camera_id: cameraId,
      snapshot: snapshotPath,
      confidence: humans[0].score,
      bbox: humans.map(h => ({
        bbox: h.bbox,
        score: h.score
      }))
    };

    try {
      db.addHumanDetection(detectionRecord);
    } catch (err) {
      logger.error(`Failed to save human detection: ${err.message}`, 'human-detector');
    }

    logger.info(`Human(s) detected on camera ${cameraId} (count: ${humans.length})`, 'human-detector');

    const result = {
      detected: true,
      count: humans.length,
      humans: humans.map(h => ({
        bbox: h.bbox,
        confidence: h.score
      })),
      timestamp: new Date().toISOString(),
      snapshot: snapshotPath
    };

    this.emit('human_detected', { cameraId, ...result });

    return result;
  }

  async _saveDetectionSnapshot(cameraId, frameBuffer, humans) {
    try {
      const snapDir = path.join(config.storage.snapshots_path, 'humans', String(cameraId));
      if (!fs.existsSync(snapDir)) {
        fs.mkdirSync(snapDir, { recursive: true });
      }

      const filename = `human_${cameraId}_${Date.now()}.jpg`;
      const filepath = path.join(snapDir, filename);

      const img = sharp(frameBuffer);

      // Draw bounding boxes
      const svgRects = humans.map((h, i) => {
        const [x, y, w, ht] = h.bbox;
        return `<rect x="${x}" y="${y}" width="${w}" height="${ht}"
          fill="none" stroke="#ff4444" stroke-width="3"/>
          <text x="${x}" y="${y - 5}" fill="#ff4444" font-size="16"
            font-family="monospace">PERSON ${(h.score * 100).toFixed(0)}%</text>`;
      }).join('');

      const svgOverlay = Buffer.from(
        `<svg width="${(await img.metadata()).width}" height="${(await img.metadata()).height}">
          ${svgRects}
        </svg>`
      );

      const composited = await img
        .composite([{ input: svgOverlay, top: 0, left: 0 }])
        .resize(640, 480, { fit: 'inside' })
        .jpeg({ quality: 75 })
        .toBuffer();

      fs.writeFileSync(filepath, composited);
      return path.relative(path.join(__dirname, '..'), filepath);
    } catch (err) {
      logger.error(`Detection snapshot save error: ${err.message}`, 'human-detector');
      return null;
    }
  }

  enable() {
    this.enabled = true;
    logger.info('Human detection enabled', 'human-detector');
  }

  disable() {
    this.enabled = false;
    logger.info('Human detection disabled', 'human-detector');
  }

  setConfidenceThreshold(level) {
    this.confidenceThreshold = Math.max(0.1, Math.min(0.99, level));
    logger.info(`Human detection confidence threshold set to ${this.confidenceThreshold}`, 'human-detector');
  }

  getStats() {
    return {
      enabled: this.enabled,
      modelLoaded: this.modelLoaded,
      confidenceThreshold: this.confidenceThreshold,
      intervalMs: this.intervalMs,
      totalDetections: this.totalDetections
    };
  }

  shutdown() {
    this.processing.clear();
    this.lastDetection.clear();
    this.removeAllListeners();
    if (this.model) {
      this.model.dispose && this.model.dispose();
      this.model = null;
    }
    logger.info('Human detector shut down', 'human-detector');
  }
}

module.exports = new HumanDetector();
