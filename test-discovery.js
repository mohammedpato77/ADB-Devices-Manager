'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { filterDiscoveryResults, visibleNetworkInterfaces } = require('./public/discovery-utils');

const devices = [
  { ip: '192.168.100.25', name: 'Pixel', serial: '192.168.100.25:5555' },
  { ip: '192.168.100.26', name: 'Tablet', serial: '192.168.100.26:5555' },
  { ip: '10.0.0.8', name: 'Phone', serial: 'usb-123' },
];
const deviceFields = ['ip', 'name', 'serial', 'id'];

assert.deepStrictEqual(filterDiscoveryResults(devices, '192.168.100.25', deviceFields).map((d) => d.name), ['Pixel']);
assert.deepStrictEqual(filterDiscoveryResults(devices, '192.168', deviceFields).map((d) => d.name), ['Pixel', 'Tablet']);
assert.deepStrictEqual(filterDiscoveryResults(devices, '100.25', deviceFields).map((d) => d.name), ['Pixel']);
assert.deepStrictEqual(filterDiscoveryResults(devices, '192.168.100.', deviceFields).map((d) => d.name), ['Pixel', 'Tablet']);
assert.deepStrictEqual(filterDiscoveryResults(devices, '', deviceFields), devices, 'clearing search restores all results');
assert.deepStrictEqual(filterDiscoveryResults(devices, 'no-such-host', deviceFields), [], 'non-matching query returns no results');
assert.deepStrictEqual(filterDiscoveryResults([{ name: 'Ethernet', ip: '192.168.100.1' }], 'ETHERNET', ['name', 'ip']).length, 1, 'text search is case-insensitive');

const manyInterfaces = Array.from({ length: 13 }, (_, i) => ({ name: `eth${i}`, ip: `192.168.${i}.2` }));
assert.strictEqual(visibleNetworkInterfaces(manyInterfaces).length, 10, 'display caps real interfaces at ten');
assert.strictEqual(visibleNetworkInterfaces(manyInterfaces.slice(0, 4)).length, 4, 'fewer available interfaces are preserved');
assert.strictEqual(visibleNetworkInterfaces([]).length, 0, 'empty interface list remains empty');

const app = fs.readFileSync(path.join(__dirname, 'public', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, 'public', 'style.css'), 'utf8');
const searchHandler = app.slice(app.indexOf("$('discoverySearch')?.addEventListener('input'"), app.indexOf('/* ----- Folder Picker ----- */'));
assert(searchHandler.includes('renderDiscoveredDevices') && searchHandler.includes('renderNetworkInterfaces'), 'search filters both result lists');
assert(!searchHandler.includes("'/api/network/scan'"), 'typing in search does not start a scan');
assert(app.includes('window.__adbSetupInitialDiscoveryStarted'), 'initial scan has a page-level once guard');
assert(app.includes('runNetworkDiscovery(false).catch'), 'startup runs the existing scan API and handles failures');
assert(app.includes("$('scanNetworkBtn').addEventListener('click'"), 'manual scan button remains wired');
const scanHandler = app.slice(app.indexOf('async function runNetworkDiscovery'), app.indexOf("$('discoverySearch')?.addEventListener('input'"));
assert(scanHandler.includes("api('/api/network/scan', { method: 'POST' })"), 'scan uses the registered POST API');
assert(scanHandler.includes('result.devices') && scanHandler.includes('result.interfaces') && scanHandler.includes('result.selected'), 'successful scan response directly refreshes UI state');
assert(scanHandler.includes('running: true') && scanHandler.includes('running: false'), 'loading state resets on success and failure');
assert(scanHandler.includes('Network discovery failed:'), 'scan errors are exposed to the UI');
const interfaceRenderer = app.slice(app.indexOf('function renderNetworkInterfaces'), app.indexOf('function updateDiscoverySearchEmpty'));
assert(interfaceRenderer.includes('visibleNetworkInterfaces(filterDiscoveryResults(interfaces'), 'search runs against real interfaces before display cap');
const deviceRenderer = app.slice(app.indexOf('function renderDiscoveredDevices'), app.indexOf('function renderAgentIntegration'));
assert(deviceRenderer.includes('matchingDevices.forEach'), 'all matching real subnet hosts are rendered without a premature small-result cap');
assert(html.includes('id="discoverySearchEmpty"'), 'no-match state is present');
assert(/device-list-container[^\n]*max-height[^\n]*overflow-y:\s*auto/.test(css), 'connected device list is bounded and scrollable');

console.log('Network discovery search and layout tests passed (13 assertions).');
