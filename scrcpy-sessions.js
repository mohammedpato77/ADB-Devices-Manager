'use strict';

/** Own one scrcpy child process per connected ADB serial. */
class ScrcpySessions {
  constructor(onChange = () => {}) {
    this.sessions = new Map();
    this.onChange = onChange;
  }

  has(serial) {
    return this.sessions.has(serial);
  }

  add(serial, proc, displayId = null) {
    if (this.sessions.has(serial)) throw new Error(`scrcpy is already running for ${serial}`);
    const session = { proc, displayId, startTime: Date.now(), sessionId: serial };
    this.sessions.set(serial, session);
    const removeIfCurrent = () => {
      // An old child can exit after a reconnect/restart. It must not erase the
      // replacement session registered under the same ADB serial.
      if (this.sessions.get(serial) === session) {
        this.sessions.delete(serial);
        this.onChange();
      }
    };
    proc.once('error', removeIfCurrent);
    proc.once('exit', removeIfCurrent);
    this.onChange();
    return session;
  }

  stop(serial) {
    const session = this.sessions.get(serial);
    if (!session) return false;
    // Remove synchronously so a subsequent start can proceed without waiting
    // for the child process exit event. Its listener is identity-guarded above.
    this.sessions.delete(serial);
    try {
      session.proc.kill();
    } finally {
      this.onChange();
    }
    return true;
  }

  stopDisconnected(connectedSerials) {
    const connected = new Set(connectedSerials);
    for (const serial of this.sessions.keys()) {
      if (!connected.has(serial)) this.stop(serial);
    }
  }

  snapshot() {
    return [...this.sessions].map(([serial, session]) => ({
      serial,
      sessionId: session.sessionId,
      displayId: session.displayId,
      startTime: session.startTime,
    }));
  }
}

module.exports = { ScrcpySessions };
