/**
 * Agent Bridge — communicates with the adb-auto-enable Android agent.
 *
 * The agent runs an embedded NanoHTTPD web server on the Android device
 * (default port 9093) exposing these endpoints (verified against the
 * original Java source, WebServer.java):
 *
 *   GET  /api/status    → { lastStatus, currentPort, isPaired, adb5555Available, targetPort, webServerEnabled }
 *   POST /api/pair      → form: port, code  → { success, message } | { error }
 *   GET  /api/switch    → { success, message }  (async port switch)
 *   POST /api/port      → form: port        → { success, message } | { error }
 *   GET  /api/logs      → { logs } | { error }
 *   POST /api/reset     → { success, message } | { error }
 *   POST /api/webserver → form: enabled     → { success, message } | { error }
 *
 * SECURITY: The agent's HTTP API is unauthenticated by design (original
 * implementation). This bridge only permits requests to private/local
 * network IP ranges and never exposes itself as an open proxy.
 */
const http = require('http');

/** Private/local IPv4 ranges — the agent must never be reached via public IPs. */
const PRIVATE_IP_PATTERNS = [
  /^10\./,                              // 10.0.0.0/8
  /^172\.(1[6-9]|2\d|3[01])\./,          // 172.16.0.0/12
  /^192\.168\./,                         // 192.168.0.0/16
  /^127\./,                              // loopback
  /^169\.254\./,                         // link-local
];

function isPrivateIp(ip) {
  if (!ip || typeof ip !== 'string') return false;
  return PRIVATE_IP_PATTERNS.some((p) => p.test(ip.trim()));
}

class AgentBridge {
  constructor(options = {}) {
    this.port = options.port || 9093;
    this.timeoutMs = options.timeoutMs || 3000;
    this.cacheTtlMs = options.cacheTtlMs || 5000;
    this._cache = new Map(); // ip → { ts, data }
  }

