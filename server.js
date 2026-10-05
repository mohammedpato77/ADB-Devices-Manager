/**
 * ADB Device Setup — local backend
 * --------------------------
 * Serves the web UI and executes ADB commands on localhost only.
 *
 * Architecture:
 *   Browser UI  →  Express API (this server)  →  adb.exe  →  Android device
 *
 * Live logs are pushed to the browser over Server-Sent Events (SSE).
 * The server never exposes arbitrary shell commands — only specific,
 * validated API operations.
 *
 * Multi-device architecture:
 *   - devices[] collection (not single device)
 *   - Every ADB command targets a device explicitly with -s <serial>
 *   - Concurrent execution on multiple devices
 *   - Per-device failure isolation
 *   - Device metadata (model, manufacturer, Android version)
 */
const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const dgram = require('dgram');
const os = require('os');
const { AgentBridge } = require('./agent-bridge');
const { ScrcpySessions } = require('./scrcpy-sessions');

const PORT = process.env.PORT || 3000;
const HOST = '127.0.0.1'; // LOCAL ONLY — never expose to LAN/Internet
const CONFIG_FILE = path.join(__dirname, 'config.json');
const DEFAULT_APK_DIR = 'D:\\Apps';

const APPOPS = [
  { op: 'PROJECT_MEDIA', pkg: 'com.teamviewer.host.market' },
  { op: 'ACCESS_RESTRICTED_SETTINGS', pkg: 'com.teamviewer.quicksupport.addon.universal' },
];

/* ---------------- Config ---------------- */

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return {
      adbPath: typeof raw.adbPath === 'string' && raw.adbPath.trim() ? raw.adbPath.trim() : 'auto',
      apkDir: typeof raw.apkDir === 'string' && raw.apkDir.trim() ? raw.apkDir.trim() : DEFAULT_APK_DIR,
    };
  } catch {
    return { adbPath: 'auto', apkDir: DEFAULT_APK_DIR };
  }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}

let config = loadConfig();

/* ---------------- Android Agent bridge ---------------- */

const agentBridge = new AgentBridge({ port: 9093, timeoutMs: 3000, cacheTtlMs: 5000 });
const scrcpySessions = new ScrcpySessions(() => broadcastState());

/* ---------------- State ---------------- */

const state = {
  devices: [],        // [{ serial, state, model, manufacturer, androidVersion, transportType, selected }]
  discoveredDevices: [], // [{ id, name, ip, port, pairPort, serviceType, instanceName, source, status }]
  apks: [],    // { name, path, size, status: 'pending'|'installing'|'installed'|'failed', error }
  appops: APPOPS.map((a) => ({ ...a, status: 'pending', error: null })),
  push: { running: false, files: [] }, // { name, progress, status: 'pending'|'pushing'|'success'|'failed', error }
  setup: { running: false, result: null },
  networkScan: { running: false, status: '', found: 0 },
  selectedInterfaceId: null,
  networkInterfaces: [],
};

/* ---------------- SSE (live logs) ---------------- */

const sseClients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of [...sseClients]) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

function log(level, message) {
  const ts = new Date().toLocaleTimeString('en-GB', { hour12: false });
  broadcast('log', { ts, level, message });
}

function broadcastState() {
  broadcast('state', publicState());
}

/**
 * Full state snapshot sent to clients, including live scrcpy sessions
 * derived from the running process map.
 */
function publicState() {
  return {
    ...state,
    // Interfaces are computed live (never stored in state), so broadcasts
    // always carry a fresh list instead of the empty initial value.
    networkInterfaces: enumerateInterfaces(),
    scrcpyRunning: scrcpySessions.snapshot(),
  };
}

/* ---------------- ADB helpers ---------------- */

function adbExe() {
  return config.adbPath === 'auto' ? 'adb' : config.adbPath;
}

/**
 * Run an ADB command, capturing stdout/stderr.
 * Raw output is streamed to the live log (stderr as errors).
 * Never throws — always resolves with { code, stdout, stderr }.
 * A hung command is killed after `timeoutMs` (default 120s) so the
 * application can never be locked up by an unresponsive ADB call.
 */
function runAdb(args, opts = {}) {
  const { stream = true, timeoutMs = 120000 } = opts;
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(adbExe(), args, { windowsHide: true });
    } catch (e) {
      return resolve({ code: -1, stdout: '', stderr: String((e && e.message) || e) });
    }

    let stdout = '';
    let stderr = '';
    let outPending = '';
    let errPending = '';
    let settled = false;
    let timer = null;

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        log('error', `ADB command timed out after ${Math.round(timeoutMs / 1000)}s and was killed: ${args.join(' ')}`);
        try {
          proc.kill();
        } catch {
          /* already gone */
        }
      }, timeoutMs);
    }

    const finish = (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (outPending.trim()) log('adb', outPending.trim());
      if (errPending.trim()) log('error', errPending.trim());
      resolve({ code: code == null ? -1 : code, stdout, stderr });
    };

    const onChunk = (chunk, isErr) => {
      const text = chunk.toString();
      if (isErr) {
        stderr += text;
        errPending += text;
      } else {
        stdout += text;
        outPending += text;
      }
      if (!stream) return;
      const buf = isErr ? errPending : outPending;
      const nl = buf.indexOf('\n');
      if (nl >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        if (isErr) errPending = buf.slice(nl + 1);
        else outPending = buf.slice(nl + 1);
        if (line.trim()) log(isErr ? 'error' : 'adb', line);
      }
    };

    proc.stdout.on('data', (d) => onChunk(d, false));
    proc.stderr.on('data', (d) => onChunk(d, true));
    proc.on('error', (e) => {
      log('error', `Failed to start ADB: ${e.message}`);
      finish(-1);
    });
    proc.on('close', finish);
  });
}

/** Parse `adb devices` output into [{ serial, state }]. */
async function listDevices() {
  const res = await runAdb(['devices']);
  const devices = [];
  for (const line of res.stdout.split(/\r?\n/).slice(1)) {
    const m = /^(\S+)\s+(\S+.*)$/.exec(line.trim());
    if (m) devices.push({ serial: m[1], state: m[2].trim() });
  }
  return devices;
}

/** Fetch device metadata (model, manufacturer, Android version). Non-blocking. */
async function fetchDeviceMetadata(serial) {
  try {
    const [modelRes, mfrRes, verRes] = await Promise.all([
      runAdb(['-s', serial, 'shell', 'getprop', 'ro.product.model'], { stream: false, timeoutMs: 10000 }),
      runAdb(['-s', serial, 'shell', 'getprop', 'ro.product.manufacturer'], { stream: false, timeoutMs: 10000 }),
      runAdb(['-s', serial, 'shell', 'getprop', 'ro.build.version.release'], { stream: false, timeoutMs: 10000 }),
    ]);
    return {
      model: modelRes.code === 0 ? modelRes.stdout.trim() : '',
      manufacturer: mfrRes.code === 0 ? mfrRes.stdout.trim() : '',
      androidVersion: verRes.code === 0 ? verRes.stdout.trim() : '',
    };
  } catch {
    return { model: '', manufacturer: '', androidVersion: '' };
  }
}

/* ---------------- Network Discovery ---------------- */

const MDNS_ADDRESS = '224.0.0.251';
const MDNS_PORT = 5353;
const ADB_SERVICE_TYPES = ['_adb-tls-connect._tcp.local', '_adb-tls-pairing._tcp.local'];
const DEFAULT_ADB_PORT = 5555;

/**
 * Build an mDNS query packet for a service type.
 */
function buildMdnsQuery(serviceType) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0, 0); // ID
  header.writeUInt16BE(0, 2); // Flags
  header.writeUInt16BE(1, 4); // QDCOUNT
  header.writeUInt16BE(0, 6); // ANCOUNT
  header.writeUInt16BE(0, 8); // NSCOUNT
  header.writeUInt16BE(0, 10); // ARCOUNT

  const labels = serviceType.split('.');
  const qnameParts = [];
  for (const label of labels) {
    qnameParts.push(Buffer.from([Buffer.byteLength(label)]));
    qnameParts.push(Buffer.from(label));
  }
  qnameParts.push(Buffer.from([0]));
  const qname = Buffer.concat(qnameParts);

  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(12, 0); // QTYPE = PTR
  tail.writeUInt16BE(1, 2); // QCLASS = IN

  return Buffer.concat([header, qname, tail]);
}

/**
 * Parse a DNS name from a buffer.
 */
function parseDnsName(msg, offset) {
  const labels = [];
  let bytesRead = 0;
  let jumped = false;
  let jumpOffset = 0;

  while (offset < msg.length && offset < 255) {
    const len = msg[offset];
    if (len === 0) { bytesRead++; break; }
    if ((len & 0xc0) === 0xc0) {
      if (!jumped) { jumpOffset = offset + 2; jumped = true; }
      offset = ((len & 0x3f) << 8) | msg[offset + 1];
      bytesRead += 2;
      continue;
    }
    bytesRead++;
    labels.push(msg.slice(offset + 1, offset + 1 + len).toString());
    offset += len + 1;
    bytesRead++;
  }
  return { name: labels.join('.'), bytesRead };
}

/**
 * Parse an mDNS response packet.
 */
function parseMdnsResponse(msg) {
  const devices = [];
  if (msg.length < 12) return devices;
  const ancount = msg.readUInt16BE(6);
  let offset = 12;
  const qdcount = msg.readUInt16BE(4);
  for (let i = 0; i < qdcount; i++) {
    const { bytesRead } = parseDnsName(msg, offset);
    offset += bytesRead + 4;
  }
  for (let i = 0; i < ancount && offset < msg.length; i++) {
    try {
      const { name, bytesRead } = parseDnsName(msg, offset);
      offset += bytesRead;
      if (offset + 10 > msg.length) break;
      const type = msg.readUInt16BE(offset); offset += 2;
      offset += 2; // class
      offset += 4; // ttl
      const rdlength = msg.readUInt16BE(offset); offset += 2;
      if (offset + rdlength > msg.length) break;
      const rdata = msg.slice(offset, offset + rdlength);
      offset += rdlength;
      if (type === 12) { // PTR
        const { name: ptrName } = parseDnsName(rdata, 0);
        devices.push({ name, instanceName: ptrName, serviceType: '' });
      } else if (type === 33) { // SRV
        const port = rdata.readUInt16BE(4);
        const { name: target } = parseDnsName(rdata, 6);
        if (devices.length > 0) {
          devices[devices.length - 1].port = port;
          devices[devices.length - 1].target = target;
        }
      } else if (type === 1) { // A record
        const ip = `${rdata[0]}.${rdata[1]}.${rdata[2]}.${rdata[3]}`;
        if (devices.length > 0) devices[devices.length - 1].ip = ip;
      }
    } catch { break; }
  }
  return devices;
}

/**
 * Perform mDNS discovery for ADB service types, bound to a specific interface.
 * Returns a promise that resolves with an array of discovered services.
 */
