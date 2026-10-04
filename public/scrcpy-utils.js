'use strict';

// Keep Start Selected available whenever at least one selected ADB serial does
// not already own a scrcpy session. Existing sessions do not block new ones.
function hasEligibleScrcpyStart(selectedSerials, runningSessions) {
  const runningSerials = new Set((runningSessions || []).map((session) => session.serial));
  return (selectedSerials || []).some((serial) => !runningSerials.has(serial));
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { hasEligibleScrcpyStart };
}
