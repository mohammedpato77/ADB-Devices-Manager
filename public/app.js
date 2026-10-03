'use strict';

const $ = (id) => document.getElementById(id);

/* ============================================================
   Theme handling
   ============================================================ */

const THEME_KEY = 'adb-setup-theme';

function initTheme() {
  const saved = localStorage.getItem(THEME_KEY) || 'dark';
  setTheme(saved);
}

function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem(THEME_KEY, theme);
  $('themeIconSun').classList.toggle('hidden', theme === 'light');
  $('themeIconMoon').classList.toggle('hidden', theme === 'dark');
}

$('themeToggle').addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme');
  setTheme(current === 'dark' ? 'light' : 'dark');
});

/* ============================================================
   Live logs (SSE)
   ============================================================ */

const logPanel = $('logPanel');
const evtSource = new EventSource('/api/logs');

let userScrolling = false;

logPanel.addEventListener('scroll', () => {
  const nearBottom = logPanel.scrollHeight - logPanel.scrollTop - logPanel.clientHeight < 40;
  userScrolling = !nearBottom;
});

evtSource.addEventListener('log', (e) => {
  const { ts, level, message } = JSON.parse(e.data);
  appendLog(ts, level, message);
});

evtSource.addEventListener('state', (e) => renderState(JSON.parse(e.data)));

evtSource.onopen = () => {
  refreshState().catch(() => {});
};

function appendLog(ts, level, message) {
  const line = document.createElement('div');
  line.className = `log-line ${level}`;

  const tsSpan = document.createElement('span');
  tsSpan.className = 'log-ts';
  tsSpan.textContent = ts;

  const levelSpan = document.createElement('span');
  levelSpan.className = 'log-level';
  levelSpan.textContent = level;

  const msgSpan = document.createElement('span');
  msgSpan.className = 'log-msg';
  msgSpan.textContent = message;

  line.append(tsSpan, levelSpan, msgSpan);
  logPanel.appendChild(line);

  while (logPanel.children.length > 500) logPanel.removeChild(logPanel.firstChild);

  if (!userScrolling) {
    logPanel.scrollTop = logPanel.scrollHeight;
  }
}

/* Local helper mirroring the server's log format */
function log(level, message) {
  appendLog(new Date().toLocaleTimeString('en-GB', { hour12: false }), level, message);
}

/* ============================================================
   API helper
   ============================================================ */

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON response */
  }
  if (!res.ok) {
    throw new Error((data && data.error) || `Request failed (${res.status})`);
  }
  return data;
}

/* ============================================================
   Toast notifications & dialogs
   ============================================================ */

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showToast(message, type = 'info', timeout = 4500) {
  const stack = $('toastStack');
  if (!stack) return;
  const icons = { info: '●', success: '✓', error: '✗', warning: '⚠' };
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.setAttribute('role', 'alert');

  const icon = document.createElement('span');
  icon.className = 'toast-icon';
  icon.textContent = icons[type] || '●';

  const msg = document.createElement('span');
  msg.className = 'toast-msg';
  msg.textContent = message;

  const close = document.createElement('button');
  close.className = 'toast-close';
  close.textContent = '✕';
  close.setAttribute('aria-label', 'Dismiss notification');
  close.addEventListener('click', () => dismissToast(toast));

  toast.append(icon, msg, close);
  stack.appendChild(toast);
  setTimeout(() => dismissToast(toast), timeout);
}

function dismissToast(toast) {
  if (!toast || !toast.parentNode || toast.classList.contains('leaving')) return;
  toast.classList.add('leaving');
  setTimeout(() => toast.remove(), 200);
}

function confirmDialog(title, message, confirmLabel = 'Confirm') {
  return new Promise((resolve) => {
    const modal = $('confirmModal');
    $('confirmTitle').textContent = title;
    $('confirmMessage').textContent = message;
    $('confirmOk').textContent = confirmLabel;
    modal.classList.remove('hidden');
    $('confirmOk').focus();

    const done = (value) => {
      modal.classList.add('hidden');
      $('confirmOk').removeEventListener('click', onOk);
      $('confirmCancel').removeEventListener('click', onCancel);
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };
    const onOk = () => done(true);
    const onCancel = () => done(false);
    const onKey = (e) => { if (e.key === 'Escape') done(false); };

    $('confirmOk').addEventListener('click', onOk);
    $('confirmCancel').addEventListener('click', onCancel);
    document.addEventListener('keydown', onKey);
  });
}

function promptDialog(title, label, placeholder = '', required = true) {
  return new Promise((resolve) => {
    const modal = $('promptModal');
    const input = $('promptInput');
    $('promptTitle').textContent = title;
    $('promptLabel').textContent = label;
    input.placeholder = placeholder;
    input.value = '';
    input.classList.remove('invalid');
    modal.classList.remove('hidden');
    input.focus();

    const done = (value) => {
      modal.classList.add('hidden');
      $('promptOk').removeEventListener('click', onOk);
      $('promptCancel').removeEventListener('click', onCancel);
      input.removeEventListener('keydown', onEnter);
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };
    const submit = () => {
      const v = input.value.trim();
      if (required && !v) {
        input.classList.add('invalid');
        input.focus();
        return;
      }
      done(v || null);
    };
    const onOk = () => submit();
    const onCancel = () => done(null);
    const onEnter = (e) => { if (e.key === 'Enter') submit(); };
    const onKey = (e) => { if (e.key === 'Escape') done(null); };

    $('promptOk').addEventListener('click', onOk);
    $('promptCancel').addEventListener('click', onCancel);
    input.addEventListener('keydown', onEnter);
    document.addEventListener('keydown', onKey);
  });
}

/* ============================================================
   Busy state
   ============================================================ */

const ACTION_BTNS = [
  'connectBtn', 'refreshDevicesBtn', 'disconnectSelectedBtn', 'scanBtn', 'installBtn',
  'pushBtn', 'appopsBtn', 'setupBtn', 'selectAllDevicesBtn', 'deselectAllDevicesBtn',
  'scanNetworkBtn', 'runCommandBtn',
];

let busyState = false;

function setBusy(b) {
  busyState = b;
  document.body.classList.toggle('busy', b);
  ACTION_BTNS.forEach((id) => { $(id).disabled = b; });
  if (typeof updateScrcpyButtons === 'function') updateScrcpyButtons();
}

/* ============================================================
   Connection mode handling
   ============================================================ */

function getConnectionMode() {
  const radios = document.querySelectorAll('input[name="connMode"]');
  for (const r of radios) {
    if (r.checked) return r.value;
  }
  return 'connect';
}

function updateModeUI() {
  const mode = getConnectionMode();
  const pairPortField = $('pairPortField');
  if (mode === 'pair') {
    pairPortField.style.display = '';
  } else {
    pairPortField.style.display = 'none';
  }
}

document.querySelectorAll('input[name="connMode"]').forEach((r) => {
  r.addEventListener('change', updateModeUI);
});

/* ============================================================
   Rendering
   ============================================================ */

const STATUS_ICONS = {
  pending: '○',
  installing: '●',
  running: '●',
  installed: '✓',
  success: '✓',
  failed: '✗',
  pushing: '●',
  device: '●',
  offline: '○',
  unauthorized: '⚠',
};

const STATUS_TEXT = {
  pending: 'Pending',
  installing: 'Installing',
  running: 'Running',
  installed: 'Installed',
  success: 'Success',
  failed: 'Failed',
  pushing: 'Pushing',
  device: 'Online',
  offline: 'Offline',
  unauthorized: 'Unauthorized',
};