function mdnsDiscovery(timeoutMs = 5000, interfaceIp = null) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const results = [];
    let timer = null;
    let queriesSent = false;
    let membershipAdded = false;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      try { socket.close(); } catch { /* ignore */ }
    };

    const finish = () => {
      cleanup();
      const msg = `[mDNS] Discovery finished. Collected ${results.length} service(s) total.`;
      log('info', msg);
      console.log(msg);
      resolve(results);
    };

    timer = setTimeout(() => {
      const msg = `[mDNS] Discovery timeout reached (${timeoutMs}ms).`;
      log('info', msg);
      console.log(msg);
      finish();
    }, timeoutMs);

    socket.on('message', (msg, rinfo) => {
      try {
        const services = parseMdnsResponse(msg);
        if (services.length > 0) {
          const msg = `[mDNS] Received ${services.length} service(s) from ${rinfo.address}`;
          log('info', msg);
          console.log(msg);
          for (const svc of services) {
            const svcMsg = `[mDNS]   → ${svc.name} | type=${svc.serviceType || 'unknown'} | ip=${svc.ip || 'unknown'} | port=${svc.port || 'unknown'}`;
            log('info', svcMsg);
            console.log(svcMsg);
          }
          results.push(...services);
        }
      } catch (e) {
        const msg = `[mDNS] Failed to parse response: ${e.message}`;
        log('error', msg);
        console.error(msg);
      }
    });

    socket.on('error', (err) => {
      const msg = `[mDNS] Socket error: ${err.message}`;
      log('error', msg);
      console.error(msg);
      finish();
    });

    socket.on('listening', () => {
      const msg = `[mDNS] Socket listening on port ${socket.address().port}`;
      log('info', msg);
      console.log(msg);
      // Add multicast membership after socket is listening
      try {
        if (interfaceIp) {
          socket.addMembership(MDNS_ADDRESS, interfaceIp);
          const msg = `[mDNS] Added multicast membership for ${MDNS_ADDRESS} on ${interfaceIp}`;
          log('info', msg);
          console.log(msg);
        } else {
          socket.addMembership(MDNS_ADDRESS);
          const msg = `[mDNS] Added multicast membership for ${MDNS_ADDRESS}`;
          log('info', msg);
          console.log(msg);
        }
        membershipAdded = true;
      } catch (e) {
        const msg = `[mDNS] Failed to add multicast membership: ${e.message}`;
        log('error', msg);
        console.error(msg);
      }
      // Send queries after membership is added
      sendQueries();
    });

    function sendQueries() {
      if (queriesSent) return;
      queriesSent = true;
      for (const st of ADB_SERVICE_TYPES) {
        try {
          const query = buildMdnsQuery(st);
          socket.send(query, MDNS_PORT, MDNS_ADDRESS, (err) => {
            if (err) {
              const msg = `[mDNS] Failed to send query for ${st}: ${err.message}`;
              log('error', msg);
              console.error(msg);
            } else {
              const msg = `[mDNS] Sent query for ${st}`;
              log('info', msg);
              console.log(msg);
            }
          });
        } catch (e) {
          const msg = `[mDNS] Failed to send query for ${st}: ${e.message}`;
          log('error', msg);
          console.error(msg);
        }
      }
    }

    // Bind to an ephemeral port on the specified interface
    // mDNS queries are sent TO 224.0.0.251:5353, responses come back to our source port
    // We cannot bind to 5353 because Windows mDNS responder already uses it
    try {
      if (interfaceIp) {
        const msg = `[mDNS] Binding to ${interfaceIp}:0 (ephemeral port)`;
        log('info', msg);
        console.log(msg);
        socket.bind(0, interfaceIp);
      } else {
        const msg = `[mDNS] Binding to 0.0.0.0:0 (ephemeral port)`;
        log('info', msg);
        console.log(msg);
        socket.bind(0);
      }
    } catch (e) {
      const msg = `[mDNS] Failed to bind socket: ${e.message}`;
      log('error', msg);
      console.error(msg);
      finish();
    }
  });
}

/**
 * Enumerate ALL active IPv4 network interfaces with metadata.
 * Returns array of interface objects with scoring info.
 */
function enumerateInterfaces() {
  const interfaces = os.networkInterfaces();
  const result = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      const ip = iface.address;
      const parts = ip.split('.');
      const prefix = `${parts[0]}.${parts[1]}.${parts[2]}`;
      const netmask = iface.netmask || '255.255.255.0';
      const cidr = netmaskToCidr(netmask);
      const isVirtual = isVirtualInterface(name);
      const gateway = getGatewayForInterface(name);
      const hasDefaultRoute = gateway !== null;
      const score = scoreInterface({ isVirtual, hasDefaultRoute, gateway, name });
      result.push({
        id: `${name}-${ip}`,
        name,
        ip,
        netmask,
        cidr,
        prefix,
        gateway,
        isVirtual,
        hasDefaultRoute,
        score,
      });
    }
  }
  // Sort by score descending
  result.sort((a, b) => b.score - a.score);
  return result;
}

/**
 * Convert netmask to CIDR prefix length.
 */
function netmaskToCidr(netmask) {
  const parts = netmask.split('.').map(Number);
  let cidr = 0;
  for (const part of parts) {
    cidr += (part.toString(2).match(/1/g) || []).length;
  }
  return cidr;
}

/**
 * Check if an interface is virtual/VPN/host-only.
 */
function isVirtualInterface(name) {
  const lower = name.toLowerCase();
  const virtualPatterns = [
    'virtualbox', 'vmware', 'hyper-v', 'vbox', 'vmnet',
    'virtual', 'loopback', 'pseudo', 'tunnel', 'tap', 'tun',
    'vpn', 'wireguard', 'openvpn', 'wintun', 'netadapter',
    'host-only', 'host only', 'nat', 'bridge',
  ];
  return virtualPatterns.some((p) => lower.includes(p));
}

/**
 * Get the default gateway for a specific interface using `route print`.
 */
function getGatewayForInterface(interfaceName) {
  try {
    const { execSync } = require('child_process');
    const output = execSync('route print -4 0.0.0.0', { encoding: 'utf8', timeoutMs: 5000 });
    const lines = output.split('\n');
    for (const line of lines) {
      if (line.includes('0.0.0.0') && line.includes('0.0.0.0')) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 4) {
          const gateway = parts[2];
          if (gateway && gateway !== '0.0.0.0' && gateway !== 'On-link') {
            return gateway;
          }
        }
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Score an interface for selection priority.
 * Higher score = better candidate.
 */
function scoreInterface({ isVirtual, hasDefaultRoute, gateway, name }) {
  let score = 0;
  // Default route is the strongest signal
  if (hasDefaultRoute) score += 100;
  // Gateway present
  if (gateway) score += 50;
  // Real physical adapters preferred
  if (!isVirtual) score += 30;
  // Common LAN interface names get a small boost
  const lower = name.toLowerCase();
  if (lower.includes('wi-fi') || lower.includes('wifi') || lower.includes('wireless')) score += 10;
  if (lower.includes('ethernet') || lower.includes('local area')) score += 10;
  return score;
}

/**
 * Select the best interface from the enumerated list.
 */
function selectBestInterface() {
  const interfaces = enumerateInterfaces();
  if (!interfaces.length) return null;
  return interfaces[0];
}



/**
 * Ping a single IP address to check if it's reachable.
 * Returns true if the host responds to ping.
 */
function pingHost(ip, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const { exec } = require('child_process');
    const cmd = `ping -n 1 -w ${timeoutMs} ${ip}`;
    exec(cmd, { timeout: timeoutMs + 500 }, (error, stdout) => {
      if (error) {
        resolve(false);
        return;
      }
      // Windows ping returns 0 if successful, non-zero if failed
      // Also check for "TTL=" in output which indicates a response
      const reachable = stdout.includes('TTL=') || stdout.includes('ttl=');
      resolve(reachable);
    });
  });
}

/**
 * Ping sweep a subnet to find all reachable hosts.
 * Uses bounded concurrency to avoid overwhelming the network.
 */
async function pingSweep(interfaceInfo, timeoutMs = 10000) {
  if (!interfaceInfo) return [];
  const devices = [];
  const concurrency = 50;
  const ips = [];
  for (let i = 1; i <= 254; i++) {
    const ip = `${interfaceInfo.prefix}.${i}`;
    if (ip !== interfaceInfo.ip) ips.push(ip);
  }
  log('info', `[Ping Sweep] Scanning ${ips.length} addresses on ${interfaceInfo.prefix}.0/${interfaceInfo.cidr}...`);
  let completed = 0;
  const startTime = Date.now();

  for (let i = 0; i < ips.length; i += concurrency) {
    const batch = ips.slice(i, i + concurrency);
    await Promise.allSettled(
      batch.map(async (ip) => {
        const reachable = await pingHost(ip, 1000);
        completed++;
        if (reachable) {
          log('info', `[Ping Sweep] Host reachable: ${ip}`);
          devices.push({
            ip,
            port: DEFAULT_ADB_PORT,
            name: `Android Device (${ip})`,
            instanceName: '',
            serviceType: '',
            source: 'ping-sweep',
          });
        }
      })
    );
    // Check if we've exceeded the total timeout
    if (Date.now() - startTime > timeoutMs) {
      log('info', `[Ping Sweep] Timeout reached after ${completed}/${ips.length} probes`);
      break;
    }
  }
  log('info', `[Ping Sweep] Completed. Found ${devices.length} reachable host(s).`);
  return devices;
}

