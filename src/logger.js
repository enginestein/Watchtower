const db = require('./database');
const fs = require('fs');
const path = require('path');

const LOG_LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const LOG_NAMES = ['DEBUG', 'INFO', 'WARN', 'ERROR'];

let logFileStream;
let minLevel = 'DEBUG';

function ensureLogFile() {
  const logDir = path.join(__dirname, '..', 'logs');
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
  const logPath = path.join(logDir, `watchtower-${new Date().toISOString().split('T')[0]}.log`);
  logFileStream = fs.createWriteStream(logPath, { flags: 'a' });
}

function formatTimestamp() {
  return new Date().toISOString();
}

function writeToFile(level, message, source) {
  if (!logFileStream) ensureLogFile();
  const line = `[${formatTimestamp()}] [${level}] [${source || 'system'}] ${message}\n`;
  try { logFileStream.write(line); } catch (e) { /* silent */ }
}

function log(level, message, source) {
  if (LOG_LEVELS[level] < LOG_LEVELS[minLevel]) return;

  const entry = { level, message, source: source || 'system' };

  try {
    db.addLog(entry);
  } catch (e) {
    // DB might not be ready yet
  }

  writeToFile(level, message, source);

  const prefix = `[${level.padEnd(5)}]`;
  const colorMap = { ERROR: '\x1b[31m', WARN: '\x1b[33m', INFO: '\x1b[36m', DEBUG: '\x1b[90m' };
  const color = colorMap[level] || '\x1b[0m';
  const ts = new Date().toLocaleTimeString();

  console.log(`${color}${ts} ${prefix} [${source || 'system'}] ${message}\x1b[0m`);
}

const logger = {
  debug: (msg, src) => log('DEBUG', msg, src),
  info: (msg, src) => log('INFO', msg, src),
  warn: (msg, src) => log('WARN', msg, src),
  error: (msg, src) => log('ERROR', msg, src),

  setLevel(level) {
    if (LOG_LEVELS[level] !== undefined) minLevel = level;
  },

  getLevels() { return LOG_NAMES; },

  // Rotate log file daily
  rotateLogFile() {
    if (logFileStream) {
      try { logFileStream.end(); } catch (e) { /* ignore */ }
    }
    logFileStream = null;
    ensureLogFile();
  }
};

// Auto-rotate daily
setInterval(() => {
  const hour = new Date().getHours();
  const minute = new Date().getMinutes();
  if (hour === 0 && minute === 0) {
    logger.rotateLogFile();
  }
}, 60000);

module.exports = logger;
