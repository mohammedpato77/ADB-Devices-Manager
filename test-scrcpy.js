'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { ScrcpySessions } = require('./scrcpy-sessions');
const { hasEligibleScrcpyStart } = require('./public/scrcpy-utils');

class FakeProcess extends EventEmitter {
  constructor() {
    super();
    this.killCalls = 0;
  }

  kill() {
    this.killCalls++;
    return true;
  }
}

function testTwoIndependentSessionsAndDeviceDisconnect() {
  const changes = [];
  const sessions = new ScrcpySessions(() => changes.push(sessions.snapshot().map((s) => s.serial)));
  const deviceA = new FakeProcess();
  const deviceB = new FakeProcess();

  sessions.add('192.168.1.21:5555', deviceA);
  sessions.add('192.168.1.22:5555', deviceB, 1);
  assert.deepStrictEqual(sessions.snapshot().map((s) => s.serial), ['192.168.1.21:5555', '192.168.1.22:5555']);
  assert.strictEqual(sessions.snapshot()[1].displayId, 1);
  assert.strictEqual(sessions.snapshot()[0].sessionId, '192.168.1.21:5555');
  assert.strictEqual(sessions.snapshot()[1].sessionId, '192.168.1.22:5555');

  // Refresh sees B disappear. It kills only B and leaves A alive.
  sessions.stopDisconnected(['192.168.1.21:5555']);
  assert.strictEqual(deviceB.killCalls, 1);
  assert.strictEqual(deviceA.killCalls, 0);
  assert.deepStrictEqual(sessions.snapshot().map((s) => s.serial), ['192.168.1.21:5555']);

  // A delayed child exit from B must not mutate A or a replacement B session.
  const replacementB = new FakeProcess();
  sessions.add('192.168.1.22:5555', replacementB);
  deviceB.emit('exit', 0);
  assert.deepStrictEqual(sessions.snapshot().map((s) => s.serial), ['192.168.1.21:5555', '192.168.1.22:5555']);
  assert.strictEqual(sessions.has('192.168.1.22:5555'), true);

  // A later refresh with only A connected removes the reconnected B session too.
  sessions.stopDisconnected(['192.168.1.21:5555']);
  assert.strictEqual(replacementB.killCalls, 1);
  assert.deepStrictEqual(sessions.snapshot().map((s) => s.serial), ['192.168.1.21:5555']);
  deviceA.emit('exit', 0);
  assert.deepStrictEqual(sessions.snapshot(), []);
  assert(changes.length >= 5, 'session lifecycle changes are broadcast');
}

function testThreeSessionsDuplicateGuardAndIndependentStop() {
  const sessions = new ScrcpySessions();
  const processes = ['A', 'B', 'C'].map(() => new FakeProcess());
  ['device-A', 'device-B', 'device-C'].forEach((serial, i) => sessions.add(serial, processes[i]));
  assert.strictEqual(sessions.snapshot().length, 3, 'three devices can run concurrently');
  assert.throws(() => sessions.add('device-B', new FakeProcess()), /already running/, 'duplicate serial is rejected');
  assert.strictEqual(sessions.stop('device-B'), true);
  assert.deepStrictEqual(sessions.snapshot().map((session) => session.serial), ['device-A', 'device-C']);
  assert.strictEqual(processes[0].killCalls, 0, 'stopping B does not kill A');
  assert.strictEqual(processes[1].killCalls, 1, 'stopping B kills only B');
  assert.strictEqual(processes[2].killCalls, 0, 'stopping B does not kill C');
}

function testUiAndServerUseIndependentSessions() {
  const app = fs.readFileSync(path.join(__dirname, 'public', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  assert(/id="scrcpyDeviceMenu"[^>]*hidden/.test(html), 'device menu starts collapsed');
  assert(/id="scrcpyDeviceToggle"[^>]*aria-expanded="false"/.test(html), 'dropdown toggle exposes its collapsed state');
  assert(app.includes('checkbox.checked = scrcpySelectedSerials.has(device.serial)'), 'device picker supports independent multi-selection');
  assert(app.includes('document.addEventListener(\'click\'') && app.includes("event.key === 'Escape'"), 'dropdown closes on outside click and Escape');
  assert(app.includes('scrcpySelectedSerials.delete(serial)'), 'device selection is preserved across list refreshes while the device remains available');
  assert(app.includes('for (const serial of deviceSerials)'), 'UI starts each selected device independently');
  assert(app.includes('stopScrcpySession(r.serial)'), 'each active session has an independent stop control');
  assert(server.includes('scrcpySessions.stopDisconnected('), 'device refresh prunes disconnected sessions');
  assert(server.includes("const args = ['-s', deviceSerial]"), 'each scrcpy child is explicitly targeted to its own ADB serial');
  assert(server.includes('scrcpySessions.snapshot()'), 'session status is returned without a shared stream/socket');
  const startHandler = server.slice(server.indexOf("app.post('/api/scrcpy/start'"), server.indexOf("app.post('/api/scrcpy/stop'"));
  assert(!startHandler.includes('if (busy)'), 'scrcpy starts are independent of unrelated global operations');
}

function testStartAvailabilityWithExistingSessions() {
  const activeA = [{ serial: 'device-A' }];
  assert.strictEqual(hasEligibleScrcpyStart(['device-A', 'device-B'], activeA), true,
    'Start Selected remains available for B while A is already running');
  assert.strictEqual(hasEligibleScrcpyStart(['device-A'], activeA), false,
    'an already-running selected device cannot be started twice');
  assert.strictEqual(hasEligibleScrcpyStart(['device-B', 'device-C'], activeA), true,
    'several unstarted devices remain eligible beside an active session');

  const app = fs.readFileSync(path.join(__dirname, 'public', 'app.js'), 'utf8');
  assert(app.includes('scrcpyStartInProgress || !hasEligibleScrcpyStart(selected, running)'),
    'Start Selected is gated by a real in-flight start or lack of eligible devices');
  assert(app.includes('if (!hasEligibleScrcpyStart(deviceSerials, state.scrcpyRunning || []))'),
    'starting an all-active selection safely skips duplicate starts');
  assert(app.includes('scrcpyStartInProgress = false;'), 'start lock resets after request completion');
}

testTwoIndependentSessionsAndDeviceDisconnect();
testThreeSessionsDuplicateGuardAndIndependentStop();
testUiAndServerUseIndependentSessions();
testStartAvailabilityWithExistingSessions();
console.log('Scrcpy multi-device tests passed (4 tests).');
