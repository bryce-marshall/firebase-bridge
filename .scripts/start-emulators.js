#!/usr/bin/env node
/**
 * Start Firebase Emulators in a NEW terminal window, per-OS.
 * - Windows: opens PowerShell window (stays open; Ctrl+C to stop)
 * - macOS:   opens Terminal.app tab/window
 * - Linux:   opens gnome-terminal (adjust if you use a different terminal)
 *
 * Usage:
 *   node ./.scripts/start-emulators.js [--only firestore,auth] [--project yourId] [...]
 *
 * Notes:
 * - Uses `npx firebase ...` so you don’t need a global firebase-tools install.
 * - Change `emulatorDir` below if you want a different working dir.
 */
const { exec } = require('child_process');
const path = require('path');
const os = require('os');

const emulatorArgs = process.argv.slice(2).join(' ');
const emulatorDir = path.resolve(__dirname, '..');
const platform = os.platform();

console.log('Starting Firebase emulators from:', emulatorDir);
console.log('With raw args:', emulatorArgs);

let launchCmd = null;

if (platform === 'win32') {
  launchCmd = `start powershell -NoExit -Command "Set-Location '${emulatorDir}'; firebase emulators:start ${emulatorArgs}"`;
} else if (platform === 'darwin') {
  const fullCmd = `cd '${emulatorDir}' && firebase emulators:start ${emulatorArgs}`;
  launchCmd = `osascript -e 'tell app "Terminal" to do script "${fullCmd.replace(/"/g, '\\"')}"'`;
} else if (platform === 'linux') {
  const fullCmd = `cd '${emulatorDir}' && firebase emulators:start ${emulatorArgs}`;
  launchCmd = `gnome-terminal -- bash -c '${fullCmd}; exec bash'`;
}

if (launchCmd) {
  exec(launchCmd, (error) => {
    if (error) {
      console.error('Failed to launch Firebase emulators:', error.message);
    }
  });
} else {
  console.error('Unsupported OS for automatic terminal launch.');
}