/** Scan the configured APK directory for *.apk files. */
function scanApks() {
  if (!fs.existsSync(config.apkDir)) {
    throw new Error(`APK directory not found: ${config.apkDir}`);
  }
  return fs
    .readdirSync(config.apkDir)
    .filter((f) => f.toLowerCase().endsWith('.apk'))
    .map((f) => {
      const fullPath = path.join(config.apkDir, f);
      let size = 0;
      try {
        size = fs.statSync(fullPath).size;
      } catch {
        /* ignore */
      }
      return { name: f, path: fullPath, size, status: 'pending', error: null };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/* ---------------- Validation ---------------- */

function validateIp(ip) {
  if (!ip || typeof ip !== 'string' || !ip.trim()) return 'IP address is required';
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.trim());
  if (!m) return 'Invalid IP address format';
  if (m.slice(1).some((o) => Number(o) > 255)) return 'Invalid IP address';
  return null;
}

function validatePort(port, label) {
  if (port === undefined || port === null || String(port).trim() === '') return `${label} is required`;
  const s = String(port).trim();
  const n = Number(s);
  if (!/^\d+$/.test(s) || n < 1 || n > 65535) return `${label} must be a number between 1 and 65535`;
  return null;
}

/* ---------------- Concurrency guard ---------------- */

let busy = false;

/* ---------------- Express app ---------------- */

const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ----- Config ----- */

app.get('/api/config', async (req, res) => {
  const result = {
    adbPath: config.adbPath,
    apkDir: config.apkDir,
    adbStatus: { available: false, version: null, error: null },
  };
  const v = await runAdb(['version'], { stream: false });
  if (v.code === 0) {
    result.adbStatus.available = true;
    result.adbStatus.version = v.stdout.split('\n')[0].trim();
  } else {
    result.adbStatus.error = (v.stderr || v.stdout || 'ADB not found').trim();
  }
  res.json(result);
});

app.post('/api/config', (req, res) => {
  const { adbPath, apkDir } = req.body || {};
  if (adbPath !== undefined) {
    const p = String(adbPath).trim();
    if (p && p.toLowerCase() !== 'auto') {
      if (!fs.existsSync(p)) return res.status(400).json({ error: `ADB executable not found: ${p}` });
      config.adbPath = p;
    } else {
      config.adbPath = 'auto';
    }
  }
  if (apkDir !== undefined) {
    const d = String(apkDir).trim();
    if (!d) return res.status(400).json({ error: 'APK directory cannot be empty' });
    config.apkDir = d;
  }
  saveConfig(config);
  log('info', `Configuration updated (ADB: ${config.adbPath}, APK dir: ${config.apkDir})`);
  broadcastState();
  res.json({ adbPath: config.adbPath, apkDir: config.apkDir });
});

/* ----- Directory browser (read-only, for picking adb.exe) ----- */

app.get('/api/browse', (req, res) => {
  let dir = req.query.dir;
  if (!dir || typeof dir !== 'string') dir = 'C:\\';
  dir = path.resolve(dir);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return res.status(400).json({ error: `Cannot read directory: ${dir} (${e.message})` });
  }
  const dirs = [];
  const files = [];
  for (const e of entries) {
    if (e.isDirectory()) dirs.push(e.name);
    else if (e.isFile() && e.name.toLowerCase().endsWith('.exe')) files.push(e.name);
  }
  res.json({ path: dir, dirs: dirs.sort(), files: files.sort() });
});

/* ----- Pair (standalone, kept for backward compatibility) ----- */

app.post('/api/pair', async (req, res) => {
  if (busy) return res.status(409).json({ error: 'Another operation is already running' });
  const { ip, port } = req.body || {};
  const ipErr = validateIp(ip);
  if (ipErr) return res.status(400).json({ error: ipErr });
  const portErr = validatePort(port, 'Pairing port');
  if (portErr) return res.status(400).json({ error: portErr });

  busy = true;
  try {
    const target = `${ip.trim()}:${String(port).trim()}`;
    log('info', `Pairing with ${target}`);
    const r = await runAdb(['pair', target], { timeoutMs: 30000 });
    const out = (r.stdout + r.stderr).trim();
    const ok = r.code === 0 && !/fail|error|unable|refused|timed out/i.test(out);
    if (ok) {
      log('success', 'Pairing successful');
      res.json({ success: true, output: out });
    } else {
      log('error', 'Pairing failed');
      if (out) log('error', out);
      res.status(500).json({ success: false, error: out || 'Pairing failed', output: out });
    }
  } catch (e) {
    log('error', `Pairing error: ${e.message}`);
    res.status(500).json({ success: false, error: e.message });
  } finally {
    busy = false;
    broadcastState();
  }
});

/* ----- Connect (with mode: 'connect' or 'pair') ----- */

app.post('/api/connect', async (req, res) => {
  if (busy) return res.status(409).json({ error: 'Another operation is already running' });
  const { ip, port, mode, pairPort } = req.body || {};
  const ipErr = validateIp(ip);
  if (ipErr) return res.status(400).json({ error: ipErr });
  const portErr = validatePort(port, 'ADB port');
  if (portErr) return res.status(400).json({ error: portErr });

  const usePair = mode === 'pair';
  if (usePair) {
    const pairErr = validatePort(pairPort, 'Pairing port');
    if (pairErr) return res.status(400).json({ error: pairErr });
  }

  busy = true;
  try {
    const adbTarget = `${ip.trim()}:${String(port).trim()}`;

    // If Pair & Connect mode, run pairing first
    if (usePair) {
      const pairTarget = `${ip.trim()}:${String(pairPort).trim()}`;
      log('info', `Pairing with ${pairTarget}`);
      const pairRes = await runAdb(['pair', pairTarget], { timeoutMs: 30000 });
      const pairOut = (pairRes.stdout + pairRes.stderr).trim();
      if (!(pairRes.code === 0 && !/fail|error|unable|refused|timed out/i.test(pairOut))) {
        log('error', 'Pairing failed');
        if (pairOut) log('error', pairOut);
        res.status(500).json({
          success: false,
          error: pairOut || 'Pairing failed',
          output: pairOut,
          needsPairing: true,
        });
        return;
      }
      log('success', 'Pair successful');
    }

    // Connect
    log('info', `Connecting to ${adbTarget}...`);
    await runAdb(['connect', adbTarget], { timeoutMs: 15000 });

    // Verify
    const devices = await listDevices();
    const dev = devices.find((d) => d.serial === adbTarget && d.state === 'device');
    if (dev) {
      // Add to devices list if not already there
      const existing = state.devices.find((d) => d.serial === adbTarget);
      if (!existing) {
        state.devices.push({
          serial: adbTarget,
          state: 'device',
          model: '',
          manufacturer: '',
          androidVersion: '',
          transportType: adbTarget.includes(':') ? 'wifi' : 'usb',
          selected: true,
        });
      } else {
        existing.state = 'device';
        existing.selected = true;
      }
      // Fetch metadata in background (non-blocking)
      fetchDeviceMetadata(adbTarget).then((meta) => {
        const d = state.devices.find((dev) => dev.serial === adbTarget);
        if (d) {
          d.model = meta.model;
          d.manufacturer = meta.manufacturer;
          d.androidVersion = meta.androidVersion;
          broadcastState();
        }
      });
      log('success', `Device connected: ${adbTarget}`);
      broadcastState();
      // Sync agent status for the connected device (non-blocking)
      syncAgentStatusForDevice(ip.trim()).catch(() => {});
      res.json({ success: true, device: dev, devices: state.devices });
    } else {
      log('error', 'Device not connected');
      res.status(500).json({
        success: false,
        error: 'Device not connected. This device may not be paired with this computer. Try Pair & Connect.',
        devices: state.devices,
        needsPairing: true,
      });
    }
  } catch (e) {
    log('error', `Connect error: ${e.message}`);
    res.status(500).json({ success: false, error: e.message });
  } finally {
    busy = false;
    broadcastState();
  }
});

/* ----- Refresh devices (discovers all ADB devices) ----- */

app.post('/api/devices/refresh', async (req, res) => {
  if (busy) return res.status(409).json({ error: 'Another operation is already running' });
  busy = true;
  try {
    const adbDevices = await listDevices();
    const previousSerials = new Set(state.devices.map((d) => d.serial));

    // Build new device list, preserving selection state for existing devices
    const newDevices = [];
    for (const ad of adbDevices) {
      const existing = state.devices.find((d) => d.serial === ad.serial);
      newDevices.push({
        serial: ad.serial,
        state: ad.state,
        model: existing ? existing.model : '',
        manufacturer: existing ? existing.manufacturer : '',
        androidVersion: existing ? existing.androidVersion : '',
        transportType: existing ? existing.transportType : (ad.serial.includes(':') ? 'wifi' : 'usb'),
        selected: existing ? existing.selected : false,
      });
    }

    state.devices = newDevices;
    log('info', `Found ${state.devices.length} device(s) via adb devices`);
    // scrcpy belongs to a live ADB transport. Retire sessions for devices
    // that vanished or became unauthorized so stale controls cannot linger.
    scrcpySessions.stopDisconnected(state.devices.filter((d) => d.state === 'device').map((d) => d.serial));

    // Fetch metadata for all connected devices concurrently (non-blocking)
    const metadataPromises = state.devices
      .filter((d) => d.state === 'device')
      .map((d) =>
        fetchDeviceMetadata(d.serial).then((meta) => {
          d.model = meta.model;
          d.manufacturer = meta.manufacturer;
          d.androidVersion = meta.androidVersion;
        })
      );
    // Don't await metadata — let it complete in background
    Promise.allSettled(metadataPromises).then(() => broadcastState());

    // Sync agent status for all connected devices (non-blocking)
    const agentPromises = state.devices
      .filter((d) => d.state === 'device' && d.serial.includes(':'))
      .map((d) => {
        const ip = d.serial.split(':')[0];
        return syncAgentStatusForDevice(ip);
      });
    Promise.allSettled(agentPromises).catch(() => {});

    broadcastState();
    res.json({ success: true, devices: state.devices });
  } catch (e) {
    log('error', `Refresh error: ${e.message}`);
    res.status(500).json({ error: e.message });
  } finally {
    busy = false;
    broadcastState();
  }
});

/* ----- Disconnect (single or multiple) ----- */

app.post('/api/disconnect', async (req, res) => {
  if (busy) return res.status(409).json({ error: 'Another operation is already running' });
  const { ip, port, serials } = req.body || {};

  // Support disconnecting multiple devices by serials array
  let targets = [];
  if (Array.isArray(serials) && serials.length) {
    targets = serials.filter((s) => typeof s === 'string');
  } else if (ip && port) {
    targets = [`${String(ip).trim()}:${String(port).trim()}`];
  }

  if (!targets.length) {
    return res.status(400).json({ error: 'No devices specified for disconnect' });
  }

  busy = true;
  const results = [];
  try {
    // Disconnect all targets concurrently
    await Promise.allSettled(
      targets.map(async (target) => {
        log('info', `Disconnecting ${target}...`);
        await runAdb(['disconnect', target], { timeoutMs: 10000 });
        const idx = state.devices.findIndex((d) => d.serial === target);
        if (idx !== -1) {
          state.devices.splice(idx, 1);
        }
        log('success', `Disconnected ${target}`);
        results.push({ serial: target, success: true });
      })
    );
    broadcastState();
    res.json({ success: true, results, devices: state.devices });
  } catch (e) {
    log('error', `Disconnect error: ${e.message}`);
    res.status(500).json({ error: e.message });
  } finally {
    busy = false;
    broadcastState();
  }
});

/* ----- Device selection ----- */

app.post('/api/devices/select', (req, res) => {
  const { serial, selected } = req.body || {};
  if (!serial) return res.status(400).json({ error: 'Serial is required' });
  const dev = state.devices.find((d) => d.serial === serial);
  if (!dev) return res.status(404).json({ error: 'Device not found' });
  dev.selected = !!selected;
  broadcastState();
  res.json({ success: true, devices: state.devices });
});

app.post('/api/devices/select-all', (req, res) => {
  state.devices.forEach((d) => { d.selected = true; });
  broadcastState();
  res.json({ success: true, devices: state.devices });
});

app.post('/api/devices/deselect-all', (req, res) => {
  state.devices.forEach((d) => { d.selected = false; });
  broadcastState();
  res.json({ success: true, devices: state.devices });
});

app.get('/api/devices', async (req, res) => {
  try {
    const adbDevices = await listDevices();
    // Update state of known devices
    state.devices.forEach((d) => {
      const match = adbDevices.find((ad) => ad.serial === d.serial);
      d.state = match ? match.state : 'disconnected';
    });
    broadcastState();
    res.json({ devices: state.devices, adbDevices });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ----- Network Discovery ----- */

app.get('/api/network/interfaces', (req, res) => {
  const interfaces = enumerateInterfaces();
  // Auto-select Wi-Fi adapter if no interface is currently selected
  let selectedId = state.selectedInterfaceId || null;
  if (!selectedId && interfaces.length) {
    // Find the best Wi-Fi adapter (identified by name, not hardcoded)
    const wifiIface = interfaces.find((i) => {
      const name = i.name.toLowerCase();
      return name.includes('wi-fi') || name.includes('wifi') || name.includes('wireless');
    });
    if (wifiIface) {
      selectedId = wifiIface.id;
      state.selectedInterfaceId = selectedId;
      log('info', `[Network] Auto-selected Wi-Fi interface: ${wifiIface.name} (${wifiIface.ip}/${wifiIface.cidr})`);
    }
  }
  res.json({ interfaces, selectedId });
});

app.post('/api/network/select-interface', (req, res) => {
  const { interfaceId } = req.body || {};
  if (!interfaceId) return res.status(400).json({ error: 'Interface ID is required' });
  const interfaces = enumerateInterfaces();
  const iface = interfaces.find((i) => i.id === interfaceId);
  if (!iface) return res.status(404).json({ error: 'Interface not found' });
  state.selectedInterfaceId = interfaceId;
  log('info', `[Network] Selected interface: ${iface.name} (${iface.ip}/${iface.cidr})`);
  broadcastState();
  res.json({ success: true, interface: iface });
});

/**
 * Enrich discovered devices with Android agent status.
 * Non-blocking: probes run in background and update state when complete.
 * Uses cached status when available to avoid flooding the network.
 * Never labels an unreachable agent as paired or healthy.
 */
async function enrichDevicesWithAgentStatus(devices) {
  const probes = devices
    .filter((d) => d.ip)
    .map(async (d) => {
      try {
        const status = await agentBridge.getStatus(d.ip);
        d.agent = status;
        // Use the agent's reported port — currentPort, targetPort, or lastPort — never assume 5555
        const agentPort = status.currentPort || status.targetPort || status.lastPort || null;
        if (agentPort) {
          d.port = agentPort;
          // Independently verify the agent-reported port is reachable
          const portOpen = await checkPortOpen(d.ip, agentPort, 2000);
          d.agentPortVerified = portOpen;
        } else {
          d.agentPortVerified = null;
        }
      } catch (e) {
        d.agent = { reachable: false, error: e.message, isPaired: false };
        d.agentPortVerified = null;
      }
    });
  await Promise.allSettled(probes);
  broadcastState();
}

/**
 * Sync agent status for a single device by IP.
 * Reuses existing discovered device entry if present (by IP), otherwise creates
 * a minimal entry so the Agent Integration UI can display it.
 * Never labels an unreachable agent as paired or healthy.
 * Non-blocking: fires in background, broadcasts when complete.
 */
async function syncAgentStatusForDevice(ip) {
  if (!ip) return;
  try {
    const status = await agentBridge.getStatus(ip);
    const existing = state.discoveredDevices.find((d) => d.ip === ip);
    // Use the agent's reported port — currentPort, targetPort, or lastPort — never assume 5555
    const agentPort = status.currentPort || status.targetPort || status.lastPort || null;
    if (existing) {
      // Merge agent info without overwriting valid existing fields
      existing.agent = status;
      if (agentPort) {
        existing.port = agentPort;
        const portOpen = await checkPortOpen(ip, agentPort, 2000);
        existing.agentPortVerified = portOpen;
      } else {
        existing.agentPortVerified = null;
      }
    } else {
      // Create a minimal discovered device entry for this IP
      state.discoveredDevices.push({
        id: `adb-${ip}`,
        name: `Android Device (${ip})`,
        ip,
        port: agentPort || undefined,
        pairPort: 0,
        serviceType: '',
        instanceName: '',
        source: 'adb-refresh',
        status: 'discovered',
        agent: status,
        agentPortVerified: agentPort ? await checkPortOpen(ip, agentPort, 2000) : null,
      });
    }
    broadcastState();
  } catch (e) {
    log('error', `[AgentSync] Failed to sync agent status for ${ip}: ${e.message}`);
  }
}

function checkPortOpen(ip, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const net = require('net');
    const socket = new net.Socket();
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => resolve(false));
    socket.connect(port, ip);
  });
}

app.post('/api/network/scan', async (req, res) => {
  if (busy) return res.status(409).json({ error: 'Another operation is already running' });
  busy = true;
  state.networkScan = { running: true, status: 'Scanning local network...', found: 0 };
  broadcastState();
  try {
    // Enumerate all interfaces
    const interfaces = enumerateInterfaces();
    log('info', `[Network Scan] Detected ${interfaces.length} network interface(s)`);
    for (const iface of interfaces) {
      const gatewayInfo = iface.gateway ? `gateway ${iface.gateway}` : 'no default gateway';
      log('info', `[Network Scan] Candidate: ${iface.name} - ${iface.ip}/${iface.cidr} - ${gatewayInfo}`);
    }

    // Select interface: user-selected or best auto-detected
    let selected = null;
    if (state.selectedInterfaceId) {
      selected = interfaces.find((i) => i.id === state.selectedInterfaceId) || null;
    }
    if (!selected && interfaces.length) {
      selected = interfaces[0]; // Already sorted by score
    }

    if (!selected) {
      log('error', '[Network Scan] No active network interface found');
      state.networkScan = { running: false, status: 'No network interface found', found: 0 };
      broadcastState();
      res.status(400).json({ error: 'No active network interface found' });
      return;
    }

    log('info', `[Network Scan] Selected interface: ${selected.name}`);
    log('info', `[Network Scan] IP: ${selected.ip}`);
    log('info', `[Network Scan] Subnet: ${selected.prefix}.0/${selected.cidr}`);
    if (selected.gateway) {
      log('info', `[Network Scan] Gateway: ${selected.gateway}`);
    }

    // Method 1: mDNS discovery bound to selected interface
    log('info', '[Network Scan] Starting mDNS discovery...');
    log('info', `[Network Scan] Service types: ${ADB_SERVICE_TYPES.join(', ')}`);
    const mdnsResults = await mdnsDiscovery(5000, selected.ip);
    log('info', `[Network Scan] mDNS discovery returned ${mdnsResults.length} raw service(s)`);

    // Method 2: Ping sweep to find all reachable hosts
    log('info', '[Network Scan] Starting ping sweep...');
    const pingResults = await pingSweep(selected, 10000);
    log('info', `[Network Scan] Ping sweep found ${pingResults.length} reachable host(s)`);

    // Merge results: mDNS provides service details, ping sweep finds all reachable hosts
    // Use a map keyed by IP to merge devices from both sources
    const deviceMap = new Map();

    // Add ping sweep results first (these are reachable hosts with default port)
    for (const d of pingResults) {
      const key = d.ip;
      deviceMap.set(key, {
        id: `${d.ip}:${d.port}`,
        name: d.name,
        ip: d.ip,
        port: d.port,
        pairPort: 0,
        serviceType: '',
        instanceName: '',
        source: 'ping-sweep',
        status: 'discovered',
      });
    }

    // Merge mDNS results (these may have service details and different ports)
    for (const d of mdnsResults) {
      if (!d.ip) continue;
      const key = d.ip;
      const isPairingService = d.serviceType && d.serviceType.includes('pairing');
      const isConnectService = d.serviceType && d.serviceType.includes('connect');
      const advertisedPort = d.port || 0;
      const connectPort = isConnectService ? advertisedPort : DEFAULT_ADB_PORT;
      const pairPort = isPairingService ? advertisedPort : 0;
      const deviceName = d.instanceName || d.name || `Android Device (${d.ip})`;

      if (deviceMap.has(key)) {
        // Merge with existing ping sweep result
        const existing = deviceMap.get(key);
        existing.name = deviceName;
        existing.port = connectPort;
        existing.pairPort = pairPort;
        existing.serviceType = d.serviceType || '';
        existing.instanceName = d.instanceName || '';
        existing.source = 'mdns+ping';
        log('info', `[Network Scan] Merged mDNS data for ${d.ip}: port=${connectPort}, pairPort=${pairPort}, service=${d.serviceType || 'unknown'}`);
      } else {
        // New device from mDNS only
        deviceMap.set(key, {
          id: `${d.ip}:${connectPort}`,
          name: deviceName,
          ip: d.ip,
          port: connectPort,
          pairPort: pairPort,
          serviceType: d.serviceType || '',
          instanceName: d.instanceName || '',
          source: 'mdns',
          status: 'discovered',
        });
        log('info', `[Network Scan] mDNS-only device: ${d.ip} | port=${connectPort} | pairPort=${pairPort} | service=${d.serviceType || 'unknown'}`);
      }
    }

    const discovered = Array.from(deviceMap.values());
    log('info', `[Network Scan] Total unique devices after merging: ${discovered.length}`);

    state.discoveredDevices = discovered;
    const diagnosticMsg = discovered.length > 0
      ? `Found ${discovered.length} device(s)`
      : 'No devices found on the network.';
    state.networkScan = { running: false, status: diagnosticMsg, found: discovered.length };
    log('info', `[Network Scan] Discovery completed. Found ${discovered.length} Android device(s).`);
    broadcastState();
    res.json({ success: true, devices: discovered, interfaces, selected, mdnsCount: mdnsResults.length, pingCount: pingResults.length, diagnostic: diagnosticMsg });
    // Enrich with agent status in the background (non-blocking, cached)
    enrichDevicesWithAgentStatus(discovered).catch((e) => log('error', `[Agent Enrich] ${e.message}`));
  } catch (e) {
    state.networkScan = { running: false, status: 'Scan failed', found: 0 };
    log('error', `[Network Scan] Error: ${e.message}`);
    broadcastState();
    res.status(500).json({ error: e.message });
  } finally {
    busy = false;
    broadcastState();
  }
});

app.post('/api/network/pair', async (req, res) => {
  if (busy) return res.status(409).json({ error: 'Another operation is already running' });
  const { deviceId, pairingCode } = req.body || {};
  if (!deviceId) return res.status(400).json({ error: 'Device ID is required' });

  const device = state.discoveredDevices.find((d) => d.id === deviceId);
  if (!device) return res.status(404).json({ error: 'Device not found' });

  // Use the discovered pairing port — never assume it's the connect port
  const pairingPort = device.pairPort || 0;
  if (!pairingPort) {
    return res.status(400).json({ error: 'No pairing port discovered for this device. Use manual connection.' });
  }
  // For connection after pairing, use the connect port or default
  const connectPort = device.port || DEFAULT_ADB_PORT;
  const connectTarget = `${device.ip}:${connectPort}`;

  busy = true;
  try {
    const pairTarget = `${device.ip}:${pairingPort}`;
    log('info', `Pairing with ${device.name} at ${pairTarget}...`);
    const r = await runAdb(['pair', pairTarget], { timeoutMs: 30000 });
    const out = (r.stdout + r.stderr).trim();
    const ok = r.code === 0 && !/fail|error|unable|refused|timed out/i.test(out);
    if (ok) {
      log('success', 'Pairing successful');
      device.status = 'paired';
      broadcastState();

      // Auto-connect after successful pairing using the connect port
      log('info', `Auto-connecting to ${connectTarget}...`);
      await runAdb(['connect', connectTarget], { timeoutMs: 15000 });
      const devices = await listDevices();
      const dev = devices.find((d) => d.serial === connectTarget && d.state === 'device');
      if (dev) {
        const existing = state.devices.find((d) => d.serial === connectTarget);
        if (!existing) {
          state.devices.push({
            serial: connectTarget,
            state: 'device',
            model: '',
            manufacturer: '',
            androidVersion: '',
            transportType: connectTarget.includes(':') ? 'wifi' : 'usb',
            selected: true,
          });
        } else {
          existing.state = 'device';
          existing.selected = true;
        }
        fetchDeviceMetadata(connectTarget).then((meta) => {
          const d = state.devices.find((dev) => dev.serial === connectTarget);
          if (d) {
            d.model = meta.model;
            d.manufacturer = meta.manufacturer;
            d.androidVersion = meta.androidVersion;
            broadcastState();
          }
        });
        device.status = 'connected';
        log('success', `Device connected: ${connectTarget}`);
      }
      broadcastState();
      res.json({ success: true, output: out, autoConnected: true });
    } else {
      log('error', 'Pairing failed');
      if (out) log('error', out);
      res.status(500).json({ success: false, error: out || 'Pairing failed', output: out });
    }
  } catch (e) {
    log('error', `Pairing error: ${e.message}`);
    res.status(500).json({ success: false, error: e.message });
  } finally {
    busy = false;
    broadcastState();
  }
});

app.post('/api/network/disconnect', async (req, res) => {
  if (busy) return res.status(409).json({ error: 'Another operation is already running' });
  const { deviceId } = req.body || {};
  if (!deviceId) return res.status(400).json({ error: 'Device ID is required' });

  const device = state.discoveredDevices.find((d) => d.id === deviceId);
  if (!device) return res.status(404).json({ error: 'Device not found' });

  busy = true;
  try {
    const target = `${device.ip}:${device.port}`;
    log('info', `Disconnecting ${device.name} at ${target}...`);
    await runAdb(['disconnect', target], { timeoutMs: 10000 });
    const idx = state.devices.findIndex((d) => d.serial === target);
    if (idx !== -1) {
      state.devices.splice(idx, 1);
    }
    device.status = 'discovered';
    log('success', `Disconnected ${target}`);
    broadcastState();
    res.json({ success: true, devices: state.devices });
  } catch (e) {
    log('error', `Disconnect error: ${e.message}`);
    res.status(500).json({ error: e.message });
  } finally {
    busy = false;
    broadcastState();
  }
});

app.post('/api/network/connect', async (req, res) => {
  if (busy) return res.status(409).json({ error: 'Another operation is already running' });
  const { deviceId, port } = req.body || {};
  if (!deviceId) return res.status(400).json({ error: 'Device ID is required' });

  const device = state.discoveredDevices.find((d) => d.id === deviceId);
  if (!device) return res.status(404).json({ error: 'Device not found' });

  // Use explicitly provided port, or fall back to default 5555
  const connectPort = port ? String(port).trim() : String(device.port || DEFAULT_ADB_PORT);
  const target = `${device.ip}:${connectPort}`;

  busy = true;
  try {
    log('info', `Connecting to ${device.name} at ${target}...`);
    await runAdb(['connect', target], { timeoutMs: 15000 });

    const devices = await listDevices();
    const dev = devices.find((d) => d.serial === target && d.state === 'device');
    if (dev) {
      const existing = state.devices.find((d) => d.serial === target);
      if (!existing) {
        state.devices.push({
          serial: target,
          state: 'device',
          model: '',
          manufacturer: '',
          androidVersion: '',
          transportType: target.includes(':') ? 'wifi' : 'usb',
          selected: true,
        });
      } else {
        existing.state = 'device';
        existing.selected = true;
      }
      fetchDeviceMetadata(target).then((meta) => {
        const d = state.devices.find((dev) => dev.serial === target);
        if (d) {
          d.model = meta.model;
          d.manufacturer = meta.manufacturer;
          d.androidVersion = meta.androidVersion;
          broadcastState();
        }
      });
      device.status = 'connected';
      log('success', `Device connected: ${target}`);
      broadcastState();
      res.json({ success: true, device: dev, devices: state.devices });
    } else {
      log('error', 'Device not connected');
      res.status(500).json({
        success: false,
        error: 'Device not connected. This device may not be paired with this computer. Try Pair & Connect.',
        devices: state.devices,
        needsPairing: true,
      });
    }
  } catch (e) {
    log('error', `Connect error: ${e.message}`);
    res.status(500).json({ success: false, error: e.message });
  } finally {
    busy = false;
    broadcastState();
  }
});

/* ----- Android Agent bridge ----- */

app.get('/api/agent/status', async (req, res) => {
  const ip = req.query.ip || '';
  const ipErr = validateIp(ip);
  if (ipErr) return res.status(400).json({ error: ipErr });
  try {
    const status = await agentBridge.getStatus(ip.trim());
    res.json(status);
  } catch (e) {
    log('error', `Agent status error: ${e.message}`);
    res.status(502).json({ error: `Agent bridge error: ${e.message}` });
  }
});

app.post('/api/agent/pair', async (req, res) => {
  if (busy) return res.status(409).json({ error: 'Another operation is already running' });
  const { ip, port, code } = req.body || {};
  const ipErr = validateIp(ip);
  if (ipErr) return res.status(400).json({ error: ipErr });
  const portErr = validatePort(port, 'Pairing port');
  if (portErr) return res.status(400).json({ error: portErr });
  if (!code || typeof code !== 'string' || !code.trim()) {
    return res.status(400).json({ error: 'Pairing code is required' });
  }
  busy = true;
  try {
    const result = await agentBridge.pair(ip.trim(), String(port).trim(), code.trim());
    if (result.success) {
      log('success', `Agent pairing successful for ${ip.trim()}`);
      agentBridge.clearCache(ip.trim());
      broadcastState();
    } else {
      log('error', `Agent pairing failed for ${ip.trim()}: ${result.error}`);
    }
    res.status(result.success ? 200 : 502).json(result);
  } catch (e) {
    log('error', `Agent pairing error: ${e.message}`);
    res.status(502).json({ error: e.message });
  } finally {
    busy = false;
  }
});

app.post('/api/agent/switch', async (req, res) => {
  if (busy) return res.status(409).json({ error: 'Another operation is already running' });
  const { ip } = req.body || {};
  const ipErr = validateIp(ip);
  if (ipErr) return res.status(400).json({ error: ipErr });
  busy = true;
  try {
    const result = await agentBridge.switchPort(ip.trim());
    if (result.success) {
      log('info', `Agent port switch started for ${ip.trim()}`);
    } else {
      log('error', `Agent switch failed for ${ip.trim()}: ${result.error}`);
    }
    res.status(result.success ? 200 : 502).json(result);
  } catch (e) {
    log('error', `Agent switch error: ${e.message}`);
    res.status(502).json({ error: e.message });
  } finally {
    busy = false;
  }
});

app.post('/api/agent/port', async (req, res) => {
  if (busy) return res.status(409).json({ error: 'Another operation is already running' });
  const { ip, port } = req.body || {};
  const ipErr = validateIp(ip);
  if (ipErr) return res.status(400).json({ error: ipErr });
  const portErr = validatePort(port, 'Target port');
  if (portErr) return res.status(400).json({ error: portErr });
  busy = true;
  try {
    const result = await agentBridge.setPort(ip.trim(), String(port).trim());
    if (result.success) {
      log('success', `Agent target port updated to ${port} for ${ip.trim()}`);
      agentBridge.clearCache(ip.trim());
    } else {
      log('error', `Agent set port failed for ${ip.trim()}: ${result.error}`);
    }
    res.status(result.success ? 200 : 502).json(result);
  } catch (e) {
    log('error', `Agent set port error: ${e.message}`);
    res.status(502).json({ error: e.message });
  } finally {
    busy = false;
  }
});

app.get('/api/agent/logs', async (req, res) => {
  const ip = req.query.ip || '';
  const ipErr = validateIp(ip);
  if (ipErr) return res.status(400).json({ error: ipErr });
  try {
    const result = await agentBridge.getLogs(ip.trim());
    if (result.success) {
      res.json(result);
    } else {
      res.status(502).json(result);
    }
  } catch (e) {
    log('error', `Agent logs error: ${e.message}`);
    res.status(502).json({ error: e.message });
  }
});

app.post('/api/agent/reset', async (req, res) => {
  if (busy) return res.status(409).json({ error: 'Another operation is already running' });
  const { ip } = req.body || {};
  const ipErr = validateIp(ip);
  if (ipErr) return res.status(400).json({ error: ipErr });
  busy = true;
  try {
    const result = await agentBridge.resetPairing(ip.trim());
    if (result.success) {
      log('info', `Agent pairing reset for ${ip.trim()}`);
      agentBridge.clearCache(ip.trim());
      broadcastState();
    } else {
      log('error', `Agent reset failed for ${ip.trim()}: ${result.error}`);
    }
    res.status(result.success ? 200 : 502).json(result);
  } catch (e) {
    log('error', `Agent reset error: ${e.message}`);
    res.status(502).json({ error: e.message });
  } finally {
    busy = false;
  }
});

app.post('/api/agent/webserver', async (req, res) => {
  if (busy) return res.status(409).json({ error: 'Another operation is already running' });
  const { ip, enabled } = req.body || {};
  const ipErr = validateIp(ip);
  if (ipErr) return res.status(400).json({ error: ipErr });
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled (boolean) is required' });
  }
  busy = true;
  try {
    const result = await agentBridge.toggleWebServer(ip.trim(), enabled);
    if (result.success) {
      log('info', `Agent web server ${enabled ? 'enabled' : 'disabled'} for ${ip.trim()}`);
      agentBridge.clearCache(ip.trim());
    } else {
      log('error', `Agent webserver toggle failed for ${ip.trim()}: ${result.error}`);
    }
    res.status(result.success ? 200 : 502).json(result);
  } catch (e) {
    log('error', `Agent webserver error: ${e.message}`);
    res.status(502).json({ error: e.message });
  } finally {
    busy = false;
  }
});

