const { EventEmitter } = require('events');
const db = require('./database');
const logger = require('./logger');
const config = require('../config.json');

class AlertManager extends EventEmitter {
  constructor() {
    super();
    this.enabled = config.alerts?.enabled !== false;
    this.motionAlerts = config.alerts?.motion_alert !== false;
    this.humanAlerts = config.alerts?.human_alert !== false;
    this.alertQueue = [];
    this.recentAlerts = new Map();
    this.deduplicateMs = 10000;
  }

  async init() {
    logger.info('Alert manager initialized', 'alert-manager');
  }

  async fireAlert(cameraId, type, message, snapshot = null) {
    if (!this.enabled) return null;
    if (type === 'motion' && !this.motionAlerts) return null;
    if (type === 'human' && !this.humanAlerts) return null;

    const dedupKey = `${cameraId}_${type}`;
    const lastAlert = this.recentAlerts.get(dedupKey) || 0;
    if (Date.now() - lastAlert < this.deduplicateMs) {
      return null;
    }
    this.recentAlerts.set(dedupKey, Date.now());

    const alert = {
      camera_id: cameraId,
      type,
      message,
      snapshot
    };

    try {
      const result = db.addAlert(alert);
      alert.id = result.lastInsertRowid;
    } catch (err) {
      logger.error(`Failed to save alert: ${err.message}`, 'alert-manager');
      return null;
    }

    logger.info(`Alert: [${type.toUpperCase()}] Camera ${cameraId}: ${message}`, 'alert-manager');

    this.alertQueue.push(alert);
    if (this.alertQueue.length > 100) this.alertQueue.shift();

    this.emit('alert', {
      id: alert.id,
      cameraId,
      type,
      message,
      snapshot,
      timestamp: new Date().toISOString(),
      sound: config.alerts?.sound_enabled !== false,
      notification: config.alerts?.browser_notifications !== false
    });

    return alert;
  }

  async sendTestAlert(cameraId) {
    return this.fireAlert(cameraId, 'info', 'This is a test alert', null);
  }

  acknowledgeAlert(alertId) {
    try {
      db.acknowledgeAlert(alertId);
      this.emit('alert_acknowledged', { alertId });
      logger.info(`Alert ${alertId} acknowledged`, 'alert-manager');
      return true;
    } catch (err) {
      logger.error(`Failed to acknowledge alert: ${err.message}`, 'alert-manager');
      return false;
    }
  }

  acknowledgeAll() {
    try {
      db.acknowledgeAllAlerts();
      this.emit('all_alerts_acknowledged');
      logger.info('All alerts acknowledged', 'alert-manager');
      return true;
    } catch (err) {
      logger.error(`Failed to acknowledge all alerts: ${err.message}`, 'alert-manager');
      return false;
    }
  }

  getRecentAlerts(count = 20) {
    return this.alertQueue.slice(-count);
  }

  getUnacknowledgedCount() {
    try {
      const result = db.getUnacknowledgedAlertCount();
      return result?.count || 0;
    } catch (err) {
      return 0;
    }
  }

  enable() {
    this.enabled = true;
    logger.info('Alerts enabled', 'alert-manager');
  }

  disable() {
    this.enabled = false;
    logger.info('Alerts disabled', 'alert-manager');
  }

  getStats() {
    return {
      enabled: this.enabled,
      motionAlerts: this.motionAlerts,
      humanAlerts: this.humanAlerts,
      queueSize: this.alertQueue.length,
      unacknowledged: this.getUnacknowledgedCount()
    };
  }

  shutdown() {
    this.recentAlerts.clear();
    this.alertQueue = [];
    this.removeAllListeners();
    logger.info('Alert manager shut down', 'alert-manager');
  }
}

module.exports = new AlertManager();