function formatSize(bytes) {
  if (!bytes || bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let val = bytes;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val.toFixed(val >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function renderState(s) {
  // Sync the global state so selectors/readers use the latest data
  Object.assign(state, s);
  renderConnection(s.devices);
  renderDeviceList(s.devices);
  renderNetworkInterfaces(s.networkInterfaces, s.selectedInterfaceId);
  renderDiscoveredDevices(s.discoveredDevices);
  renderAgentIntegration(s.discoveredDevices, s.networkScan);
  renderApks(s.apks);
  renderAppops(s.appops);
  renderPushProgress(s.push);
  updateNetworkVisuals();
  updateCommandDeviceSelect();
  updateScrcpyDeviceSelect();
  renderScrcpySessions(s.scrcpyRunning);

  if (s.setup.running) {
    $('resultCard').classList.add('hidden');
  } else if (s.setup.result) {
    showResult(s.setup.result);
  }
}

function renderConnection(devices) {
  const pill = $('connPill');
  const dot = pill.querySelector('.conn-dot');
  const text = $('connText');
  dot.className = 'conn-dot';

  const connected = devices.filter((d) => d.state === 'device');
  if (connected.length > 0) {
    dot.classList.add('connected');
    text.textContent = `${connected.length} device${connected.length > 1 ? 's' : ''}`;
  } else if (devices.length > 0) {
    dot.classList.add('disconnected');
    text.textContent = 'Disconnected';
  } else {
    text.textContent = 'No device';
  }
}

function renderDeviceList(devices) {
  const container = $('deviceListContainer');
  container.innerHTML = '';

  // Summary line: "N devices | M selected"
  const selectedCount = devices.filter((d) => d.selected).length;
  const summary = $('deviceSummary');
  if (summary) {
    summary.innerHTML = `<strong>${devices.length}</strong> device${devices.length === 1 ? '' : 's'} <span class="sep">|</span> <strong>${selectedCount}</strong> selected`;
  }

  if (!devices.length) {
    container.innerHTML = '<p class="no-devices">No ADB devices connected.</p>';
    $('disconnectSelectedBtn').disabled = true;
    return;
  }

  const anySelected = devices.some((d) => d.selected);
  $('disconnectSelectedBtn').disabled = !anySelected;

  devices.forEach((d) => {
    const item = document.createElement('div');
    item.className = `device-item${d.selected ? ' selected' : ''}`;

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = d.selected;
    cb.setAttribute('aria-label', `Select device ${d.serial}`);
    cb.addEventListener('change', async () => {
      try {
        await api('/api/devices/select', {
          method: 'POST',
          body: JSON.stringify({ serial: d.serial, selected: cb.checked }),
        });
      } catch (e) {
        showToast(e.message, 'error');
        cb.checked = !cb.checked;
      }
    });

    // Icon tile (phone glyph in a rounded square)
    const tile = document.createElement('div');
    tile.className = 'device-tile';
    tile.setAttribute('aria-hidden', 'true');
    tile.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>';

    const info = document.createElement('div');
    info.className = 'device-item-info';

    const serial = document.createElement('span');
    serial.className = 'device-item-serial';
    serial.textContent = d.serial;
    serial.title = d.serial;

    const details = document.createElement('span');
    details.className = 'device-item-details';
    const parts = [];
    if (d.manufacturer) parts.push(d.manufacturer);
    if (d.model) parts.push(d.model);
    if (d.androidVersion) parts.push(`Android ${d.androidVersion}`);
    details.textContent = parts.join(' · ');
    details.title = details.textContent;

    const status = document.createElement('span');
    status.className = `device-item-status ${d.state}`;
    const stateLabel = STATUS_TEXT[d.state] || d.state;
    status.textContent = stateLabel;

    const meta = document.createElement('div');
    meta.className = 'device-item-meta';
    meta.append(details);
    if (d.transportType) {
      const transport = document.createElement('span');
      transport.className = `transport-badge ${d.transportType === 'wifi' ? 'wifi' : 'usb'}`;
      transport.textContent = d.transportType === 'wifi' ? 'Wi-Fi' : 'USB';
      meta.append(transport);
    }
    meta.append(status);

    // Expandable details panel
    const panel = document.createElement('dl');
    panel.className = 'device-details-panel';
    const addRow = (label, value) => {
      if (!value) return;
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.textContent = value;
      panel.append(dt, dd);
    };
    addRow('Serial', d.serial);
    addRow('Manufacturer', d.manufacturer);
    addRow('Model', d.model);
    addRow('Android', d.androidVersion ? `Android ${d.androidVersion}` : null);
    addRow('Transport', d.transportType === 'wifi' ? 'Wi-Fi (network)' : d.transportType === 'usb' ? 'USB' : null);
    addRow('State', stateLabel);
    if (d.product) addRow('Product', d.product);
    if (d.device) addRow('Device', d.device);

    info.append(serial, meta, panel);

    const disconnectBtn = document.createElement('button');
    disconnectBtn.className = 'device-item-disconnect';
    disconnectBtn.textContent = 'Disconnect';
    disconnectBtn.addEventListener('click', async () => {
      const ok = await confirmDialog('Disconnect Device', `Disconnect "${d.serial}"?`, 'Disconnect');
      if (!ok) return;
      setBusy(true);
      try {
        await api('/api/disconnect', {
          method: 'POST',
          body: JSON.stringify({ serials: [d.serial] }),
        });
        showToast(`Disconnected ${d.serial}`, 'success');
      } catch (e) {
        showToast(e.message, 'error');
      } finally {
        setBusy(false);
      }
    });

    // Chevron toggles the details panel
    const expandBtn = document.createElement('button');
    expandBtn.className = 'device-expand';
    expandBtn.title = 'Show device details';
    expandBtn.setAttribute('aria-label', `Show details for ${d.serial}`);
    expandBtn.setAttribute('aria-expanded', 'false');
    expandBtn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';
    expandBtn.addEventListener('click', () => {
      const expanded = item.classList.toggle('expanded');
      expandBtn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      expandBtn.title = expanded ? 'Hide device details' : 'Show device details';
    });

    item.append(cb, tile, info, disconnectBtn, expandBtn);
    container.appendChild(item);
  });
}

function renderNetworkInterfaces(interfaces, selectedId) {
  const container = $('networkInterfacesList');
  if (!container) return;
  container.innerHTML = '';

  if (!interfaces || !interfaces.length) {
    container.innerHTML = '<p class="no-devices">No network interfaces found.</p>';
    return;
  }

  interfaces.forEach((iface) => {
    const item = document.createElement('label');
    item.className = `network-interface${iface.id === selectedId ? ' selected' : ''}`;

    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'networkInterface';
    radio.value = iface.id;
    radio.checked = iface.id === selectedId;
    radio.addEventListener('change', async () => {
      try {
        await api('/api/network/select-interface', {
          method: 'POST',
          body: JSON.stringify({ interfaceId: iface.id }),
        });
        // Re-render to update selection
        const newState = await api('/api/state');
        renderState(newState);
      } catch (e) {
        showToast(e.message, 'error');
      }
    });

    const info = document.createElement('div');
    info.className = 'network-interface-info';

    const name = document.createElement('span');
    name.className = 'network-interface-name';
    name.textContent = iface.name;

    const details = document.createElement('span');
    details.className = 'network-interface-details';
    const detailParts = [`${iface.ip}/${iface.cidr}`];
    if (iface.gateway) detailParts.push(`GW ${iface.gateway}`);
    details.textContent = detailParts.join(' · ');

    info.append(name, details);

    const badges = document.createElement('div');
    badges.className = 'iface-badges';

    if (iface.isVirtual) {
      const vBadge = document.createElement('span');
      vBadge.className = 'network-interface-badge virtual';
      vBadge.textContent = 'Virtual';
      badges.appendChild(vBadge);
    } else {
      const pBadge = document.createElement('span');
      pBadge.className = 'network-interface-badge physical';
      pBadge.textContent = 'Physical';
      badges.appendChild(pBadge);
    }

    if (iface.hasDefaultRoute) {
      const gBadge = document.createElement('span');
      gBadge.className = 'network-interface-badge gateway';
      gBadge.textContent = 'Default Route';
      badges.appendChild(gBadge);
    }

    item.append(radio, info, badges);
    container.appendChild(item);
  });
}

/* Radar visual + stats strip for the Network Discovery card */
function updateNetworkVisuals() {
  const radar = $('radar');
  const radarText = $('radarText');
  const radarSub = $('radarSub');
  const statIfaces = $('statIfaces');
  const statFound = $('statFound');
  const statStatus = $('statStatus');
  if (!radar || !radarText || !radarSub) return;

  const ifaces = (state.networkInterfaces || []).length;
  const scanning = !!(state.networkScan && state.networkScan.running);
  const found = (state.discoveredDevices || []).length ||
    (state.networkScan && state.networkScan.found) || 0;

  radar.classList.toggle('scanning', scanning);

  if (scanning) {
    radarText.textContent = state.networkScan.status || 'Scanning network…';
  } else if (found > 0) {
    radarText.textContent = `${found} device${found === 1 ? '' : 's'} found`;
  } else {
    radarText.textContent = 'Ready to scan';
  }

  radarSub.textContent = ifaces
    ? `${ifaces} interface${ifaces === 1 ? '' : 's'} available`
    : 'No network interfaces found.';

  if (statIfaces) statIfaces.textContent = String(ifaces);
  if (statFound) statFound.textContent = String(found);
  if (statStatus) {
    if (scanning) {
      statStatus.className = 'stat-value stat-status busy';
      statStatus.innerHTML = '<span class="stat-dot"></span>Scanning';
    } else {
      statStatus.className = 'stat-value stat-status';
      statStatus.innerHTML = '<span class="stat-dot"></span>Idle';
    }
  }
}

function renderDiscoveredDevices(devices) {
  const container = $('discoveredDevicesList');
  const statusEl = $('networkScanStatus');

  // Update scan status
  if (statusEl) {
    if (state.networkScan.running) {
      statusEl.textContent = state.networkScan.status || 'Scanning...';
      statusEl.className = 'network-scan-status scanning';
      statusEl.classList.remove('hidden');
    } else if (state.networkScan.status) {
      statusEl.textContent = state.networkScan.status;
      statusEl.className = 'network-scan-status ' + (state.networkScan.found > 0 ? 'completed' : 'empty');
      statusEl.classList.remove('hidden');
    } else {
      statusEl.classList.add('hidden');
    }
  }

  if (!container) return;
  container.innerHTML = '';

  if (!devices || !devices.length) {
    const diagnostic = state.networkScan.status || 'No devices found';
    container.innerHTML = `<p class="no-devices">${diagnostic}</p>`;
    return;
  }

  devices.forEach((d) => {
    const item = document.createElement('div');
    item.className = `discovered-device ${d.status}`;

    const info = document.createElement('div');
    info.className = 'discovered-device-info';

    const name = document.createElement('span');
    name.className = 'discovered-device-name';
    name.textContent = d.name || 'Android Device';

    const details = document.createElement('span');
    details.className = 'discovered-device-details';
    const parts = [];
    if (d.ip) parts.push(d.ip);
    if (d.port) parts.push(`Discovered ADB Port ${d.port}`);
    if (d.pairPort) parts.push(`Pair Port ${d.pairPort}`);
    if (d.serviceType) parts.push(d.serviceType.replace('._tcp.local', ''));
    details.textContent = parts.join(' · ');

    const status = document.createElement('span');
    status.className = `discovered-device-status ${d.status}`;
    const statusText = { discovered: '● Discovered', paired: '● Paired', connected: '● Connected' };
    status.textContent = statusText[d.status] || d.status;

    info.append(name, details, status);

    // Agent status badge
    if (d.agent) {
      const agentBadge = document.createElement('span');
      const agentReachable = d.agent.reachable;
      agentBadge.className = `agent-badge ${agentReachable ? 'reachable' : 'unreachable'}`;
      agentBadge.textContent = agentReachable ? '● Agent available' : '○ Agent unavailable';
      agentBadge.title = agentReachable
        ? `Agent: paired=${d.agent.isPaired}, port=${d.agent.currentPort}, 5555=${d.agent.adb5555Available}`
        : `Agent status unavailable: ${d.agent.error || 'no response'}`;
      info.appendChild(agentBadge);
    } else {
      const agentBadge = document.createElement('span');
      agentBadge.className = 'agent-badge unknown';
      agentBadge.textContent = '… Checking Agent';
      info.appendChild(agentBadge);
    }

    // Connection mode badge
    if (d.connectionMode) {
      const modeBadge = document.createElement('span');
      modeBadge.className = `mode-badge ${d.connectionMode}`;
      modeBadge.textContent = d.connectionMode === 'agent' ? 'Agent Mode' : 'Manual Mode';
      info.appendChild(modeBadge);
    }

    const adbBadge = document.createElement('span');
    adbBadge.className = `mode-badge ${d.status === 'connected' ? 'connected' : 'unknown'}`;
    adbBadge.textContent = d.status === 'connected' ? 'ADB connected' : 'ADB not connected';
    info.appendChild(adbBadge);

    const connectionModeBadge = document.createElement('span');
    connectionModeBadge.className = `mode-badge ${d.status === 'connected' ? (d.connectionMode || 'manual') : 'unknown'}`;
    connectionModeBadge.textContent = d.status === 'connected'
      ? (d.connectionMode === 'agent' ? 'Connection: Agent' : 'Connection: Manual ADB')
      : 'Connection: Not connected';
    info.appendChild(connectionModeBadge);

    // Port 5555 verified indicator
    const verifiedBadge = document.createElement('span');
    verifiedBadge.className = `port-verified-badge ${d.agentPort5555Verified ? 'verified' : 'unverified'}`;
    verifiedBadge.textContent = d.agentPort5555Verified === true
      ? '✓ Port 5555 independently reachable'
      : d.agentPort5555Verified === false ? '○ Port 5555 checked and not reachable' : '○ Port 5555 not independently verified';
    info.appendChild(verifiedBadge);

    // Last error display
    if (d.lastError) {
      const errorBadge = document.createElement('span');
      errorBadge.className = 'error-badge';
      errorBadge.textContent = `⚠ ${d.lastError}`;
      info.appendChild(errorBadge);
    }

    // Port input for manual override
    const portInputWrap = document.createElement('div');
    portInputWrap.className = 'discovered-device-port-input';
    const portLabel = document.createElement('label');
    portLabel.textContent = 'Port:';
    const portInput = document.createElement('input');
    portInput.type = 'text';
    portInput.className = 'discovered-device-port';
    portInput.placeholder = '5555';
    portInput.value = d.port || '';
    portInputWrap.append(portLabel, portInput);

    const actions = document.createElement('div');
    actions.className = 'discovered-device-actions';

    // Refresh status — always available
    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'btn ghost-pill small';
    refreshBtn.textContent = '↻ Status';
    refreshBtn.title = 'Refresh device status';
    refreshBtn.addEventListener('click', () => refreshDeviceStatus(d));
    actions.appendChild(refreshBtn);

    // Verify port 5555 — always available
    const verifyBtn = document.createElement('button');
    verifyBtn.className = 'btn ghost-pill small';
    verifyBtn.textContent = 'Verify 5555';
    verifyBtn.title = 'Verify port 5555 is reachable';
    verifyBtn.addEventListener('click', () => verifyDevicePort(d, portInput.value));
    actions.appendChild(verifyBtn);

    if (d.status === 'connected') {
      const disconnectBtn = document.createElement('button');
      disconnectBtn.className = 'btn danger small';
      disconnectBtn.textContent = 'Disconnect';
      disconnectBtn.addEventListener('click', () => disconnectDiscoveredDevice(d));
      actions.appendChild(disconnectBtn);
    } else if (d.status === 'paired') {
      const connectBtn = document.createElement('button');
      connectBtn.className = 'btn primary small';
      connectBtn.textContent = 'Connect';
      connectBtn.addEventListener('click', () => connectDiscoveredDevice(d, portInput.value));
      actions.appendChild(connectBtn);
    } else {
      // Smart Connect — tries Agent Mode first, falls back to Manual
      const smartBtn = document.createElement('button');
      smartBtn.className = 'btn grad-pill small';
      smartBtn.textContent = 'Smart Connect';
      smartBtn.addEventListener('click', () => smartConnectDiscovered(d, portInput.value));
      actions.appendChild(smartBtn);

      // Manual Connect Only
      const connectBtn = document.createElement('button');
      connectBtn.className = 'btn primary small';
      connectBtn.textContent = 'Connect';
      connectBtn.addEventListener('click', () => connectDiscoveredDevice(d, portInput.value));
      actions.appendChild(connectBtn);

      if (d.pairPort) {
        const pairBtn = document.createElement('button');
        pairBtn.className = 'btn secondary small';
        pairBtn.textContent = 'Pair & Connect';
        pairBtn.addEventListener('click', () => pairDiscoveredDevice(d));
        actions.appendChild(pairBtn);
      }
    }

    // Agent-specific actions — only when agent is reachable
    if (d.agent && d.agent.reachable) {
      const agentActions = document.createElement('div');
      agentActions.className = 'discovered-device-actions agent-actions';

      const switchBtn = document.createElement('button');
      switchBtn.className = 'btn accent small';
      switchBtn.textContent = '⇄ Switch to 5555';
      switchBtn.title = 'Request agent to switch ADB to port 5555';
      switchBtn.addEventListener('click', () => agentSwitchPort(d));
      agentActions.appendChild(switchBtn);

      const logsBtn = document.createElement('button');
      logsBtn.className = 'btn ghost-pill small';
      logsBtn.textContent = 'Agent Logs';
      logsBtn.title = 'View agent logs';
      logsBtn.addEventListener('click', () => viewAgentLogs(d));
      agentActions.appendChild(logsBtn);

      actions.appendChild(agentActions);
    }

    item.append(info, portInputWrap, actions);
    container.appendChild(item);
  });
}

function renderAgentIntegration(devices = [], networkScan = {}) {
  const container = $('agentStatusContainer');
  if (!container) return;
  container.replaceChildren();
  if (!devices || devices.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'agent-empty-state';
    empty.textContent = networkScan && networkScan.running
      ? 'Network discovery is running. Agent availability is device-specific and will appear for each discovered device.'
      : 'No devices discovered. Scan the network to check Agent availability.';
    container.appendChild(empty);
    return;
  }
  devices.forEach((device) => {
    const row = document.createElement('div');
    row.className = 'agent-device-row';
    const title = document.createElement('strong');
    title.textContent = `${device.name || 'Android Device'}${device.ip ? ` · ${device.ip}` : ''}`;
    const status = document.createElement('span');
    const agent = device.agent;
    if (!agent) {
      status.className = 'agent-state pending';
      status.textContent = 'Checking Agent availability';
    } else if (agent.reachable) {
      status.className = 'agent-state reachable';
      status.textContent = 'Agent available';
    } else if (/timed? ?out|timeout/i.test(agent.error || '')) {
      status.className = 'agent-state unknown';
      status.textContent = 'Status unknown / timeout';
    } else {
      status.className = 'agent-state unavailable';
      status.textContent = 'Agent unavailable';
    }
    const meta = document.createElement('span');
    meta.className = 'agent-device-meta';
    const liveAdbDevice = (state.devices || []).find((d) => d.state === 'device' && d.serial.startsWith(`${device.ip}:`));
    const portInfo = device.status === 'connected'
      ? `ADB connected at ${liveAdbDevice ? liveAdbDevice.serial : `${device.ip}:${device.port || 'port unknown'}`}`
      : `ADB not connected${device.port ? ` · discovered ADB port ${device.port} (not yet connected)` : ''}`;
    const verified = device.agentPort5555Verified === true
      ? 'Port 5555 independently verified reachable'
      : device.agentPort5555Verified === false ? 'Port 5555 independently checked and not reachable' : 'Port 5555 not independently verified';
    const extraPortCheck = device.verifiedPortStatus && device.verifiedPortStatus.port !== 5555
      ? ` · Port ${device.verifiedPortStatus.port} ${device.verifiedPortStatus.open ? 'independently reachable' : 'not reachable'}` : '';
    meta.textContent = `${portInfo} · ${device.status === 'connected' ? (device.connectionMode === 'agent' ? 'Connection: Agent' : 'Connection: Manual ADB') : 'Connection: Not connected'} · ${verified}${extraPortCheck}`;
    row.append(title, status, meta);
    container.appendChild(row);
  });
}

async function pairDiscoveredDevice(device) {
  if (busyState) return;
  const code = await promptDialog(
    'Pair Device',
    'Enter the 6-digit pairing code shown on the Android device',
    'e.g. 123456'
  );
  if (!code) return;

  setBusy(true);
  try {
    await api('/api/network/pair', {
      method: 'POST',
      body: JSON.stringify({ deviceId: device.id, pairingCode: code }),
    });
    showToast(`Paired with ${device.ip} — connecting…`, 'success');
    // Auto-connect after successful pairing
    await connectDiscoveredDevice(device, undefined, true);
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    setBusy(false);
  }
}

async function connectDiscoveredDevice(device, port, alreadyBusy = false) {
  if (!alreadyBusy) {
    if (busyState) return;
    setBusy(true);
  }
  try {
    const r = await api('/api/network/connect', {
      method: 'POST',
      body: JSON.stringify({ deviceId: device.id, port: port || undefined }),
    });
    const serial = r && r.device && r.device.serial ? r.device.serial : `${device.ip}:${port || device.port}`;
    showToast(`Connected: ${serial}`, 'success');
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    if (!alreadyBusy) setBusy(false);
  }
}

/**
 * Smart Connect — tries Agent Mode first, falls back to Manual ADB Mode.
 * Uses the /api/connect/smart endpoint which handles the dual-mode logic.
 */
async function smartConnectDiscovered(device, port) {
  if (busyState) return;
  setBusy(true);
  try {
    const payload = { ip: device.ip, port: port || device.port || 5555 };
    // If the device has a pairing port and no agent, include pair info for manual mode
    if (device.pairPort && !(device.agent && device.agent.reachable)) {
      payload.pairPort = device.pairPort;
    }
    const r = await api('/api/connect/smart', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    if (r.success) {
      const modeLabel = r.mode === 'agent' ? 'Agent Mode' : 'Manual Mode';
      showToast(`Connected via ${modeLabel}: ${r.device.serial}`, 'success');
    } else {
      showToast(r.error || 'Connection failed', 'error');
    }
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    setBusy(false);
  }
}

async function disconnectDiscoveredDevice(device) {
  if (busyState) return;
  setBusy(true);
  try {
    await api('/api/network/disconnect', {
      method: 'POST',
      body: JSON.stringify({ deviceId: device.id }),
    });
    showToast(`Disconnected ${device.ip}`, 'success');
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    setBusy(false);
  }
}

/**
 * Refresh device status — re-probes agent and updates the device.
 */
async function refreshDeviceStatus(device) {
  if (busyState) return;
  setBusy(true);
  try {
    const r = await api(`/api/agent/status?ip=${encodeURIComponent(device.ip)}`);
    device.agent = r;
    if (r.adb5555Available) {
      const portR = await api(`/api/agent/verify-port?ip=${encodeURIComponent(device.ip)}&port=5555`);
      device.agentPort5555Verified = portR.open;
    } else device.agentPort5555Verified = null;
    renderDiscoveredDevices(state.discoveredDevices);
    renderAgentIntegration(state.discoveredDevices, state.networkScan);
    showToast(`Status refreshed for ${device.ip}`, 'info');
  } catch (e) {
    device.agent = { reachable: false, error: e.message };
    device.agentPort5555Verified = null;
    renderDiscoveredDevices(state.discoveredDevices);
    renderAgentIntegration(state.discoveredDevices, state.networkScan);
    showToast(e.message, 'error');
  } finally {
    setBusy(false);
  }
}

/**
 * Verify port 5555 is reachable on the device from the PC.
 */
async function verifyDevicePort(device, port) {
  if (busyState) return;
  setBusy(true);
  try {
    const r = await api(`/api/agent/verify-port?ip=${encodeURIComponent(device.ip)}&port=${encodeURIComponent(port || 5555)}`);
    device.verifiedPortStatus = { port: Number(r.port), open: !!r.open };
    if (Number(r.port) === 5555) device.agentPort5555Verified = !!r.open;
    if (r.open) {
      showToast(`Port ${r.port} is open on ${r.ip}`, 'success');
    } else {
      showToast(`Port ${r.port} is NOT reachable on ${r.ip}`, 'warning');
    }
    renderDiscoveredDevices(state.discoveredDevices);
    renderAgentIntegration(state.discoveredDevices, state.networkScan);
  } catch (e) {
    device.verifiedPortStatus = { port: Number(port || 5555), open: null, error: e.message };
    renderAgentIntegration(state.discoveredDevices, state.networkScan);
    showToast(e.message, 'error');
  } finally {
    setBusy(false);
  }
}

/**
 * Request the agent to switch ADB to port 5555.
 */
async function agentSwitchPort(device) {
  if (busyState) return;
  setBusy(true);
  try {
    const r = await api('/api/agent/switch', {
      method: 'POST',
      body: JSON.stringify({ ip: device.ip }),
    });
    if (r.success) {
      showToast('Agent port switch started — waiting for 5555...', 'info');
      // Wait and verify
      await new Promise((res) => setTimeout(res, 3000));
      const portR = await api(`/api/agent/verify-port?ip=${encodeURIComponent(device.ip)}&port=5555`);
      if (portR.open) {
        showToast(`Port 5555 verified on ${device.ip}`, 'success');
        device.agentPort5555Verified = true;
      } else {
        showToast('Port 5555 not yet reachable — agent may still be switching', 'warning');
      }
    } else {
      showToast(r.error || 'Agent switch failed', 'error');
    }
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    setBusy(false);
    renderDiscoveredDevices(state.discoveredDevices);
  }
}

/**
 * View agent logs for a device.
 */
async function viewAgentLogs(device) {
  if (busyState) return;
  setBusy(true);
  try {
    const r = await api(`/api/agent/logs?ip=${encodeURIComponent(device.ip)}`);
    if (r.success) {
      showToast('Agent logs loaded — check browser console', 'info');
      console.log(`[Agent Logs for ${device.ip}]`);
      console.log(r.logs);
    } else {
      showToast(r.error || 'Failed to get agent logs', 'error');
    }
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    setBusy(false);
  }
}

function renderApks(apks) {
  const tbody = $('apkTableBody');
  tbody.innerHTML = '';

  if (!apks.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty-cell">No APKs scanned. Click Scan to detect files.</td></tr>';
    updateSelectionInfo();
    return;
  }

  apks.forEach((a) => {
    const tr = document.createElement('tr');

    // Checkbox
    const tdCheck = document.createElement('td');
    tdCheck.className = 'col-check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = a.path;
    cb.dataset.name = a.name;
    cb.checked = a.status === 'pending';
    cb.disabled = a.status === 'installed' || a.status === 'installing';
    cb.addEventListener('change', updateSelectionInfo);
    tdCheck.appendChild(cb);

    // Name
    const tdName = document.createElement('td');
    tdName.className = 'apk-name';
    tdName.textContent = a.name;
    tdName.title = a.name;

    // Size
    const tdSize = document.createElement('td');
    tdSize.className = 'apk-size';
    tdSize.textContent = formatSize(a.size);

    // Status
    const tdStatus = document.createElement('td');
    const statusSpan = document.createElement('span');
    statusSpan.className = `status-cell ${a.status}`;
    statusSpan.textContent = `${STATUS_ICONS[a.status] || '○'} ${STATUS_TEXT[a.status] || a.status}`;
    tdStatus.appendChild(statusSpan);

    tr.append(tdCheck, tdName, tdSize, tdStatus);
    tbody.appendChild(tr);
  });

  updateSelectAllCheckbox();
  updateSelectionInfo();
}

function renderAppops(appops) {
  const list = $('appopsList');
  list.innerHTML = '';
  appops.forEach((a) => {
    const li = document.createElement('li');

    const icon = document.createElement('span');
    icon.className = `appops-icon ${a.status}`;
    icon.textContent = STATUS_ICONS[a.status] || '○';

    const info = document.createElement('div');
    info.className = 'appops-info';
    const op = document.createElement('div');
    op.className = 'appops-op';
    op.textContent = a.op;
    const pkg = document.createElement('div');
    pkg.className = 'appops-pkg';
    pkg.textContent = a.pkg;
    info.append(op, pkg);

    const status = document.createElement('span');
    status.className = `appops-status ${a.status}`;
    status.textContent = STATUS_TEXT[a.status] || a.status;

    li.append(icon, info, status);
    list.appendChild(li);
  });
}

function renderPushProgress(push) {
  const container = $('pushProgress');
  const list = $('pushProgressList');

  if (!push || (!push.running && !push.files.length)) {
    container.classList.add('hidden');
    return;
  }

  container.classList.remove('hidden');
  list.innerHTML = '';

  push.files.forEach((f) => {
    const div = document.createElement('div');
    div.className = 'push-file';

    const header = document.createElement('div');
    header.className = 'push-file-header';

    const name = document.createElement('span');
    name.className = 'push-file-name';
    name.textContent = f.name;

    const status = document.createElement('span');
    status.className = `push-file-status ${f.status}`;
    const pct = f.status === 'pushing' ? ` ${Math.round(f.progress)}%` : '';
    const icon = STATUS_ICONS[f.status] || '○';
    status.textContent = `${icon} ${STATUS_TEXT[f.status] || f.status}${pct}`;

    header.append(name, status);

    const bar = document.createElement('div');
    bar.className = 'push-bar';
    const fill = document.createElement('div');
    fill.className = `push-bar-fill ${f.status === 'success' ? 'success' : f.status === 'failed' ? 'failed' : ''}`;
    fill.style.width = `${f.progress || 0}%`;
    bar.appendChild(fill);

    div.append(header, bar);

    if (f.error) {
      const err = document.createElement('div');
      err.className = 'push-file-error';
      err.textContent = f.error;
      div.appendChild(err);
    }

    list.appendChild(div);
  });
}

function showResult(r) {
  const card = $('resultCard');
  card.classList.remove('hidden');
  card.classList.toggle('failed', !r.success);
  if (r.success) {
    $('resultTitle').textContent = 'Setup Completed';
    $('resultBody').innerHTML =
      `<div class="result-grid">` +
      `<div><span class="result-label">Device</span><span>${r.device}</span></div>` +
      `<div><span class="result-label">APK Installation</span>` +
      `<span>${r.apkSucceeded}/${r.apkTotal} successful${r.apkFailed ? `, ${r.apkFailed} failed` : ''}</span></div>` +
      `<div><span class="result-label">AppOps</span>` +
      `<span>${r.appopsSucceeded}/${r.appopsTotal} successful</span></div>` +
      `</div>`;
  } else {
    $('resultTitle').textContent = 'Setup Failed';
    $('resultBody').innerHTML = `<div class="result-error">${r.error}</div>`;
  }
}

/* ============================================================
   Selection handling
   ============================================================ */

function getSelectedApks() {
  return [...document.querySelectorAll('#apkTableBody input:checked')].map((i) => ({
    path: i.value,
    name: i.dataset.name,
  }));
}

function updateSelectionInfo() {
  const count = document.querySelectorAll('#apkTableBody input:checked').length;
  $('selectionInfo').textContent = `Selected: ${count}`;
}

function updateSelectAllCheckbox() {
  const all = document.querySelectorAll('#apkTableBody input[type="checkbox"]');
  const checked = document.querySelectorAll('#apkTableBody input[type="checkbox"]:checked');
  const selectAll = $('selectAllChk');
  if (all.length === 0) {
    selectAll.checked = false;
    selectAll.indeterminate = false;
    return;
  }
  selectAll.checked = checked.length === all.length;
  selectAll.indeterminate = checked.length > 0 && checked.length < all.length;
}

$('selectAllChk').addEventListener('change', () => {
  const checked = $('selectAllChk').checked;
  document.querySelectorAll('#apkTableBody input[type="checkbox"]:not(:disabled)').forEach((cb) => {
    cb.checked = checked;
  });
  updateSelectionInfo();
});

$('selectAllBtn').addEventListener('click', () => {
  document.querySelectorAll('#apkTableBody input[type="checkbox"]:not(:disabled)').forEach((cb) => {
    cb.checked = true;
  });
  updateSelectAllCheckbox();
  updateSelectionInfo();
});

$('clearSelectionBtn').addEventListener('click', () => {
  document.querySelectorAll('#apkTableBody input[type="checkbox"]').forEach((cb) => {
    cb.checked = false;
  });
  updateSelectAllCheckbox();
  updateSelectionInfo();
});

/* ============================================================
   Data loading
   ============================================================ */

async function refreshState() {
  const s = await api('/api/state');
  renderState(s);
}

async function loadConfig() {
  try {
    const c = await api('/api/config');
    $('apkSourcePath').textContent = c.apkDir;
  } catch {
    /* ignore */
  }
}

/* ============================================================
   Event handlers
   ============================================================ */

$('refreshDevicesBtn').addEventListener('click', async () => {
  setBusy(true);
  try {
    const r = await api('/api/devices/refresh', { method: 'POST' });
    const count = r && r.devices ? r.devices.length : 0;
    showToast(`Device list refreshed — ${count} device${count === 1 ? '' : 's'}`, 'success');
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    setBusy(false);
  }
});

$('scanNetworkBtn').addEventListener('click', async () => {
  setBusy(true);
  try {
    const r = await api('/api/network/scan', { method: 'POST' });
    const found = r && r.devices ? r.devices.length : 0;
    showToast(r.diagnostic || `Scan finished — ${found} device(s) found`, found > 0 ? 'success' : 'warning');
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    setBusy(false);
  }
});

/* ----- Folder Picker ----- */

$('chooseFolderBtn').addEventListener('click', async () => {
  // Use File System Access API if available (Chrome, Edge)
  if (window.showDirectoryPicker) {
    try {
      const dirHandle = await window.showDirectoryPicker();
      const apkFiles = [];
      for await (const entry of dirHandle.values()) {
        if (entry.kind === 'file' && entry.name.toLowerCase().endsWith('.apk')) {
          const file = await entry.getFile();
          apkFiles.push({ name: entry.name, size: file.size });
        }
      }
      if (apkFiles.length) {
        // Display discovered APKs from the selected folder
        state.apks = apkFiles.map((f) => ({
          name: f.name,
          path: f.name,
          size: f.size,
          status: 'pending',
          error: null,
        }));
        renderApks(state.apks);
        $('apkSourcePath').textContent = dirHandle.name;
        log('info', `Loaded ${apkFiles.length} APK(s) from folder: ${dirHandle.name}`);
      } else {
        showToast(`No APK files found in "${dirHandle.name}"`, 'warning');
      }
      return;
    } catch (e) {
      if (e.name === 'AbortError') return; // User cancelled
      /* fall through to fallback */
    }
  }

  // Fallback: use hidden file input with webkitdirectory
  $('folderPickerInput').click();
});

$('folderPickerInput').addEventListener('change', (e) => {
  const files = e.target.files;
  if (!files || !files.length) return;

  const apkFiles = [];
  for (const file of files) {
    if (file.name.toLowerCase().endsWith('.apk')) {
      apkFiles.push({
        name: file.name,
        path: file.name,
        size: file.size,
        status: 'pending',
        error: null,
      });
    }
  }

  if (apkFiles.length) {
    state.apks = apkFiles;
    renderApks(state.apks);
    // Try to get folder name from webkitRelativePath
    const firstPath = files[0].webkitRelativePath || '';
    const folderName = firstPath.includes('/')
      ? firstPath.substring(0, firstPath.lastIndexOf('/'))
      : 'Selected Folder';
    $('apkSourcePath').textContent = folderName;
    showToast(`Loaded ${apkFiles.length} APK(s) from ${folderName}`, 'success');
  } else {
    showToast('No APK files found in the selected folder', 'warning');
  }

  // Reset input so the same folder can be selected again
  e.target.value = '';
});

$('selectAllDevicesBtn').addEventListener('click', async () => {
  try {
    await api('/api/devices/select-all', { method: 'POST' });
    showToast('All devices selected', 'success');
  } catch (e) {
    showToast(e.message, 'error');
  }
});

$('deselectAllDevicesBtn').addEventListener('click', async () => {
  try {
    await api('/api/devices/deselect-all', { method: 'POST' });
    showToast('Device selection cleared', 'info');
  } catch (e) {
    showToast(e.message, 'error');
  }
});

$('disconnectSelectedBtn').addEventListener('click', async () => {
  const selected = state.devices.filter((d) => d.selected).map((d) => d.serial);
  if (!selected.length) return;
  const ok = await confirmDialog(
    'Disconnect Selected Devices',
    `Disconnect ${selected.length} device${selected.length === 1 ? '' : 's'} from ADB?`,
    'Disconnect'
  );
  if (!ok) return;
  setBusy(true);
  try {
    await api('/api/disconnect', {
      method: 'POST',
      body: JSON.stringify({ serials: selected }),
    });
    showToast(`Disconnected ${selected.length} device${selected.length === 1 ? '' : 's'}`, 'success');
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    setBusy(false);
  }
});

$('connectBtn').addEventListener('click', async () => {
  const mode = getConnectionMode();
  const payload = {
    ip: $('connIp').value,
    port: $('adbPort').value,
    mode: mode,
  };
  if (mode === 'pair') {
    payload.pairPort = $('pairPort').value;
  }

  setBusy(true);
  try {
    const endpoint = mode === 'smart' ? '/api/connect/smart' : '/api/connect';
    const r = await api(endpoint, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    if (r.success) {
      const serial = r.device && r.device.serial ? r.device.serial : `${$('connIp').value}:${payload.port}`;
      showToast(mode === 'smart' ? `Connected via ${r.mode === 'agent' ? 'Agent' : 'Manual ADB'}: ${serial}` : `Connected: ${serial}`, 'success');
      $('connIp').value = '';
      $('pairPort').value = '';
      $('adbPort').value = '';
      api('/api/apks').catch(() => {});
    }
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    setBusy(false);
  }
});

$('scanBtn').addEventListener('click', async () => {
  setBusy(true);
  try {
    const r = await api('/api/apks');
    const count = r && r.apks ? r.apks.length : 0;
    showToast(`Scanned ${count} APK(s)`, count > 0 ? 'success' : 'warning');
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    setBusy(false);
  }
});

$('installBtn').addEventListener('click', async () => {
  const selected = getSelectedApks();
  if (!selected.length) return;
  setBusy(true);
  try {
    const r = await api('/api/install', {
      method: 'POST',
      body: JSON.stringify({ apkPaths: selected.map((s) => s.path) }),
    });
    if (r.success) {
      showToast(`Installed ${r.succeeded}/${r.total} APK(s)`, 'success');
    } else {
      showToast(`Install finished with failures: ${r.succeeded}/${r.total} succeeded`, 'warning');
    }
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    setBusy(false);
  }
});

$('pushBtn').addEventListener('click', async () => {
  const selected = getSelectedApks();
  if (!selected.length) return;
  setBusy(true);
  try {
    await api('/api/push', {
      method: 'POST',
      body: JSON.stringify({ apkNames: selected.map((s) => s.name) }),
    });
    showToast('Push started — progress shown below', 'success');
  } catch (e) {
    /* includes "No Android device connected." */
    showToast(e.message, 'error');
  } finally {
    setBusy(false);
  }
});

$('appopsBtn').addEventListener('click', async () => {
  setBusy(true);
  try {
    const r = await api('/api/appops', { method: 'POST' });
    if (r.success) {
      showToast('AppOps permissions granted on all target devices', 'success');
    } else {
      showToast('AppOps finished with errors — check the Live Log', 'warning');
    }
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    setBusy(false);
  }
});

/* ----- Scrcpy ----- */

function updateScrcpyDeviceSelect() {
  const select = $('scrcpyDevice');
  if (!select) return;
  const currentValue = select.value;
  select.innerHTML = '<option value="">-- Select Device --</option>';
  state.devices
    .filter((d) => d.state === 'device')
    .forEach((d) => {
      const opt = document.createElement('option');
      opt.value = d.serial;
      opt.textContent = d.serial;
      select.appendChild(opt);
    });
  if (currentValue && state.devices.some((d) => d.serial === currentValue)) {
    select.value = currentValue;
  }
  updateScrcpyButtons();
}

function updateScrcpyButtons() {
  const deviceSerial = $('scrcpyDevice')?.value;
  const isRunning = deviceSerial && state.scrcpyRunning && state.scrcpyRunning.some((r) => r.serial === deviceSerial);
  const startBtn = $('scrcpyStartBtn');
  const stopBtn = $('scrcpyStopBtn');
  if (startBtn) startBtn.disabled = busyState || !deviceSerial || isRunning;
  if (stopBtn) stopBtn.disabled = busyState || !isRunning;
}

function renderScrcpySessions(running) {
  const el = $('scrcpyStatus');
  if (!el) return;
  if (!running || !running.length) {
    el.classList.add('hidden');
    el.className = 'scrcpy-status hidden';
    el.innerHTML = '';
    return;
  }
  el.className = 'scrcpy-status running';
  const title = document.createElement('div');
  title.className = 'scrcpy-status-title';
  title.textContent = `● Active sessions (${running.length})`;
  el.appendChild(title);
  running.forEach((r) => {
    const row = document.createElement('div');
    row.className = 'scrcpy-session';
    const serial = document.createElement('span');
    serial.textContent = r.serial;
    serial.title = r.serial;
    row.appendChild(serial);
    if (r.displayId !== null && r.displayId !== undefined) {
      const disp = document.createElement('span');
      disp.className = 'scrcpy-session-display';
      disp.textContent = `display ${r.displayId}`;
      row.appendChild(disp);
    }
    el.appendChild(row);
  });
}

async function loadScrcpyDisplays(deviceSerial) {
  const displaySelect = $('scrcpyDisplay');
  if (!displaySelect) return;
  displaySelect.innerHTML = '<option value="">Default</option>';
  if (!deviceSerial) return;
  try {
    const r = await api(`/api/scrcpy/displays?deviceSerial=${encodeURIComponent(deviceSerial)}`);
    if (r.success && r.displays) {
      r.displays.forEach((d) => {
        const opt = document.createElement('option');
        opt.value = d.id;
        opt.textContent = d.name || `Display ${d.id}`;
        displaySelect.appendChild(opt);
      });
    }
  } catch (e) {
    showToast(`Could not load displays: ${e.message}`, 'error');
  }
}

$('scrcpyDevice')?.addEventListener('change', () => {
  const serial = $('scrcpyDevice').value;
  loadScrcpyDisplays(serial);
  updateScrcpyButtons();
});

$('scrcpyStartBtn')?.addEventListener('click', async () => {
  const deviceSerial = $('scrcpyDevice').value;
  const displayId = $('scrcpyDisplay').value;
  if (!deviceSerial) {
    showToast('Please select a device to mirror', 'warning');
    return;
  }
  if (busyState) return;
  setBusy(true);
  try {
    await api('/api/scrcpy/start', {
      method: 'POST',
      body: JSON.stringify({ deviceSerial, displayId: displayId || undefined }),
    });
    showToast(`Mirroring started${displayId ? ` (display ${displayId})` : ''}: ${deviceSerial}`, 'success');
    updateScrcpyButtons();
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    setBusy(false);
  }
});

$('scrcpyStopBtn')?.addEventListener('click', async () => {
  const deviceSerial = $('scrcpyDevice').value;
  if (!deviceSerial) return;
  if (busyState) return;
  setBusy(true);
  try {
    await api('/api/scrcpy/stop', {
      method: 'POST',
      body: JSON.stringify({ deviceSerial }),
    });
    showToast(`Mirroring stopped: ${deviceSerial}`, 'info');
    updateScrcpyButtons();
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    setBusy(false);
  }
});

/* ----- Custom Command ----- */

function updateCommandDeviceSelect() {
  const select = $('commandDevice');
  if (!select) return;
  const currentValue = select.value;
  select.innerHTML = '<option value="">-- Select Device --</option>';
  state.devices
    .filter((d) => d.state === 'device')
    .forEach((d) => {
      const opt = document.createElement('option');
      opt.value = d.serial;
      opt.textContent = d.serial;
      select.appendChild(opt);
    });
  // Restore selection if still valid
  if (currentValue && state.devices.some((d) => d.serial === currentValue)) {
    select.value = currentValue;
  }
}

$('runCommandBtn').addEventListener('click', async () => {
  const command = $('customCommand').value.trim();
  if (!command) {
    showToast('Please enter a command', 'warning');
    $('customCommand').focus();
    return;
  }
  const deviceSerial = $('commandDevice').value;
  if (!deviceSerial) {
    showToast('Please select a target device', 'warning');
    return;
  }
  if (busyState) return;
  setBusy(true);
  const outputEl = $('commandOutput');
  outputEl.classList.remove('hidden');
  outputEl.innerHTML = '<div class="command-result"><strong>Running…</strong></div>';
  try {
    const r = await api('/api/command', {
      method: 'POST',
      body: JSON.stringify({ command, deviceSerial }),
    });
    if (r.success) {
      outputEl.innerHTML = `<div class="command-result success"><strong>✓ Success · ${escapeHtml(r.serial || '')}</strong><pre>${escapeHtml(r.output || '(no output)')}</pre></div>`;
    } else {
      outputEl.innerHTML = `<div class="command-result error"><strong>✗ Failed</strong><pre>${escapeHtml(r.error || 'Unknown error')}</pre></div>`;
    }
  } catch (e) {
    outputEl.innerHTML = `<div class="command-result error"><strong>✗ Error</strong><pre>${escapeHtml(e.message)}</pre></div>`;
  } finally {
    setBusy(false);
  }
});

/* Command suggestion chips fill the input */
document.querySelectorAll('.command-chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    $('customCommand').value = chip.dataset.cmd || '';
    $('customCommand').focus();
  });
});

$('setupBtn').addEventListener('click', async () => {
  const mode = getConnectionMode();
  const payload = {
    ip: $('connIp').value,
    adbPort: $('adbPort').value,
    mode: mode,
  };
  if (mode === 'pair') {
    payload.pairPort = $('pairPort').value;
  }

  setBusy(true);
  try {
    const r = await api('/api/setup', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    showToast(r.message || 'Setup started — watch the Live Log for progress', 'success');
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    setBusy(false);
  }
});

$('clearLogsBtn').addEventListener('click', () => {
  logPanel.innerHTML = '';
  userScrolling = false;
});

$('copyLogsBtn').addEventListener('click', async () => {
  const text = [...logPanel.children].map((l) => l.textContent).join('\n');
  try {
    await navigator.clipboard.writeText(text);
    $('copyLogsBtn').textContent = 'Copied!';
    setTimeout(() => { $('copyLogsBtn').textContent = 'Copy'; }, 1500);
  } catch {
    /* clipboard unavailable */
  }
});

/* ----- Browse modal ----- */

let browseCurrent = 'C:\\';

async function browse(dir) {
  const data = await api('/api/browse?dir=' + encodeURIComponent(dir));
  browseCurrent = data.path;
  $('browsePath').textContent = data.path;
  const list = $('browseList');
  list.innerHTML = '';

  const isDriveRoot = /^[A-Za-z]:\\$/.test(data.path);
  if (!isDriveRoot) {
    const up = document.createElement('button');
    up.className = 'browse-item';
    up.textContent = '↑ ..';
    up.onclick = () => browse(path_dirname(data.path));
    list.appendChild(up);
  }
  data.dirs.forEach((d) => {
    const b = document.createElement('button');
    b.className = 'browse-item';
    b.textContent = '📁 ' + d;
    b.onclick = () => browse(data.path + '\\' + d);
    list.appendChild(b);
  });
  data.files.forEach((f) => {
    const b = document.createElement('button');
    b.className = 'browse-item file';
    b.textContent = '📄 ' + f;
    b.onclick = () => {
      $('browseModal').classList.add('hidden');
      if (browseOnPick) {
        const full = data.path.endsWith('\\') ? data.path + f : data.path + '\\' + f;
        const cb = browseOnPick;
        browseOnPick = null;
        cb(full);
      }
    };
    list.appendChild(b);
  });
}

function path_dirname(p) {
  const i = p.lastIndexOf('\\');
  if (i <= 2) return p.substring(0, 3);
  return p.substring(0, i);
}

/* ---------- Browse modal ---------- */

let browseOnPick = null;

async function openBrowse(onPick) {
  browseOnPick = onPick || null;
  $('browseModal').classList.remove('hidden');
  try {
    await browse(browseCurrent);
  } catch (e) {
    showToast(e.message, 'error');
  }
}

function closeBrowse() {
  $('browseModal').classList.add('hidden');
  browseOnPick = null;
}

$('browseCancel').addEventListener('click', closeBrowse);
$('browseCancelBtn')?.addEventListener('click', closeBrowse);
$('browseModal').addEventListener('click', (e) => {
  if (e.target === $('browseModal')) closeBrowse();
});

/* ---------- Pairing dialog ---------- */

let pairingDevice = null;

function openPairingDialog(device) {
  pairingDevice = device || null;
  $('pairingModal').classList.remove('hidden');
  if (device) {
    $('pairingIp').value = device.ip || '';
    $('pairingPort').value = device.pairPort || '';
  }
  $('pairingCode').value = '';
  $('pairingCode').focus();
}

function closePairingDialog() {
  $('pairingModal').classList.add('hidden');
  pairingDevice = null;
}

$('pairingCancel')?.addEventListener('click', closePairingDialog);
$('pairingModal').addEventListener('click', (e) => {
  if (e.target === $('pairingModal')) closePairingDialog();
});

$('pairingOk')?.addEventListener('click', async () => {
  const ip = $('pairingIp').value.trim();
  const port = $('pairingPort').value.trim();
  const code = $('pairingCode').value.trim();

  if (!ip) { showToast('IP address is required', 'warning'); return; }
  if (!port) { showToast('Pairing port is required', 'warning'); return; }
  if (!code) { showToast('Pairing code is required', 'warning'); return; }
  if (!/^\d+$/.test(code) || code.length !== 6) {
    showToast('Pairing code must be exactly 6 digits', 'warning');
    return;
  }

  closePairingDialog();
  setBusy(true);
  try {
    // Try agent pairing first if agent is reachable
    if (pairingDevice && pairingDevice.agent && pairingDevice.agent.reachable) {
      const r = await api('/api/agent/pair', {
        method: 'POST',
        body: JSON.stringify({ ip, port, code }),
      });
      if (r.success) {
        showToast('Agent pairing successful — connecting...', 'success');
        await smartConnectDiscovered(pairingDevice, 5555);
        return;
      }
      // Agent pairing failed — fall back to manual
      showToast('Agent pairing failed, trying manual pairing...', 'warning');
    }

    // Manual pairing
    const r = await api('/api/network/pair', {
      method: 'POST',
      body: JSON.stringify({ deviceId: pairingDevice ? pairingDevice.id : undefined, ip, port, code }),
    });
    showToast(`Paired with ${ip} — connecting…`, 'success');
    if (pairingDevice) {
      await connectDiscoveredDevice(pairingDevice, undefined, true);
    }
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    setBusy(false);
  }
});

/* ---------- Settings dialog ---------- */

async function loadSettings() {
  try {
    const c = await api('/api/config');
    $('settingsAdbPath').value = c.adbPath && c.adbPath !== 'auto' ? c.adbPath : '';
    $('settingsApkDir').value = c.apkDir || '';
    const statusEl = $('settingsAdbStatus');
    if (c.adbStatus && c.adbStatus.available) {
      statusEl.className = 'adb-status ok';
      statusEl.textContent = `✓ ${c.adbStatus.version || 'ADB available'}`;
    } else {
      statusEl.className = 'adb-status missing';
      statusEl.textContent = `✗ ${(c.adbStatus && c.adbStatus.error) || 'ADB not found'}`;
    }
  } catch (e) {
    showToast(`Could not load settings: ${e.message}`, 'error');
  }
}

async function openSettings() {
  $('settingsModal').classList.remove('hidden');
  await loadSettings();
  $('settingsAdbPath').focus();
}

function closeSettings() {
  $('settingsModal').classList.add('hidden');
}

$('settingsBtn')?.addEventListener('click', openSettings);
$('settingsClose')?.addEventListener('click', closeSettings);
$('settingsCancel')?.addEventListener('click', closeSettings);
$('settingsModal').addEventListener('click', (e) => {
  if (e.target === $('settingsModal')) closeSettings();
});

$('settingsBrowseBtn')?.addEventListener('click', () => {
  openBrowse((filePath) => {
    $('settingsAdbPath').value = filePath;
  });
});

$('settingsApkScanBtn')?.addEventListener('click', async () => {
  const dir = $('settingsApkDir').value.trim();
  if (!dir) {
    showToast('Enter an APK folder path first', 'warning');
    return;
  }
  try {
    await api('/api/apks/set-folder', {
      method: 'POST',
      body: JSON.stringify({ folderPath: dir }),
    });
    const r = await api('/api/apks');
    $('apkSourcePath').textContent = dir;
    closeSettings();
    showToast(`Scanned ${r.apks ? r.apks.length : 0} APK(s) from ${dir}`, 'success');
  } catch (e) {
    showToast(e.message, 'error');
  }
});

$('settingsSave')?.addEventListener('click', async () => {
  const adbPath = $('settingsAdbPath').value.trim() || 'auto';
  const apkDir = $('settingsApkDir').value.trim();
  try {
    await api('/api/config', {
      method: 'POST',
      body: JSON.stringify({ adbPath, apkDir }),
    });
    if (apkDir) $('apkSourcePath').textContent = apkDir;
    closeSettings();
    showToast('Settings saved', 'success');
    await loadSettings();
  } catch (e) {
    showToast(e.message, 'error');
  }
});

/* ============================================================
   Sidebar navigation
   ============================================================ */

function setActiveNav(name) {
  document.querySelectorAll('.nav-item').forEach((b) => {
    b.classList.toggle('active', b.dataset.nav === name);
  });
}

let navScrollLock = 0;

document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    const nav = btn.dataset.nav;

    if (nav === 'settings') {
      openSettings();
      return;
    }

    navScrollLock = Date.now() + 750;
    if (btn.dataset.target) {
      const el = $(btn.dataset.target);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
    setActiveNav(nav);
  });
});