/* ----- Install Android Agent ----- */

const AGENT_PACKAGE = 'com.tpn.adbautoenable';
const AGENT_APK_PATHS = [
  path.join(__dirname, 'agent', 'adb-auto-enable.apk'),
  path.join(__dirname, 'agent', 'ADB-auto-enable-0.3.5.apk'),
  path.join(__dirname, 'agent', 'app-release.apk'),
  path.join(__dirname, 'agent', 'agent.apk'),
];

/**
 * Install and start the Android Agent on a connected device.
 * Workflow:
 *   1. Verify device is connected via ADB
 *   2. Locate the agent APK
 *   3. Install via adb install
 *   4. Verify installation via pm list packages
 *   5. Start the agent service
 *   6. Check agent HTTP reachability
 */
app.post('/api/agent/install', async (req, res) => {
  if (busy) return res.status(409).json({ error: 'Another operation is already running' });
  const { deviceSerial } = req.body || {};
  if (!deviceSerial || typeof deviceSerial !== 'string') {
    return res.status(400).json({ error: 'Device serial is required' });
  }

  busy = true;
  const stages = [];
  const addStage = (stage, message) => {
    stages.push({ stage, message });
    log('info', `[AgentInstall] ${message}`);
  };

  try {
    // Step 1: Verify device is connected
    addStage('verify-device', `Verifying device ${deviceSerial} is connected...`);
    const devices = await listDevices();
    const dev = devices.find((d) => d.serial === deviceSerial && d.state === 'device');
    if (!dev) {
      return res.status(400).json({
        success: false,
        error: `Device ${deviceSerial} is not connected or authorized. Connect it first.`,
        stages,
      });
    }
    addStage('device-verified', 'Device is connected and authorized');

    // Step 2: Locate the agent APK
    addStage('locate-apk', 'Locating Android Agent APK...');
    let apkPath = null;
    for (const p of AGENT_APK_PATHS) {
      if (fs.existsSync(p)) {
        apkPath = p;
        break;
      }
    }
    if (!apkPath) {
      const searched = AGENT_APK_PATHS.map((p) => path.basename(p)).join(', ');
      addStage('apk-missing', `Agent APK not found. Searched: ${searched}`);
      return res.status(404).json({
        success: false,
        error: `Android Agent APK not found. The agent APK was not found in the project. ` +
          `Searched paths: ${AGENT_APK_PATHS.join(', ')}. ` +
          `The agent source is available at https://github.com/mouldybread/adb-auto-enable — ` +
          `build it with Android Studio or gradlew assembleRelease and place the APK in the agent/ directory.`,
        stages,
        apkMissing: true,
      });
    }
    addStage('apk-found', `Found agent APK: ${path.basename(apkPath)}`);

    // Step 3: Install the APK
    addStage('installing', `Installing ${path.basename(apkPath)} on ${deviceSerial}...`);
    const installRes = await runAdb(['-s', deviceSerial, 'install', '-r', apkPath], { timeoutMs: 120000 });
    const installOut = (installRes.stdout + installRes.stderr).trim();
    const installOk = installRes.code === 0 && /success/i.test(installRes.stdout) && !/failure/i.test(installRes.stdout);
    if (!installOk) {
      addStage('install-failed', `Installation failed: ${installOut}`);
      return res.status(500).json({
        success: false,
        error: `Failed to install agent APK: ${installOut}`,
        stages,
      });
    }
    addStage('installed', 'Agent APK installed successfully');

    // Step 4: Verify installation
    addStage('verify-install', `Verifying package ${AGENT_PACKAGE}...`);
    const pmRes = await runAdb(['-s', deviceSerial, 'shell', 'pm', 'list', 'packages', AGENT_PACKAGE], { timeoutMs: 10000 });
    const pmOut = (pmRes.stdout + pmRes.stderr).trim();
    if (!pmOut.includes(AGENT_PACKAGE)) {
      addStage('verify-failed', `Package ${AGENT_PACKAGE} not found after install`);
      return res.status(500).json({
        success: false,
        error: `Package ${AGENT_PACKAGE} not found after installation`,
        stages,
      });
    }
    addStage('verified', `Package ${AGENT_PACKAGE} verified`);

    // Step 5: Start the agent service
    addStage('starting', 'Starting agent service...');
    const startRes = await runAdb(['-s', deviceSerial, 'shell', 'am', 'start', '-n', `${AGENT_PACKAGE}/.MainActivity`], { timeoutMs: 10000 });
    const startOut = (startRes.stdout + startRes.stderr).trim();
    addStage('started', `Agent service start command sent: ${startOut || 'ok'}`);

    // Step 6: Check agent HTTP reachability
    addStage('check-reachable', 'Checking agent HTTP service...');
    const ip = deviceSerial.includes(':') ? deviceSerial.split(':')[0] : null;
    if (ip) {
      // Give the agent time to start its web server
      await new Promise((r) => setTimeout(r, 3000));
      const agentStatus = await agentBridge.getStatus(ip);
      if (agentStatus.reachable) {
        addStage('agent-reachable', `Agent is reachable on ${ip}:9093`);
        broadcastState();
        res.json({ success: true, stages, agentReachable: true, agentStatus });
      } else {
        addStage('agent-unreachable', `Agent not yet reachable: ${agentStatus.error}`);
        // Don't fail — the agent may need manual pairing first
        res.json({
          success: true,
          stages,
          agentReachable: false,
          agentStatus,
          message: 'Agent installed and started, but not yet reachable. It may require pairing first.',
        });
      }
    } else {
      addStage('no-ip', 'Cannot determine device IP from serial — skipping reachability check');
      res.json({
        success: true,
        stages,
        agentReachable: null,
        message: 'Agent installed and started. Reachability check skipped (USB device).',
      });
    }
  } catch (e) {
    log('error', `[AgentInstall] Error: ${e.message}`);
    res.status(500).json({ success: false, error: e.message, stages });
  } finally {
    busy = false;
  }
});

