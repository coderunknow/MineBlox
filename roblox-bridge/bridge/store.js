'use strict';

const crypto = require('node:crypto');

/**
 * In-memory store for Studio sessions and the commands queued for them.
 *
 * Everything is kept in memory on purpose: the bridge is a short-lived local
 * process, and writing secrets or command payloads to disk would be a
 * needless risk.
 */
class SessionStore {
  /**
   * @param {object} [options]
   * @param {number} [options.sessionTtlMs]
   * @param {number} [options.commandTimeoutMs]
   * @param {number} [options.maxSessions]
   * @param {() => number} [options.now]
   */
  constructor({ sessionTtlMs = 120_000, commandTimeoutMs = 60_000, maxSessions = 32, now = Date.now } = {}) {
    this.sessionTtlMs = sessionTtlMs;
    this.commandTimeoutMs = commandTimeoutMs;
    this.maxSessions = maxSessions;
    this.now = now;
    /** @type {Map<string, object>} */
    this.sessions = new Map();
    /** @type {Map<string, object>} */
    this.commands = new Map();
  }

  /**
   * @param {object} meta
   * @returns {object}
   */
  register(meta) {
    this.sweep();

    if (this.sessions.size >= this.maxSessions) {
      // Drop the least recently seen session to make room.
      let oldestId = null;
      let oldestSeen = Infinity;
      for (const [id, session] of this.sessions) {
        if (session.lastSeenAt < oldestSeen) {
          oldestSeen = session.lastSeenAt;
          oldestId = id;
        }
      }
      if (oldestId) this.remove(oldestId);
    }

    const timestamp = this.now();
    const id = crypto.randomUUID();
    const session = {
      id,
      name: meta.name || 'studio-session',
      placeId: meta.placeId ?? null,
      placeName: meta.placeName ?? null,
      studioVersion: meta.studioVersion ?? null,
      userAgent: meta.userAgent ?? null,
      createdAt: timestamp,
      lastSeenAt: timestamp,
      status: 'connected',
      commandCount: 0,
    };
    this.sessions.set(id, session);
    return session;
  }

  /**
   * @param {string} id
   * @returns {object|undefined}
   */
  get(id) {
    return this.sessions.get(id);
  }

  /**
   * @param {string} id
   * @returns {object|null}
   */
  touch(id) {
    const session = this.sessions.get(id);
    if (!session) return null;
    session.lastSeenAt = this.now();
    return session;
  }

  /**
   * @param {string} id
   * @returns {boolean}
   */
  remove(id) {
    const existed = this.sessions.delete(id);
    for (const [commandId, command] of this.commands) {
      if (command.sessionId === id) this.commands.delete(commandId);
    }
    return existed;
  }

  /**
   * @returns {object[]}
   */
  list() {
    this.sweep();
    return [...this.sessions.values()].map((session) => ({
      id: session.id,
      name: session.name,
      placeId: session.placeId,
      placeName: session.placeName,
      studioVersion: session.studioVersion,
      createdAt: session.createdAt,
      lastSeenAt: session.lastSeenAt,
      status: session.status,
      commandCount: session.commandCount,
    }));
  }

  /**
   * Queue a command for a session.
   *
   * @param {string} sessionId
   * @param {{type: string, code: string, timeoutMs?: number}} command
   * @returns {object}
   */
  enqueue(sessionId, command) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      const error = new Error(`Unknown session "${sessionId}"`);
      error.code = 'unknown-session';
      throw error;
    }

    const timestamp = this.now();
    const id = crypto.randomUUID();
    const timeoutMs = command.timeoutMs ?? this.commandTimeoutMs;
    const record = {
      id,
      sessionId,
      type: command.type || 'exec',
      code: command.code ?? '',
      status: 'pending',
      createdAt: timestamp,
      dispatchedAt: null,
      completedAt: null,
      timeoutAt: timestamp + timeoutMs,
      result: null,
    };
    this.commands.set(id, record);
    session.commandCount += 1;
    return record;
  }

  /**
   * Return and claim every pending command for a session.
   *
   * @param {string} sessionId
   * @returns {object[]}
   */
  takePending(sessionId) {
    this.sweep();
    const session = this.sessions.get(sessionId);
    if (!session) return [];

    const pending = [];
    for (const command of this.commands.values()) {
      if (command.sessionId === sessionId && command.status === 'pending') {
        command.status = 'dispatched';
        command.dispatchedAt = this.now();
        pending.push(command);
      }
    }
    return pending;
  }

  /**
   * @param {string} commandId
   * @returns {object|undefined}
   */
  getCommand(commandId) {
    return this.commands.get(commandId);
  }

  /**
   * @param {string} commandId
   * @param {object} result
   * @returns {object|null}
   */
  completeCommand(commandId, result) {
    const command = this.commands.get(commandId);
    if (!command) return null;
    if (command.status === 'completed' || command.status === 'failed' || command.status === 'timeout') {
      return command;
    }
    command.status = result && result.ok ? 'completed' : 'failed';
    command.completedAt = this.now();
    command.result = result || null;
    return command;
  }

  /**
   * Drop stale sessions and expire commands that were never answered.
   *
   * @returns {{sessionsRemoved: number, commandsTimedOut: number}}
   */
  sweep() {
    const timestamp = this.now();
    let sessionsRemoved = 0;
    let commandsTimedOut = 0;

    for (const [id, session] of this.sessions) {
      if (timestamp - session.lastSeenAt > this.sessionTtlMs) {
        this.sessions.delete(id);
        sessionsRemoved += 1;
        for (const [commandId, command] of this.commands) {
          if (command.sessionId === id) this.commands.delete(commandId);
        }
      }
    }

    for (const [commandId, command] of this.commands) {
      if (
        (command.status === 'pending' || command.status === 'dispatched') &&
        timestamp > command.timeoutAt
      ) {
        command.status = 'timeout';
        command.completedAt = timestamp;
        command.result = {
          ok: false,
          error: `Command timed out after ${Math.round((command.timeoutAt - command.createdAt) / 1000)}s`,
        };
        commandsTimedOut += 1;
      }
    }

    return { sessionsRemoved, commandsTimedOut };
  }
}

module.exports = { SessionStore };