/* Returning to the top restores the Dashboard highlight */
window.addEventListener('scroll', () => {
  if (Date.now() < navScrollLock) return;
  if (window.scrollY < 40) setActiveNav('dashboard');
}, { passive: true });

/* Escape closes any open dialog */
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('browseModal').classList.contains('hidden')) closeBrowse();
  else if (!$('settingsModal').classList.contains('hidden')) closeSettings();
});

/* ============================================================
   Init
   ============================================================ */

let state = { devices: [], discoveredDevices: [], apks: [], appops: [], push: { running: false, files: [] }, setup: { running: false, result: null }, networkScan: { running: false, status: '', found: 0 }, selectedInterfaceId: null, networkInterfaces: [], scrcpyRunning: [] };


async function init() {
  initTheme();
  updateModeUI();
  await loadConfig();
  await refreshState();
  // Ensure device selectors are populated even if SSE hasn't fully synced
  updateScrcpyDeviceSelect();
  updateCommandDeviceSelect();
  // Load network interfaces
  try {
    const ifaceData = await api('/api/network/interfaces');
    state.networkInterfaces = ifaceData.interfaces || [];
    state.selectedInterfaceId = ifaceData.selectedId || null;
    renderNetworkInterfaces(state.networkInterfaces, state.selectedInterfaceId);
    updateNetworkVisuals();
  } catch {
    /* ignore */
  }
  await api('/api/devices/refresh', { method: 'POST' }).then(() => {
    updateScrcpyDeviceSelect();
    updateCommandDeviceSelect();
  }).catch(() => {});
}

init();