  /**
   * Core request method. Never throws — always resolves with a result object.
   * Returns { ok, status, json, raw, error }.
   */
  _request(ip, path, { method = 'GET', body = null } = {}) {
    return new Promise((resolve) => {
      if (!isPrivateIp(ip)) {
        return resolve({ ok: false, status: null, json: null, raw: '', error: 'IP is not in a private/local network range' });
      }

      const url = new URL(`http://${ip.trim()}:${this.port}${path}`);
      const headers = {};
      if (body) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        headers['Content-Length'] = Buffer.byteLength(body);
      }

      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname + url.search,
          method,
          timeout: this.timeoutMs,
          headers,
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => {
            data += chunk;
            // Guard against runaway responses (max 1 MB)
            if (data.length > 1024 * 1024) {
              req.destroy();
              resolve({ ok: false, status: res.statusCode, json: null, raw: data, error: 'Response too large' });
            }
          });
          res.on('end', () => {
            let json = null;
            try {
              json = JSON.parse(data);
            } catch {
              /* invalid JSON — leave json as null */
            }
            resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json, raw: data, error: null });
          });
        }
      );

      req.on('timeout', () => {
        req.destroy();
        resolve({ ok: false, status: null, json: null, raw: '', error: `Request timed out after ${this.timeoutMs}ms` });
      });
      req.on('error', (e) => {
        resolve({ ok: false, status: null, json: null, raw: '', error: e.message });
      });

      if (body) req.write(body);
      req.end();
    });
  }

  /**
   * GET /api/status — read agent status.
   * Returns { reachable, isPaired, currentPort, targetPort, adb5555Available, webServerEnabled, lastStatus, error, cached }.
   * Never labels an unreachable agent as paired or healthy.
   */
  async getStatus(ip) {
    const cached = this._cache.get(ip);
    if (cached && Date.now() - cached.ts < this.cacheTtlMs) {
      return { ...cached.data, cached: true };
    }

    const res = await this._request(ip, '/api/status');
    if (!res.ok) {
      return {
        reachable: false,
        isPaired: false,
        currentPort: null,
        targetPort: null,
        adb5555Available: false,
        webServerEnabled: false,
        lastStatus: '',
        error: res.error || `Agent returned status ${res.status}`,
        status: res.status,
        cached: false,
      };
    }

    const data = {
      reachable: true,
      isPaired: !!(res.json && res.json.isPaired),
      currentPort: res.json && typeof res.json.currentPort === 'number' ? res.json.currentPort : null,
      targetPort: res.json && typeof res.json.targetPort === 'number' ? res.json.targetPort : null,
      lastPort: res.json && typeof res.json.lastPort === 'number' ? res.json.lastPort : null,
      adb5555Available: !!(res.json && res.json.adb5555Available),
      webServerEnabled: !!(res.json && res.json.webServerEnabled),
      lastStatus: res.json && typeof res.json.lastStatus === 'string' ? res.json.lastStatus : '',
      error: null,
      status: res.status,
      cached: false,
    };

    this._cache.set(ip, { ts: Date.now(), data });
    return data;
  }

  /**
   * POST /api/pair — request device-local pairing.
   * Body params: port (pairing port), code (pairing code).
   */
  async pair(ip, port, code) {
    const body = `port=${encodeURIComponent(String(port))}&code=${encodeURIComponent(String(code))}`;
    const res = await this._request(ip, '/api/pair', { method: 'POST', body });
    if (!res.ok) {
      return { success: false, error: res.error || (res.json && res.json.error) || 'Pairing request failed', status: res.status };
    }
    return { success: true, message: (res.json && res.json.message) || 'Pairing successful' };
  }

  /**
   * GET /api/switch — request port switch to the configured target port.
   */
  async switchPort(ip) {
    const res = await this._request(ip, '/api/switch');
    if (!res.ok) {
      return { success: false, error: res.error || 'Switch request failed', status: res.status };
    }
    return { success: true, message: (res.json && res.json.message) || 'Port switch started' };
  }

  /**
   * POST /api/port — update the target port on the agent.
   */
  async setPort(ip, port) {
    const body = `port=${encodeURIComponent(String(port))}`;
    const res = await this._request(ip, '/api/port', { method: 'POST', body });
    if (!res.ok) {
      return { success: false, error: res.error || (res.json && res.json.error) || 'Set port failed', status: res.status };
    }
    return { success: true, message: (res.json && res.json.message) || 'Target port updated' };
  }

  /**
   * GET /api/logs — retrieve agent logs.
   */
  async getLogs(ip) {
    const res = await this._request(ip, '/api/logs');
    if (!res.ok) {
      return { success: false, error: res.error || 'Failed to retrieve logs', status: res.status };
    }
    return { success: true, logs: (res.json && res.json.logs) || '' };
  }

  /**
   * POST /api/reset — reset pairing credentials on the agent.
   * Destructive — only called on explicit user action.
   */
  async resetPairing(ip) {
    const res = await this._request(ip, '/api/reset', { method: 'POST' });
    if (!res.ok) {
      return { success: false, error: res.error || 'Reset failed', status: res.status };
    }
    return { success: true, message: (res.json && res.json.message) || 'Pairing reset successful' };
  }

  /**
   * POST /api/webserver — enable/disable the agent's web server.
   */
  async toggleWebServer(ip, enabled) {
    const body = `enabled=${enabled ? 'true' : 'false'}`;
    const res = await this._request(ip, '/api/webserver', { method: 'POST', body });
    if (!res.ok) {
      return { success: false, error: res.error || 'Toggle failed', status: res.status };
    }
    return { success: true, message: (res.json && res.json.message) || 'Web server setting updated' };
  }

  /** Clear status cache for one IP or all IPs. */
  clearCache(ip) {
    if (ip) this._cache.delete(ip);
    else this._cache.clear();
  }
}

module.exports = { AgentBridge, isPrivateIp };
