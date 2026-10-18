'use strict';

const { LOG_LEVELS } = require('./config');

/**
 * Tiny leveled logger. Keeps the bridge dependency-free and makes the
 * output readable in a Windows PowerShell window.
 */
class Logger {
  /**
   * @param {object} [options]
   * @param {string} [options.level]
   * @param {string} [options.prefix]
   * @param {(line: string) => void} [options.write]
   */
  constructor({ level = 'info', prefix = 'roblox-bridge', write } = {}) {
    this.level = level in LOG_LEVELS ? level : 'info';
    this.prefix = prefix;
    this.write = write || ((line) => process.stdout.write(`${line}\n`));
  }

  /**
   * @param {string} level
   * @param {string} message
   * @param {object} [fields]
   */
  log(level, message, fields) {
    if (LOG_LEVELS[level] > LOG_LEVELS[this.level]) return;
    const stamp = new Date().toISOString();
    let line = `${stamp} ${level.toUpperCase().padEnd(5)} [${this.prefix}] ${message}`;
    if (fields && Object.keys(fields).length > 0) {
      line += ` ${JSON.stringify(fields)}`;
    }
    this.write(line);
  }

  error(message, fields) {
    this.log('error', message, fields);
  }

  warn(message, fields) {
    this.log('warn', message, fields);
  }

  info(message, fields) {
    this.log('info', message, fields);
  }

  debug(message, fields) {
    this.log('debug', message, fields);
  }
}

module.exports = { Logger };
