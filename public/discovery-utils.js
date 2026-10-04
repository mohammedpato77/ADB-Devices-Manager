'use strict';

// Shared by the browser and regression tests so result filtering stays local.
function discoveryTextMatches(item, query, fields) {
  const needle = String(query || '').trim().toLocaleLowerCase();
  if (!needle) return true;
  return fields.some((field) => String(item && item[field] != null ? item[field] : '')
    .toLocaleLowerCase().includes(needle));
}

function filterDiscoveryResults(items, query, fields) {
  return (items || []).filter((item) => discoveryTextMatches(item, query, fields));
}

function visibleNetworkInterfaces(items) {
  return (items || []).slice(0, 10);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { discoveryTextMatches, filterDiscoveryResults, visibleNetworkInterfaces };
}
