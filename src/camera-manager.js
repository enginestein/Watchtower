const http = require('http');
const https = require('https');
const { EventEmitter } = require('events');
const logger = require('./logger');
const config = require('../config.json');

class CameraManager extends EventEmitter {
  constructor() {
    super();
    this.cameras = new Map();
    this.frameBuffers = new Map();
    this.currentFrames = new Map();
    this.streamTimers = new Map();
    this.activeStreams = new Set();
  }

  async init() {
    const camConfigs = config.cameras || [];
    for (const cfg of camConfigs) {
      if (cfg.enabled !== false) {
        this.registerCamera(cfg);
      }
    }
    logger.info(`Initialized camera manager with ${camConfigs.length} cameras`, 'camera-manager');
    return this.cameras.size;
  }

  registerCamera(cfg) {
    const cam = {
      id: cfg.id,
      name: cfg.name,
      stream_url: cfg.stream_url,
      snapshot_url: cfg.snapshot_url || cfg.stream_url,
      config_url: cfg.config_url || cfg.stream_url.replace(/\/stream$|\/[^/]*$/, ''),
      location: cfg.location || '',
      enabled: cfg.enabled !== false,
      fps: cfg.fps || 5,
      settings: Object.assign({
        resolution: 'vga',
        quality: 12,
        hmirror: false,
        vflip: false,
        flash_enabled: false,
        brightness: 0,
        contrast: 0
      }, cfg.settings || {}),
      status: 'disconnected',
      lastSeen: null,
      frameCount: 0,
      connected: false
    };
    this.cameras.set(cam.id, cam);
    this.frameBuffers.set(cam.id, []);
    logger.info(`Camera registered: ${cam.name} (ID: ${cam.id})`, 'camera-manager');
    return cam;
  }

  async startStream(cameraId) {
    const cam = this.cameras.get(cameraId);
    if (!cam) {
      logger.error(`Camera ${cameraId} not found`, 'camera-manager');
      return false;
    }

    if (this.activeStreams.has(cameraId)) {
      logger.debug(`Stream already active for camera ${cameraId}`, 'camera-manager');
      return true;
    }

    logger.info(`Starting stream for camera: ${cam.name}`, 'camera-manager');

    const baseInterval = 1000 / cam.fps;
    let running = true;
    let errorBackoff = 1;
    this.activeStreams.add(cameraId);

    const pollFrame = async () => {
      if (!running) return;
      try {
        const frame = await this.fetchFrame(cam);
        if (frame) {
          errorBackoff = 1;
          this.currentFrames.set(cameraId, frame);
          cam.frameCount++;
          cam.lastSeen = new Date();
          cam.status = 'connected';
          cam.connected = true;
          this.emit('frame', { cameraId, frame, camera: cam });

          const buffer = this.frameBuffers.get(cameraId) || [];
          buffer.push({ data: frame, timestamp: Date.now() });
          if (buffer.length > 50) buffer.shift();
          this.frameBuffers.set(cameraId, buffer);
        }
      } catch (err) {
        cam.status = 'error';
        cam.connected = false;
        if (errorBackoff === 1) {
          logger.error(`Stream error for ${cam.name}: ${err.message}`, 'camera-manager');
          this.emit('error', { cameraId, error: err.message, camera: cam });
        }
        errorBackoff = Math.min(errorBackoff * 2, 60);
      }

      if (running) {
        const interval = baseInterval * errorBackoff;
        this.streamTimers.set(cameraId, setTimeout(pollFrame, interval));
      }
    };

    pollFrame();
    return true;
  }

  stopStream(cameraId) {
    const cam = this.cameras.get(cameraId);
    if (cam) {
      logger.info(`Stopping stream for camera: ${cam.name}`, 'camera-manager');
    }
    this.activeStreams.delete(cameraId);
    const timer = this.streamTimers.get(cameraId);
    if (timer) {
      clearTimeout(timer);
      this.streamTimers.delete(cameraId);
    }
    if (cam) {
      cam.status = 'disconnected';
      cam.connected = false;
    }
  }

  stopAllStreams() {
    for (const id of this.activeStreams) {
      this.stopStream(id);
    }
    logger.info('All camera streams stopped', 'camera-manager');
  }

  getCurrentFrame(cameraId) {
    return this.currentFrames.get(cameraId) || null;
  }

  getFrameBuffer(cameraId) {
    return this.frameBuffers.get(cameraId) || [];
  }

  getCamera(cameraId) {
    return this.cameras.get(cameraId);
  }

  getAllCameras() {
    return Array.from(this.cameras.values());
  }

  getConnectedCameras() {
    return this.getAllCameras().filter(c => c.connected);
  }

  getCameraStatus(cameraId) {
    const cam = this.cameras.get(cameraId);
    if (!cam) return null;
    return {
      id: cam.id,
      name: cam.name,
      status: cam.status,
      connected: cam.connected,
      lastSeen: cam.lastSeen,
      frameCount: cam.frameCount,
      fps: cam.fps
    };
  }

