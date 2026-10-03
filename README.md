# ADB Device Setup

A local web application for repeatedly setting up Android devices through ADB.

```
Browser UI  →  Local Backend (Node.js/Express)  →  adb.exe  →  Android Device
                     │
                     └── Agent Bridge ──HTTP──→ Android Agent (port 9093)
```

The backend binds to **127.0.0.1 only** (localhost) — the ADB control API is never
exposed to the LAN or Internet.

## Requirements

- Node.js 18+ ([nodejs.org](https://nodejs.org))
- ADB executable (Android SDK platform-tools) — either in `PATH` or configured in the UI
- Android device(s) with Wireless debugging enabled
- (Optional) [`adb-auto-enable`](https://github.com/mouldybread/adb-auto-enable) Android
  agent APK installed on the device for automatic port-5555 recovery after reboot

## Quick start

```bat
npm install
npm start
```

Then open **http://localhost:3000** in your browser.

On Windows you can also simply double-click **start.bat** (it installs dependencies
on first run, opens the browser, and starts the server).

## Usage

1. **ADB Configuration** — if `adb` is not in `PATH`, enter the full path to
   `adb.exe` (use **Browse** to pick it) and click **Verify**.
2. **Device Pairing** — enter the device's pairing IP and pairing port, click
   **Pair Device** (`adb pair <IP>:<port>`).
3. **ADB Connection** — enter the ADB IP and port (e.g. 5555), click
   **Connect ADB** (`adb connect` + `adb devices` verification).
4. **APK Installation** — click **Scan APKs** to detect `*.apk` files in the
   configured directory (`D:\Apps` by default), select the ones you want, and
   click **Install APKs** (`adb install -r`).
5. **AppOps Configuration** — click **Run AppOps** to apply the two AppOps
   settings.
6. **▶ RUN COMPLETE SETUP** — runs the whole workflow end-to-end:
   validate → pair → connect → verify → scan → install → appops → verify.
7. **↻ NEW DEVICE** — resets the session so you can immediately set up another
   device. No code changes or restarts needed.

All operations stream **live logs** to the Live Logs panel via Server-Sent
Events. The UI never freezes while ADB commands run.

## Dual-Mode Device Management

The dashboard supports **both** Agent Mode and Manual ADB Mode. It never depends
on the Android Agent being installed or reachable.

### Agent Mode
When the `adb-auto-enable` agent is installed and reachable on port 9093:
- Agent status, pairing, port switching, and logs are available
- **Smart Connect** tries the agent first: pair → switch to 5555 → verify → connect
- Agent badges show reachability and pairing status

### Manual ADB Mode
When the agent is missing, unreachable, or returns an error:
- All existing PC-side ADB workflows continue to work
- **Smart Connect** falls back to manual `adb pair` + `adb connect`
- USB devices work with existing ADB commands directly
- No agent dependency — the dashboard is fully functional without it

### Automatic Fallback
Agent failures never break existing functionality. If the agent is unreachable
during Smart Connect, the system automatically falls back to Manual ADB Mode.

### Status Distinction
Each discovered device clearly shows:
- **Discovery**: found via mDNS or ping sweep
- **Agent**: reachable / unreachable / not installed
- **ADB**: connected / disconnected / unknown
- **Connection Mode**: Agent / Manual ADB
- **Port 5555**: verified reachable / not reachable
- **Last Error**: any connection or pairing errors

### Port 5555
Port 5555 is a **preferred target, not a guaranteed capability**. The dashboard:
1. Checks if the agent is available
2. If available, requests the agent switch operation
3. **Independently verifies** from the PC whether port 5555 is reachable
4. If the agent is unavailable, uses existing ADB workflows and reports what's missing
5. Preserves access to the actual reachable port when it differs from 5555

## Android Agent Integration

The dashboard can communicate with the
[`adb-auto-enable`](https://github.com/mouldybread/adb-auto-enable) Android agent
(MIT licensed) running on the device. The agent provides device-local capabilities
that the PC cannot do remotely: device-local ADB pairing, `WRITE_SECURE_SETTINGS`
self-grant, boot-time port recovery, and TCP port switching.

### Architecture

```
PC Dashboard (Express, port 3000)
  ├── Existing: mDNS + ping sweep → discover devices
  ├── Existing: adb pair / adb connect (PC-side)
  └── Agent Bridge ──HTTP──→ Android Agent (port 9093)
         ├── GET  /api/status    → pairing status, current port, 5555 availability
         ├── POST /api/pair      → device-local pairing + self-grant
         ├── GET  /api/switch    → discover port + tcpip:5555
         ├── POST /api/port      → set target port
         ├── GET  /api/logs      → device logs
         ├── POST /api/reset     → reset pairing
         └── POST /api/webserver → enable/disable agent web server
```

### Agent API endpoints (PC dashboard)

| Method | Endpoint                | Description                              |
|--------|-------------------------|------------------------------------------|
| GET    | `/api/agent/status`     | Get agent status (paired, ports, 5555)   |
| POST   | `/api/agent/pair`       | Request device-local pairing             |
| POST   | `/api/agent/switch`     | Request port switch to target port       |
| POST   | `/api/agent/port`       | Update the agent's target port           |
| GET    | `/api/agent/logs`       | Retrieve agent logs                      |
| POST   | `/api/agent/reset`      | Reset pairing credentials (destructive)  |
| POST   | `/api/agent/webserver`  | Enable/disable the agent's web server    |
| GET    | `/api/agent/verify-port`| Independently verify a TCP port          |
| POST   | `/api/connect/smart`    | Smart Connect (Agent → Manual fallback)  |

### Device discovery enrichment

When a network scan completes, each discovered device is probed for agent status
(non-blocking, cached for 5s). Discovered devices carry an `agent` field:

```json
{
  "ip": "192.168.1.50",
  "port": 5555,
  "status": "discovered",
  "agent": {
    "reachable": true,
    "isPaired": true,
    "currentPort": 5555,
    "targetPort": 5555,
    "adb5555Available": true,
    "webServerEnabled": true,
    "lastStatus": "Success"
  },
  "agentPort5555Verified": true
}
```

### Security

- The PC dashboard binds to **127.0.0.1 only** — never exposed to LAN/Internet.
- The Agent Bridge only permits requests to **private/local IP ranges**
  (10.x, 172.16–31.x, 192.168.x, 127.x, 169.254.x). Public IPs are rejected.
- All IPs and ports are validated before any request is made.
- Agent status is cached (5s TTL) to avoid flooding the network.
- Pairing and reset operations are **never** triggered automatically during
  discovery — they require explicit user action.
- The agent's HTTP API is **unauthenticated** (original design). This is only
  safe on trusted/local networks. The PC dashboard does not expose the agent's
  API as an open proxy — it only forwards specific, validated requests.

### What stays on the device

- The `adb-auto-enable` APK (installed once, runs as foreground service on port 9093)
- Its RSA keys in `/data/data/com.tpn.adbautoenable/files/`
- `WRITE_SECURE_SETTINGS` permission (self-granted by the agent after pairing)

### Testing

```bat
node test-agent.js
```

137 assertions covering: agent reachable/unavailable, timeout, invalid JSON, unexpected HTTP status,
pairing success/failure, port 5555 verification, discovery without agent, public IP rejection,
invalid IP/port rejection, USB devices, non-5555 ports, APK installation, existing endpoints,
input validation, and Agent UI state / existing connection workflow integration.

**Note**: All tests use mock HTTP servers. No physical Android device was tested.

## API

| Method | Endpoint         | Description                                  |
|--------|------------------|----------------------------------------------|
| GET    | `/api/config`    | Get config + ADB availability                |
| POST   | `/api/config`    | Update ADB path / APK directory              |
| GET    | `/api/browse`    | List directories (read-only, for Browse)     |
| POST   | `/api/pair`      | `adb pair <ip>:<port>`                       |
| POST   | `/api/connect`   | `adb connect` + verify via `adb devices`     |
| GET    | `/api/devices`   | List connected devices                       |
| GET    | `/api/apks`      | Scan APK directory for `*.apk` files         |
| POST   | `/api/install`   | Install APKs (`adb install -r`)              |
| POST   | `/api/appops`    | Apply the two AppOps settings                |
| POST   | `/api/setup`     | Run the complete setup workflow              |
| POST   | `/api/reset`     | Reset session for a new device               |
| GET    | `/api/state`     | Current session state                        |
| GET    | `/api/logs`      | SSE stream of live logs                     |
| GET    | `/api/agent/status`  | Get Android agent status                 |
| POST   | `/api/agent/pair`    | Request device-local pairing             |
| POST   | `/api/agent/switch`  | Request port switch to target port       |
| POST   | `/api/agent/port`    | Update the agent's target port           |
| GET    | `/api/agent/logs`    | Retrieve agent logs                      |
| POST   | `/api/agent/reset`   | Reset pairing credentials                |
| POST   | `/api/agent/webserver` | Enable/disable agent web server        |
| GET    | `/api/agent/verify-port` | Independently verify a TCP port      |
| POST   | `/api/connect/smart` | Smart Connect (Agent → Manual fallback) |

All parameters are validated. ADB errors are captured and displayed — the
application never crashes because of an ADB error.

## Configuration

Settings are stored in `config.json` (created automatically):

```json
{
  "adbPath": "auto",
  "apkDir": "D:\\Apps"
}
```

- `adbPath`: `auto` to use ADB from `PATH`, or a full path to `adb.exe`.
- `apkDir`: directory scanned for `*.apk` files.

## Files

```
adb-device-setup/
├── package.json
├── server.js            # Express backend + ADB integration + SSE logs + agent bridge
├── agent-bridge.js      # Android agent HTTP client (port 9093)
├── test-agent.js        # Phase 1+2 agent bridge tests (127 tests)
├── config.json          # Runtime configuration (auto-created)
├── start.bat            # Windows start script
├── public/
│   ├── index.html       # Web UI
│   ├── style.css
│   └── app.js           # Frontend logic (SSE live logs)
└── README.md
```