/* ----- Smart Connect (Agent + Manual dual-mode) ----- */

app.get('/api/agent/verify-port', async (req, res) => {
  const ip = req.query.ip || '';
  const port = req.query.port || '5555';
  const ipErr = validateIp(ip);
  if (ipErr) return res.status(400).json({ error: ipErr });
  const portErr = validatePort(port, 'Port');
  if (portErr) return res.status(400).json({ error: portErr });
  try {
    const open = await checkPortOpen(ip.trim(), Number(port), 3000);
    res.json({ ip: ip.trim(), port: Number(port), open });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Smart Connect — tries Agent Mode first, falls back to Manual ADB Mode.
 *
 * Agent Mode: agent pair → agent switch → discover actual port → verify TCP → adb connect
 * Manual Mode: adb pair → adb connect → verify via adb devices
 *
 * The agent's reported currentPort is used as the actual ADB endpoint — never assume 5555.
 * Returns { mode, verified, device, error, agentReachable, agentPort, stages }.
 */
async function smartConnect({ ip, port, pairPort, code, onStage }) {
  const report = (stage, message) => {
    if (typeof onStage === 'function') onStage({ stage, message });
  };
  const stages = [];
  const addStage = (stage, message) => {
    stages.push({ stage, message });
    report(stage, message);
  };

  const targetPort = String(port || DEFAULT_ADB_PORT).trim();
  const target = `${ip}:${targetPort}`;

  // --- Try Agent Mode first ---
  try {
    addStage('agent-check', 'Checking Android Agent...');
    const agentStatus = await agentBridge.getStatus(ip);
    if (agentStatus.reachable) {
      addStage('agent-reachable', `Agent reachable on ${ip}`);

      // Agent pair if needed and code provided
      if (code && pairPort) {
        addStage('pairing', `Pairing with agent at ${ip}:${pairPort}...`);
        const pairResult = await agentBridge.pair(ip, String(pairPort).trim(), code.trim());
        if (!pairResult.success) {
          addStage('pair-failed', `Agent pairing failed: ${pairResult.error}`);
          log('error', `[SmartConnect] Agent pairing failed: ${pairResult.error}`);
        } else {
          addStage('paired', 'ADB paired successfully');
          log('success', `[SmartConnect] Agent pairing successful`);
        }
      }

      // Determine the actual ADB port from the agent
      const agentPort = agentStatus.currentPort || agentStatus.targetPort || Number(targetPort);
      addStage('port-discover', `Agent reports ADB port: ${agentPort}`);

      // Agent switch to target port
      addStage('recovering', 'Requesting agent to switch ADB port...');
      const switchResult = await agentBridge.switchPort(ip);
      if (switchResult.success) {
        addStage('recovering', 'Agent port switch started, waiting...');
        await new Promise((r) => setTimeout(r, 3000));

        // Verify the actual port is reachable
        addStage('verifying', `Verifying port ${agentPort} on ${ip}...`);
        const portOpen = await checkPortOpen(ip, agentPort, 3000);
        if (portOpen) {
          addStage('port-verified', `Port ${agentPort} verified on ${ip}`);
          log('success', `[SmartConnect] Port ${agentPort} verified on ${ip} via agent`);

          // Connect via ADB using the agent-reported port
          const agentTarget = `${ip}:${agentPort}`;
          addStage('connecting', `Connecting to ADB at ${agentTarget}...`);
          await runAdb(['connect', agentTarget], { timeoutMs: 15000 });
          const devices = await listDevices();
          const dev = devices.find((d) => d.serial === agentTarget && d.state === 'device');
          if (dev) {
            addStage('online', 'Device online and authorized');
            return { mode: 'agent', verified: true, device: dev, agentReachable: true, agentPort, stages };
          }
          addStage('connect-failed', 'Port open but ADB connect failed. Device may need pairing.');
          return { mode: 'agent', verified: false, error: 'Port open but ADB connect failed. Device may need pairing.', agentReachable: true, agentPort, stages };
        }
        addStage('port-unreachable', `Port ${agentPort} not reachable on ${ip} after agent switch`);
        log('error', `[SmartConnect] Port ${agentPort} not reachable on ${ip} after agent switch`);
      } else {
        addStage('switch-failed', `Agent switch failed: ${switchResult.error}`);
        log('error', `[SmartConnect] Agent switch failed: ${switchResult.error}`);
      }
    } else {
      addStage('agent-unavailable', `Agent not reachable: ${agentStatus.error}`);
      log('info', `[SmartConnect] Agent not reachable on ${ip} (${agentStatus.error}), using Manual Mode`);
    }
  } catch (e) {
    addStage('agent-error', `Agent Mode error: ${e.message}`);
    log('error', `[SmartConnect] Agent Mode error: ${e.message}, falling back to Manual Mode`);
  }

  // --- Manual ADB Mode ---
  addStage('manual-mode', 'Trying Manual ADB Mode...');
  log('info', `[SmartConnect] Trying Manual ADB Mode for ${target}...`);

  // Manual pair if code and pairPort provided
  if (code && pairPort) {
    const pairTarget = `${ip}:${String(pairPort).trim()}`;
    addStage('pairing', `Manual pairing with ${pairTarget}...`);
    const pairRes = await runAdb(['pair', pairTarget], { timeoutMs: 30000 });
    const pairOut = (pairRes.stdout + pairRes.stderr).trim();
    if (!(pairRes.code === 0 && !/fail|error|unable|refused|timed out/i.test(pairOut))) {
      addStage('pair-failed', `Manual pairing failed`);
      log('error', `[SmartConnect] Manual pairing failed`);
      if (pairOut) log('error', pairOut);
      return { mode: 'manual', verified: false, error: pairOut || 'Pairing failed', agentReachable: false, stages };
    }
    addStage('paired', 'ADB paired successfully');
    log('success', `[SmartConnect] Manual pairing successful`);
  }

  // Manual connect
  addStage('connecting', `Connecting to ADB at ${target}...`);
  await runAdb(['connect', target], { timeoutMs: 15000 });
  const devices = await listDevices();
  const dev = devices.find((d) => d.serial === target && d.state === 'device');
  if (dev) {
    addStage('online', 'Device online and authorized');
    return { mode: 'manual', verified: true, device: dev, agentReachable: false, stages };
  }

  addStage('connect-failed', 'Device not connected. This device may not be paired with this computer.');
  return { mode: 'manual', verified: false, error: 'Device not connected. This device may not be paired with this computer.', agentReachable: false, stages };
}

app.post('/api/connect/smart', async (req, res) => {
  if (busy) return res.status(409).json({ error: 'Another operation is already running' });
  const { ip, port, pairPort, code } = req.body || {};
  const ipErr = validateIp(ip);
  if (ipErr) return res.status(400).json({ error: ipErr });
  const portErr = validatePort(port, 'ADB port');
  if (portErr) return res.status(400).json({ error: portErr });

  busy = true;
  try {
    // Collect stages for the response (SSE-style progress is future work)
    const stages = [];
    const result = await smartConnect({
      ip: ip.trim(),
      port: String(port).trim(),
      pairPort,
      code,
      onStage: (s) => stages.push(s),
    });

    if (result.verified && result.device) {
      const target = `${ip.trim()}:${String(port).trim()}`;
      const existing = state.devices.find((d) => d.serial === target);
      if (!existing) {
        state.devices.push({
          serial: target,
          state: 'device',
          model: '',
          manufacturer: '',
          androidVersion: '',
          transportType: target.includes(':') ? 'wifi' : 'usb',
          selected: true,
          connectionMode: result.mode,
        });
      } else {
        existing.state = 'device';
        existing.selected = true;
        existing.connectionMode = result.mode;
      }
      fetchDeviceMetadata(target).then((meta) => {
        const d = state.devices.find((dev) => dev.serial === target);
        if (d) {
          d.model = meta.model;
          d.manufacturer = meta.manufacturer;
          d.androidVersion = meta.androidVersion;
          broadcastState();
        }
      });

      // Update discovered device status
      const discovered = state.discoveredDevices.find((d) => d.ip === ip.trim());
      if (discovered) {
        discovered.status = 'connected';
        discovered.connectionMode = result.mode;
      }

      // Sync agent status for the connected device (non-blocking)
      syncAgentStatusForDevice(ip.trim()).catch(() => {});

      log('success', `[SmartConnect] Connected via ${result.mode} mode: ${target}`);
      broadcastState();
      res.json({ success: true, mode: result.mode, device: result.device, devices: state.devices, stages });
    } else {
      log('error', `[SmartConnect] Failed: ${result.error}`);
      res.status(500).json({ success: false, error: result.error, mode: result.mode, agentReachable: result.agentReachable, stages });
    }
  } catch (e) {
    log('error', `[SmartConnect] Error: ${e.message}`);
    res.status(500).json({ success: false, error: e.message });
  } finally {
    busy = false;
    broadcastState();
  }
});

/**
 * Reusable connection/recovery function.
 * Checks current ADB state, queries the agent, discovers the actual endpoint,
 * requests recovery if supported, and verifies the final connection.
 * Bounded retries — never infinite.
 */
async function recoverConnection({ ip, port, maxRetries = 2, onStage }) {
  const report = (stage, message) => {
    if (typeof onStage === 'function') onStage({ stage, message });
  };

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    report('attempt', `Recovery attempt ${attempt}/${maxRetries}...`);

    // Check current ADB state
    const devices = await listDevices();
    const targetPort = String(port || DEFAULT_ADB_PORT).trim();
    const target = `${ip}:${targetPort}`;
    const existing = devices.find((d) => d.serial === target && d.state === 'device');
    if (existing) {
      report('online', 'Device already connected and authorized');
      return { verified: true, device: existing, attempt };
    }

    // Query agent
    const agentStatus = await agentBridge.getStatus(ip);
    if (agentStatus.reachable) {
      report('agent-reachable', 'Agent reachable — requesting recovery...');
      const agentPort = agentStatus.currentPort || agentStatus.targetPort || Number(targetPort);
      await agentBridge.switchPort(ip);
      await new Promise((r) => setTimeout(r, 2000));

      const portOpen = await checkPortOpen(ip, agentPort, 2000);
      if (portOpen) {
        const agentTarget = `${ip}:${agentPort}`;
        await runAdb(['connect', agentTarget], { timeoutMs: 10000 });
        const devs = await listDevices();
        const dev = devs.find((d) => d.serial === agentTarget && d.state === 'device');
        if (dev) {
          report('online', 'Device online and authorized');
          return { verified: true, device: dev, attempt };
        }
      }
      report('retry', `Endpoint not reachable, retrying...`);
    } else {
      report('agent-unavailable', `Agent unavailable: ${agentStatus.error}`);
      // Try manual connect
      await runAdb(['connect', target], { timeoutMs: 10000 });
      const devs = await listDevices();
      const dev = devs.find((d) => d.serial === target && d.state === 'device');
      if (dev) {
        report('online', 'Device online and authorized');
        return { verified: true, device: dev, attempt };
      }
    }

    if (attempt < maxRetries) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  report('failed', 'Recovery failed after maximum retries');
  return { verified: false, error: 'Recovery failed after maximum retries', attempts: maxRetries };
}

app.post('/api/connect/recover', async (req, res) => {
  if (busy) return res.status(409).json({ error: 'Another operation is already running' });
  const { ip, port, maxRetries } = req.body || {};
  const ipErr = validateIp(ip);
  if (ipErr) return res.status(400).json({ error: ipErr });

  busy = true;
  try {
    const stages = [];
    const result = await recoverConnection({
      ip: ip.trim(),
      port: String(port || DEFAULT_ADB_PORT).trim(),
      maxRetries: Math.min(Math.max(parseInt(maxRetries, 10) || 2, 1), 5),
      onStage: (s) => stages.push(s),
    });

    if (result.verified && result.device) {
      const target = result.device.serial;
      const existing = state.devices.find((d) => d.serial === target);
      if (!existing) {
        state.devices.push({
          serial: target,
          state: 'device',
          model: '',
          manufacturer: '',
          androidVersion: '',
          transportType: target.includes(':') ? 'wifi' : 'usb',
          selected: true,
          connectionMode: 'agent',
        });
      } else {
        existing.state = 'device';
        existing.selected = true;
      }
      broadcastState();
      res.json({ success: true, device: result.device, stages });
    } else {
      res.status(500).json({ success: false, error: result.error, stages });
    }
  } catch (e) {
    log('error', `[Recover] Error: ${e.message}`);
    res.status(500).json({ success: false, error: e.message });
  } finally {
    busy = false;
    broadcastState();
  }
});

/* ----- APKs ----- */

app.get('/api/apks', (req, res) => {
  try {
    if (!fs.existsSync(config.apkDir)) {
      log('error', `APK directory not found: ${config.apkDir}`);
      return res.status(400).json({ error: `APK directory not found: ${config.apkDir}. Use the folder picker to select a new location.` });
    }
    state.apks = scanApks();
    log('info', `Found ${state.apks.length} APK file(s) in ${config.apkDir}`);
    broadcastState();
    res.json({ apks: state.apks, dir: config.apkDir });
  } catch (e) {
    log('error', `APK scan error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/apks/set-folder', (req, res) => {
  const { folderPath } = req.body || {};
  if (!folderPath || typeof folderPath !== 'string') {
    return res.status(400).json({ error: 'Folder path is required' });
  }
  const trimmed = folderPath.trim();
  if (!trimmed) {
    return res.status(400).json({ error: 'Folder path cannot be empty' });
  }
  // Verify the folder exists and is accessible
  try {
    fs.accessSync(trimmed, fs.constants.R_OK);
  } catch {
    return res.status(400).json({ error: `Folder not accessible: ${trimmed}` });
  }
  // Verify it's a directory
  try {
    const stat = fs.statSync(trimmed);
    if (!stat.isDirectory()) {
      return res.status(400).json({ error: `Path is not a directory: ${trimmed}` });
    }
  } catch {
    return res.status(400).json({ error: `Cannot access folder: ${trimmed}` });
  }
  config.apkDir = trimmed;
  saveConfig(config);
  log('info', `APK folder changed to: ${trimmed}`);
  // Re-scan APKs in the new folder
  try {
    state.apks = scanApks();
    log('info', `Found ${state.apks.length} APK file(s) in ${config.apkDir}`);
  } catch (e) {
    log('error', `APK scan error after folder change: ${e.message}`);
  }
  broadcastState();
  res.json({ success: true, dir: config.apkDir, apks: state.apks });
});

/**
 * Multi-device install with concurrent execution and per-device failure isolation.
 * Accepts deviceSerials array — installs on each selected device concurrently.
 */
app.post('/api/install', async (req, res) => {
  if (busy) return res.status(409).json({ error: 'Another operation is already running' });
  const { apkPaths, deviceSerials } = req.body || {};

  // Determine target devices
  let targetSerials = [];
  if (Array.isArray(deviceSerials) && deviceSerials.length) {
    targetSerials = deviceSerials.filter((s) => typeof s === 'string');
  } else {
    // Fall back to selected devices
    targetSerials = state.devices.filter((d) => d.selected && d.state === 'device').map((d) => d.serial);
  }
  if (!targetSerials.length) {
    return res.status(400).json({ error: 'No device selected or connected.' });
  }

  let targets = [];
  if (Array.isArray(apkPaths) && apkPaths.length) {
    for (const p of apkPaths) {
      if (typeof p !== 'string' || !fs.existsSync(p)) {
        return res.status(400).json({ error: `APK not found: ${p}` });
      }
      targets.push(p);
    }
  } else {
    if (!state.apks.length) {
      return res.status(400).json({ error: 'No APKs scanned. Scan APKs first.' });
    }
    targets = state.apks.map((a) => a.path);
  }

  busy = true;
  try {
    // Execute on all target devices concurrently with per-device isolation
    const deviceResults = await Promise.allSettled(
      targetSerials.map(async (serial) => {
        const results = [];
        for (const apkPath of targets) {
          const entry = state.apks.find((a) => a.path === apkPath);
          if (entry) {
            entry.status = 'installing';
            entry.error = null;
            broadcastState();
          }
          const name = path.basename(apkPath);
          log('info', `Installing ${name} on ${serial}`);
          const r = await runAdb(['-s', serial, 'install', '-r', apkPath], { timeoutMs: 300000 });
          const out = (r.stdout + r.stderr).trim();
          const ok = r.code === 0 && /success/i.test(r.stdout) && !/failure/i.test(r.stdout);
          if (entry) {
            entry.status = ok ? 'installed' : 'failed';
            entry.error = ok ? null : out;
          }
          if (ok) {
            log('success', `${name} installed on ${serial}`);
          } else {
            log('error', `${name} failed on ${serial}`);
            if (out) log('error', out);
          }
          broadcastState();
          results.push({ path: apkPath, name, success: ok, output: out });
        }
        return { serial, results };
      })
    );

    // Collect per-device results
    const allResults = [];
    const perDevice = [];
    deviceResults.forEach((dr) => {
      if (dr.status === 'fulfilled') {
        perDevice.push({ serial: dr.value.serial, success: dr.value.results.every((r) => r.success), results: dr.value.results });
        allResults.push(...dr.value.results);
      } else {
        perDevice.push({ serial: 'unknown', success: false, error: dr.reason?.message || 'Unknown error' });
      }
    });

    const succeeded = allResults.filter((r) => r.success).length;
    res.json({
      success: allResults.length > 0 && succeeded === allResults.length,
      total: allResults.length,
      succeeded,
      failed: allResults.length - succeeded,
      perDevice,
      results: allResults,
    });
  } catch (e) {
    log('error', `Install error: ${e.message}`);
    res.status(500).json({ error: e.message });
  } finally {
    busy = false;
    broadcastState();
  }
});

/* ----- AppOps (multi-device) ----- */

app.post('/api/appops', async (req, res) => {
  if (busy) return res.status(409).json({ error: 'Another operation is already running' });
  const { deviceSerials } = req.body || {};

  let targetSerials = [];
  if (Array.isArray(deviceSerials) && deviceSerials.length) {
    targetSerials = deviceSerials.filter((s) => typeof s === 'string');
  } else {
    targetSerials = state.devices.filter((d) => d.selected && d.state === 'device').map((d) => d.serial);
  }
  if (!targetSerials.length) {
    return res.status(400).json({ error: 'No device selected or connected.' });
  }

  busy = true;
  try {
    const deviceResults = await Promise.allSettled(
      targetSerials.map(async (serial) => {
        const results = [];
        for (const ao of state.appops) {
          ao.status = 'running';
          ao.error = null;
          broadcastState();
          log('info', `${ao.op} → ${ao.pkg} on ${serial}`);
          const r = await runAdb(['-s', serial, 'shell', 'appops', 'set', ao.pkg, ao.op, 'allow'], { timeoutMs: 30000 });
          const out = (r.stdout + r.stderr).trim();
          const ok = r.code === 0;
          ao.status = ok ? 'success' : 'failed';
          ao.error = ok ? null : out;
          if (ok) {
            log('success', `${ao.op} configured on ${serial}`);
          } else {
            log('error', `${ao.op} failed on ${serial}`);
            if (out) log('error', out);
          }
          broadcastState();
          results.push({ op: ao.op, package: ao.pkg, success: ok, output: out });
        }
        return { serial, results };
      })
    );

    const perDevice = [];
    deviceResults.forEach((dr) => {
      if (dr.status === 'fulfilled') {
        perDevice.push({ serial: dr.value.serial, success: dr.value.results.every((r) => r.success), results: dr.value.results });
      } else {
        perDevice.push({ serial: 'unknown', success: false, error: dr.reason?.message || 'Unknown error' });
      }
    });

    const allSuccess = perDevice.every((d) => d.success);
    res.json({ success: allSuccess, perDevice });
  } catch (e) {
    log('error', `AppOps error: ${e.message}`);
    res.status(500).json({ error: e.message });
  } finally {
    busy = false;
    broadcastState();
  }
});

/* ----- Push files to device (multi-device) ----- */

app.post('/api/push', async (req, res) => {
  if (busy) return res.status(409).json({ error: 'Another operation is already running' });
  const { apkNames, deviceSerials } = req.body || {};

  if (!Array.isArray(apkNames) || !apkNames.length) {
    return res.status(400).json({ error: 'No APK files selected' });
  }

  // Determine target devices
  let targetSerials = [];
  if (Array.isArray(deviceSerials) && deviceSerials.length) {
    targetSerials = deviceSerials.filter((s) => typeof s === 'string');
  } else {
    targetSerials = state.devices.filter((d) => d.selected && d.state === 'device').map((d) => d.serial);
  }
  if (!targetSerials.length) {
    log('error', 'No Android device connected.');
    return res.status(400).json({ error: 'No Android device connected.' });
  }

  // Validate that requested files exist inside the configured APK directory.
  const targets = [];
  for (const name of apkNames) {
    if (typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Invalid APK name' });
    }
    const clean = name.trim();
    if (/[/\\]|\.\./.test(clean)) {
      return res.status(400).json({ error: `Invalid APK name: ${clean}` });
    }
    const fullPath = path.join(config.apkDir, clean);
    const resolved = path.resolve(fullPath);
    const dirResolved = path.resolve(config.apkDir);
    if (!resolved.startsWith(dirResolved + path.sep)) {
      return res.status(400).json({ error: `Access denied: ${clean}` });
    }
    if (!fs.existsSync(resolved)) {
      return res.status(400).json({ error: `APK not found: ${clean}` });
    }
    targets.push({ name: clean, path: resolved });
  }

  busy = true;
  try {
    state.push = {
      running: true,
      files: targets.map((t) => ({ name: t.name, progress: 0, status: 'pending', error: null })),
    };
    broadcastState();

    // Execute push on all target devices concurrently
    const deviceResults = await Promise.allSettled(
      targetSerials.map(async (serial) => {
        const results = [];
        for (let i = 0; i < targets.length; i++) {
          const t = targets[i];
          const pf = state.push.files[i];
          pf.status = 'pushing';
          pf.progress = 0;
          broadcastState();
          log('info', `Pushing ${t.name} → /sdcard/Download/ on ${serial}`);

          const progressTimer = setInterval(() => {
            if (pf.progress < 90) {
              pf.progress = Math.min(90, pf.progress + Math.random() * 7 + 2);
              broadcastState();
            }
          }, 200);

          const r = await runAdb(['-s', serial, 'push', t.path, '/sdcard/Download/'], { timeoutMs: 300000 });
          clearInterval(progressTimer);

          const out = (r.stdout + r.stderr).trim();
          const ok = r.code === 0 && !/failed|error/i.test(out);
          pf.status = ok ? 'success' : 'failed';
          pf.progress = ok ? 100 : Math.round(pf.progress);
          pf.error = ok ? null : out;
          if (ok) {
            log('success', `${t.name} pushed to ${serial}`);
          } else {
            log('error', `Failed to push ${t.name} to ${serial}`);
            if (out) log('error', out);
          }
          broadcastState();
          results.push({ name: t.name, success: ok, output: out });
        }
        return { serial, results };
      })
    );

    const perDevice = [];
    deviceResults.forEach((dr) => {
      if (dr.status === 'fulfilled') {
        perDevice.push({ serial: dr.value.serial, success: dr.value.results.every((r) => r.success), results: dr.value.results });
      } else {
        perDevice.push({ serial: 'unknown', success: false, error: dr.reason?.message || 'Unknown error' });
      }
    });

    state.push.running = false;
    broadcastState();
    const allSuccess = perDevice.every((d) => d.success);
    res.json({ success: allSuccess, perDevice });
  } catch (e) {
    state.push.running = false;
    log('error', `Push error: ${e.message}`);
    broadcastState();
    res.status(500).json({ error: e.message });
  } finally {
    busy = false;
    broadcastState();
  }
});

/* ----- Scrcpy (screen mirroring) ----- */

function findScrcpyExe() {
  // Check PATH first
  try {
    const { execSync } = require('child_process');
    execSync('where scrcpy', { stdio: 'ignore', timeoutMs: 3000 });
    return 'scrcpy';
  } catch { /* not in PATH */ }
  // Check common locations
  const commonPaths = [
    'C:\\adb\\scrcpy.exe',
    'C:\\Program Files\\scrcpy\\scrcpy.exe',
    'C:\\Program Files (x86)\\scrcpy\\scrcpy.exe',
    path.join(process.env.LOCALAPPDATA || '', 'scrcpy', 'scrcpy.exe'),
    path.join(process.env.USERPROFILE || '', 'scrcpy', 'scrcpy.exe'),
  ];
  for (const p of commonPaths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

app.get('/api/scrcpy/displays', async (req, res) => {
  const { deviceSerial } = req.query;
  if (!deviceSerial) return res.status(400).json({ error: 'Device serial is required' });
  try {
    const r = await runAdb(['-s', deviceSerial, 'shell', 'dumpsys', 'display'], { stream: false, timeoutMs: 10000 });
    const displays = [];
    // Parse "Display Id=X" from Display States section
    const displayIdRegex = /Display Id=(\d+)/g;
    let match;
    while ((match = displayIdRegex.exec(r.stdout)) !== null) {
      const id = parseInt(match[1], 10);
      if (!displays.find((d) => d.id === id)) {
        displays.push({ id, name: `Display ${id}` });
      }
    }
    // Also check for display names in DisplayDeviceInfo format
    const nameRegex = /DisplayDeviceInfo\{[^}]*name=([^,]+)[^}]*displayId=(\d+)[^}]*\}/g;
    while ((match = nameRegex.exec(r.stdout)) !== null) {
      const id = parseInt(match[2], 10);
      const name = match[1].trim();
      const existing = displays.find((d) => d.id === id);
      if (existing) existing.name = name;
    }
    res.json({ success: true, displays });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/scrcpy/start', async (req, res) => {
  const { deviceSerial, displayId } = req.body || {};
  if (!deviceSerial) return res.status(400).json({ error: 'Device serial is required' });

  // Check if scrcpy is already running for this device
  if (scrcpySessions.has(deviceSerial)) {
    return res.status(400).json({ error: 'scrcpy is already running for this device' });
  }

  const scrcpyExe = findScrcpyExe();
  if (!scrcpyExe) {
    return res.status(404).json({ error: 'scrcpy executable not found. Please install scrcpy.' });
  }

  try {
    const args = ['-s', deviceSerial];
    if (displayId !== undefined && displayId !== null && displayId !== '') {
      args.push('--display-id', String(displayId));
    }
    log('info', `Starting scrcpy for ${deviceSerial}${displayId ? ` (display ${displayId})` : ''}...`);
    const proc = spawn(scrcpyExe, args, { detached: true, stdio: 'ignore' });
    proc.once('error', (e) => {
      log('error', `scrcpy failed to start: ${e.message}`);
    });
    proc.once('exit', (code) => {
      log('info', `scrcpy for ${deviceSerial} exited with code ${code}`);
    });
    scrcpySessions.add(deviceSerial, proc, displayId || null);
    log('success', `scrcpy started for ${deviceSerial}`);
    broadcastState();
    res.json({ success: true, serial: deviceSerial, displayId: displayId || null });
  } catch (e) {
    log('error', `scrcpy start error: ${e.message}`);
    res.status(500).json({ error: e.message });
  } finally {
    broadcastState();
  }
});

app.post('/api/scrcpy/stop', async (req, res) => {
  const { deviceSerial } = req.body || {};
  if (!deviceSerial) return res.status(400).json({ error: 'Device serial is required' });

  if (!scrcpySessions.has(deviceSerial)) {
    return res.status(400).json({ error: 'scrcpy is not running for this device' });
  }

  try {
    scrcpySessions.stop(deviceSerial);
    log('info', `scrcpy stopped for ${deviceSerial}`);
    broadcastState();
    res.json({ success: true });
  } catch (e) {
    log('error', `scrcpy stop error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/scrcpy/status', (req, res) => {
  res.json({ success: true, running: scrcpySessions.snapshot() });
});

/* ----- Custom Command ----- */

app.post('/api/command', async (req, res) => {
  if (busy) return res.status(409).json({ error: 'Another operation is already running' });
  const { command, deviceSerial } = req.body || {};

  if (!command || typeof command !== 'string' || !command.trim()) {
    return res.status(400).json({ error: 'Command is required' });
  }

  // Determine target device
  let targetSerial = deviceSerial;
  if (!targetSerial) {
    const selected = state.devices.find((d) => d.selected && d.state === 'device');
    if (selected) targetSerial = selected.serial;
  }
  if (!targetSerial) {
    return res.status(400).json({ error: 'No device selected or connected.' });
  }

  // Basic safety: reject obviously dangerous patterns
  const dangerousPatterns = [
    /;\s*rm\s+-rf/i,
    /;\s*del\s+/i,
    />\s*\\?\s*dev/i,
    /mkfs/i,
    /dd\s+if=/i,
  ];
  for (const pattern of dangerousPatterns) {
    if (pattern.test(command)) {
      return res.status(400).json({ error: 'Command contains potentially dangerous operations' });
    }
  }

  busy = true;
  try {
    const trimmed = command.trim();
    log('info', `Executing command on ${targetSerial}: ${trimmed}`);
    // Split command into args (simple split by whitespace, respecting quotes)
    const args = trimmed.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
    const cleanArgs = args.map((a) => a.replace(/^"|"$/g, ''));
    const r = await runAdb(['-s', targetSerial, ...cleanArgs], { timeoutMs: 30000 });
    const out = (r.stdout + r.stderr).trim();
    if (r.code === 0) {
      log('success', `Command completed on ${targetSerial}`);
      if (out) log('adb', out);
      res.json({ success: true, output: out, serial: targetSerial });
    } else {
      log('error', `Command failed on ${targetSerial} (exit ${r.code})`);
      if (out) log('error', out);
      res.status(500).json({ success: false, error: out || `Command failed with exit code ${r.code}`, output: out, serial: targetSerial });
    }
  } catch (e) {
    log('error', `Command error: ${e.message}`);
    res.status(500).json({ error: e.message });
  } finally {
    busy = false;
    broadcastState();
  }
});

/* ----- Agent device actions (switch port, reboot) ----- */

/**
 * Execute a narrowly-scoped ADB device action for an Agent-managed device.
 * Validates the device is connected before executing.
 */
async function executeAgentDeviceAction(req, res, action) {
  if (busy) return res.status(409).json({ error: 'Another operation is already running' });
  const { deviceSerial } = req.body || {};
  if (!deviceSerial || typeof deviceSerial !== 'string') {
    return res.status(400).json({ error: 'Device serial is required' });
  }

  busy = true;
  try {
    // Verify the device is actually connected
    const devices = await listDevices();
    const dev = devices.find((d) => d.serial === deviceSerial && d.state === 'device');
    if (!dev) {
      return res.status(400).json({ error: `Device ${deviceSerial} is not connected or authorized.` });
    }

    let args;
    let actionName;
    if (action === 'switch-5555') {
      args = ['-s', deviceSerial, 'tcpip', '5555'];
      actionName = 'Switch ADB TCP port to 5555';
    } else if (action === 'reboot') {
      args = ['-s', deviceSerial, 'reboot'];
      actionName = 'Reboot device';
    } else {
      return res.status(400).json({ error: 'Unknown action' });
    }

    log('info', `[AgentAction] ${actionName} on ${deviceSerial}`);
    const r = await runAdb(args, { timeoutMs: 30000 });
    const out = (r.stdout + r.stderr).trim();

    if (r.code === 0) {
      log('success', `[AgentAction] ${actionName} completed on ${deviceSerial}`);
      if (out) log('adb', out);

      // For switch-5555, refresh agent status to get the new port
      if (action === 'switch-5555') {
        const ip = deviceSerial.includes(':') ? deviceSerial.split(':')[0] : null;
        if (ip) {
          agentBridge.clearCache(ip);
          // Give the device time to switch ports
          await new Promise((resolve) => setTimeout(resolve, 2000));
          const agentStatus = await agentBridge.getStatus(ip);
          // Update the discovered device with the new agent-reported port
          const discovered = state.discoveredDevices.find((d) => d.ip === ip);
          if (discovered) {
            discovered.agent = agentStatus;
            const newPort = agentStatus.currentPort || agentStatus.targetPort || agentStatus.lastPort;
            if (newPort) {
              discovered.port = newPort;
            }
          }
          broadcastState();
        }
      }

      res.json({ success: true, output: out, serial: deviceSerial, action });
    } else {
      log('error', `[AgentAction] ${actionName} failed on ${deviceSerial} (exit ${r.code})`);
      if (out) log('error', out);
      res.status(500).json({ success: false, error: out || `Command failed with exit code ${r.code}`, output: out, serial: deviceSerial });
    }
  } catch (e) {
    log('error', `[AgentAction] Error: ${e.message}`);
    res.status(500).json({ error: e.message });
  } finally {
    busy = false;
    broadcastState();
  }
}

app.post('/api/agent/switch-5555', (req, res) => executeAgentDeviceAction(req, res, 'switch-5555'));
app.post('/api/agent/reboot', (req, res) => executeAgentDeviceAction(req, res, 'reboot'));

/* ----- Complete setup workflow ----- */

async function runSetup({ ip, pairPort, adbPort, mode }) {
  state.setup = { running: true, result: null };
  broadcastState();
  try {
    log('info', 'Starting setup...');

    const usePair = mode === 'pair';
    const adbTarget = `${ip}:${adbPort}`;

    // 1. Pair (if needed)
    if (usePair) {
      log('info', 'Pairing device...');
      const pairTarget = `${ip}:${pairPort}`;
      const pairRes = await runAdb(['pair', pairTarget], { timeoutMs: 30000 });
      const pairOut = (pairRes.stdout + pairRes.stderr).trim();
      if (!(pairRes.code === 0 && !/fail|error|unable|refused|timed out/i.test(pairOut))) {
        log('error', 'Pairing failed');
        if (pairOut) log('error', pairOut);
        throw new Error('Pairing failed');
      }
      log('success', 'Pair successful');
    }

    // 2. Connect + verify
    log('info', 'Connecting ADB...');
    await runAdb(['connect', adbTarget]);
    const devices = await listDevices();
    const dev = devices.find((d) => d.serial === adbTarget && d.state === 'device');
    if (!dev) throw new Error('Device not connected. This device may not be paired yet. Try Pair & Connect.');

    // Add to devices list
    const existing = state.devices.find((d) => d.serial === adbTarget);
    if (!existing) {
      state.devices.push({
        serial: adbTarget,
        state: 'device',
        model: '',
        manufacturer: '',
        androidVersion: '',
        transportType: adbTarget.includes(':') ? 'wifi' : 'usb',
        selected: true,
      });
    } else {
      existing.state = 'device';
      existing.selected = true;
    }
    // Fetch metadata in background
    fetchDeviceMetadata(adbTarget).then((meta) => {
      const d = state.devices.find((dev) => dev.serial === adbTarget);
      if (d) {
        d.model = meta.model;
        d.manufacturer = meta.manufacturer;
        d.androidVersion = meta.androidVersion;
        broadcastState();
      }
    });
    log('success', `Device connected: ${dev.serial}`);

    // 3. Scan APKs
    log('info', `Scanning ${config.apkDir}`);
    if (!fs.existsSync(config.apkDir)) throw new Error(`APK directory not found: ${config.apkDir}`);
    state.apks = scanApks();
    if (!state.apks.length) throw new Error('No APK files found');
    log('info', `Found ${state.apks.length} APK files`);

    // 4. Install APKs (continue on individual failure)
    let installed = 0;
    let failed = 0;
    for (const apk of state.apks) {
      apk.status = 'installing';
      apk.error = null;
      broadcastState();
      log('info', `Installing ${apk.name}`);
      const r = await runAdb(['-s', adbTarget, 'install', '-r', apk.path], { timeoutMs: 300000 });
      const out = (r.stdout + r.stderr).trim();
      const ok = r.code === 0 && /success/i.test(r.stdout) && !/failure/i.test(r.stdout);
      if (ok) {
        apk.status = 'installed';
        installed++;
        log('success', `${apk.name} installed successfully`);
      } else {
        apk.status = 'failed';
        apk.error = out;
        failed++;
        log('error', `${apk.name} failed`);
        if (out) log('error', out);
      }
      broadcastState();
    }

    // 5. AppOps
    log('info', 'Applying AppOps');
    for (const ao of state.appops) {
      ao.status = 'running';
      ao.error = null;
      broadcastState();
      log('info', `${ao.op} → ${ao.pkg}`);
      const r = await runAdb(['-s', adbTarget, 'shell', 'appops', 'set', ao.pkg, ao.op, 'allow'], { timeoutMs: 30000 });
      const out = (r.stdout + r.stderr).trim();
      const ok = r.code === 0;
      ao.status = ok ? 'success' : 'failed';
      ao.error = ok ? null : out;
      if (ok) {
        log('success', `${ao.op} configured`);
      } else {
        log('error', `${ao.op} failed`);
        if (out) log('error', out);
      }
      broadcastState();
    }

    // 6. Verify final state
    const finalDevices = await listDevices();
    const stillThere = finalDevices.find((d) => d.serial === adbTarget && d.state === 'device');
    if (!stillThere) throw new Error('Device disconnected during setup');

    const appopsOk = state.appops.filter((a) => a.status === 'success').length;
    state.setup = {
      running: false,
      result: {
        success: true,
        device: adbTarget,
        apkTotal: state.apks.length,
        apkSucceeded: installed,
        apkFailed: failed,
        appopsSucceeded: appopsOk,
        appopsTotal: state.appops.length,
      },
    };
    log('success', 'Setup completed');
  } catch (e) {
    log('error', e.message);
    state.setup = { running: false, result: { success: false, error: e.message } };
  }
  broadcastState();
}

app.post('/api/setup', (req, res) => {
  if (busy) return res.status(409).json({ error: 'Another operation is already running' });
  const { ip, pairPort, adbPort, mode } = req.body || {};
  const ipErr = validateIp(ip);
  if (ipErr) return res.status(400).json({ error: ipErr });
  const adbErr = validatePort(adbPort, 'ADB port');
  if (adbErr) return res.status(400).json({ error: adbErr });

  const usePair = mode === 'pair';
  if (usePair) {
    const pairErr = validatePort(pairPort, 'Pairing port');
    if (pairErr) return res.status(400).json({ error: pairErr });
  }

  busy = true;
  runSetup({
    ip: ip.trim(),
    pairPort: pairPort ? String(pairPort).trim() : undefined,
    adbPort: String(adbPort).trim(),
    mode: usePair ? 'pair' : 'connect',
  }).finally(() => {
    busy = false;
  });
  res.status(202).json({ message: 'Setup started' });
});

/* ----- Reset (new device) ----- */

app.post('/api/reset', (req, res) => {
  if (busy || state.setup.running) {
    return res.status(409).json({ error: 'Cannot reset while an operation is running' });
  }
  state.devices = [];
  state.apks = [];
  state.appops = APPOPS.map((a) => ({ ...a, status: 'pending', error: null }));
  state.push = { running: false, files: [] };
  state.setup = { running: false, result: null };
  log('info', '────────────────────────────────────');
  log('info', 'Session reset — ready for a new device');
  broadcastState();
  res.json({ success: true });
});

/* ----- State ----- */

app.get('/api/state', (req, res) => res.json(publicState()));

/* ----- SSE stream ----- */

app.get('/api/logs', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

/* ----- Startup ----- */

// Never crash the whole app because of an unexpected error.
process.on('uncaughtException', (e) => console.error('Uncaught exception:', e.message));
process.on('unhandledRejection', (e) => console.error('Unhandled rejection:', e));

app.listen(PORT, HOST, async () => {
  console.log(`ADB Device Setup running at http://localhost:${PORT}`);
  const v = await runAdb(['version'], { stream: false });
  if (v.code === 0) {
    console.log(`ADB found: ${v.stdout.split('\n')[0].trim()}`);
  } else {
    console.log('WARNING: adb not found. Set the ADB path in the web UI (ADB Configuration).');
  }
});