  async fetchFrame(cam) {
    const url = cam.snapshot_url || cam.stream_url;
    return new Promise((resolve, reject) => {
      const client = url.startsWith('https') ? https : http;

      const req = client.get(url, { timeout: 5000 }, (res) => {
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode}`));
        }

        const contentType = res.headers['content-type'] || '';
        const chunks = [];

        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          if (buffer.length < 100) {
            return reject(new Error('Frame too small'));
          }
          resolve(buffer);
        });
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      req.on('error', reject);
    });
  }

  async takeSnapshot(cameraId) {
    const cam = this.cameras.get(cameraId);
    if (!cam) return null;
    try {
      return await this.fetchFrame(cam);
    } catch (err) {
      logger.error(`Snapshot failed for ${cam.name}: ${err.message}`, 'camera-manager');
      return null;
    }
  }

  async sendCommand(cam, endpoint) {
    const url = `${cam.config_url}/${endpoint}`;
    return new Promise((resolve) => {
      const client = url.startsWith('https') ? https : http;
      const req = client.get(url, { timeout: 5000 }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => resolve({ success: res.statusCode === 200, data, status: res.statusCode }));
      });
      req.on('timeout', () => { req.destroy(); resolve({ success: false, error: 'timeout' }); });
      req.on('error', (err) => resolve({ success: false, error: err.message }));
    });
  }

  async applySettings(cameraId, settings) {
    const cam = this.cameras.get(cameraId);
    if (!cam) return { success: false, error: 'Camera not found' };

    const results = [];
    const wasConnected = cam.connected;

    if (settings.quality !== undefined && settings.quality !== cam.settings.quality) {
      const r = await this.sendCommand(cam, `quality?q=${Math.max(4, Math.min(63, settings.quality))}`);
      results.push({ setting: 'quality', ...r });
    }

    if (settings.resolution !== undefined && settings.resolution !== cam.settings.resolution) {
      const r = await this.sendCommand(cam, `resolution?res=${settings.resolution}`);
      results.push({ setting: 'resolution', ...r });
    }

    if (settings.hmirror !== undefined && settings.hmirror !== cam.settings.hmirror) {
      const r = await this.sendCommand(cam, `mirror?h=${settings.hmirror ? 1 : 0}`);
      results.push({ setting: 'hmirror', ...r });
    }

    if (settings.vflip !== undefined && settings.vflip !== cam.settings.vflip) {
      const r = await this.sendCommand(cam, `flip?v=${settings.vflip ? 1 : 0}`);
      results.push({ setting: 'vflip', ...r });
    }

    if (settings.flash_enabled !== undefined && settings.flash_enabled !== cam.settings.flash_enabled) {
      const r = await this.sendCommand(cam, `flash?en=${settings.flash_enabled ? 1 : 0}`);
      results.push({ setting: 'flash_enabled', ...r });
    }

    if (settings.brightness !== undefined && settings.brightness !== cam.settings.brightness) {
      const r = await this.sendCommand(cam, `brightness?val=${Math.max(-2, Math.min(2, settings.brightness))}`);
      results.push({ setting: 'brightness', ...r });
    }

    if (settings.contrast !== undefined && settings.contrast !== cam.settings.contrast) {
      const r = await this.sendCommand(cam, `contrast?val=${Math.max(-2, Math.min(2, settings.contrast))}`);
      results.push({ setting: 'contrast', ...r });
    }

    Object.assign(cam.settings, settings);
    logger.info(`Settings applied to ${cam.name}: ${JSON.stringify(settings)}`, 'camera-manager');

    return { success: results.every(r => r.success !== false), results };
  }

  async fetchSettings(cameraId) {
    const cam = this.cameras.get(cameraId);
    if (!cam) return null;
    const result = await this.sendCommand(cam, 'status');
    if (result.success && result.data) {
      try { return JSON.parse(result.data); } catch (e) { return cam.settings; }
    }
    return cam.settings;
  }

  async testConnection(cameraId) {
    const cam = this.cameras.get(cameraId);
    if (!cam) return { success: false, error: 'Camera not found' };
    try {
      const frame = await this.fetchFrame(cam);
      return { success: !!frame, frameSize: frame ? frame.length : 0 };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  updateCameraConfig(cameraId, updates) {
    const cam = this.cameras.get(cameraId);
    if (!cam) return false;
    if (updates.name !== undefined) cam.name = updates.name;
    if (updates.stream_url !== undefined) cam.stream_url = updates.stream_url;
    if (updates.snapshot_url !== undefined) cam.snapshot_url = updates.snapshot_url;
    if (updates.location !== undefined) cam.location = updates.location;
    if (updates.enabled !== undefined) cam.enabled = updates.enabled;
    if (updates.fps !== undefined) cam.fps = updates.fps;
    logger.info(`Camera ${cameraId} config updated`, 'camera-manager');
    return true;
  }

  getStats() {
    return {
      total: this.cameras.size,
      connected: this.getConnectedCameras().length,
      disconnected: this.cameras.size - this.getConnectedCameras().length,
      totalFrames: Array.from(this.cameras.values()).reduce((s, c) => s + c.frameCount, 0),
      activeStreams: this.activeStreams.size
    };
  }

  shutdown() {
    this.stopAllStreams();
    this.removeAllListeners();
    logger.info('Camera manager shut down', 'camera-manager');
  }
}

module.exports = new CameraManager();
