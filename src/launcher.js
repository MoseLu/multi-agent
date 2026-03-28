'use strict';

/**
 * launcher.js — Build and execute the Windows Terminal (wt.exe) command.
 *
 * Layout strategy:
 *   1 worker  → 2 panes: main | worker-1  (horizontal split)
 *   2 workers → 3 panes: main | worker-1 / worker-2  (main left, workers stacked right)
 *   3 workers → 4 panes: 2×2 grid
 *   4 workers → 5 panes: main left full-height | 4 workers stacked right
 *   5–7 workers → main left, workers fill right in a column
 *
 * wt.exe CLI reference:
 *   wt [new-tab] [--title T] [shell args] [; split-pane [-H|-V] [--title T] [shell args]]
 *
 *   -H  split horizontally (new pane below)
 *   -V  split vertically   (new pane to the right)
 */

const { spawn } = require('child_process');
const path = require('path');
const config = require('./config');

/**
 * Build the wt.exe argument array for N workers.
 * @param {number} workerCount  1–7
 * @param {number} port         orchestrator WS port
 * @returns {string[]}
 */
function buildWtArgs(workerCount, port) {
  const root = path.resolve(__dirname, '..');
  // The shell command each pane executes
  const paneCmd = (id) =>
    `node "${path.join(root, 'src', 'agent-runner.js')}" --id=${id} --workers=${workerCount} --port=${port}`;

  // Each segment is one wt clause: { action, title, cmd }
  const segments = [];

  // First pane — always the main agent (opens as new-tab)
  segments.push({ action: 'new-tab', title: 'Main Agent', cmd: paneCmd('main') });

  for (let i = 1; i <= workerCount; i++) {
    const split = chooseSplit(i, workerCount);
    segments.push({ action: 'split-pane', split, title: `Worker ${i}`, cmd: paneCmd(`worker-${i}`) });
  }

  return buildArgArray(segments);
}

/**
 * Decide -H (horizontal / below) or -V (vertical / right) for worker pane i.
 *
 * Layout rules:
 *   1 worker  : -V  (side by side)
 *   2 workers : worker-1 → -V, worker-2 → -H (stacked right column)
 *   3 workers : alternating column grid
 *   4+ workers: all -H (stack in right column, main stays left via first -V)
 */
function chooseSplit(workerIndex, total) {
  if (total === 1) return '-V';
  if (total === 2) return workerIndex === 1 ? '-V' : '-H';
  if (total === 3) {
    // 2×2 grid: first split right, then each column splits down
    return workerIndex === 1 ? '-V' : '-H';
  }
  // 4–7: first split opens right column, rest stack downward in that column
  return workerIndex === 1 ? '-V' : '-H';
}

/**
 * Convert segment descriptors into a flat wt argument array.
 * wt clauses are separated by `;` (as separate args).
 */
function buildArgArray(segments) {
  const args = [];

  segments.forEach((seg, idx) => {
    if (idx > 0) args.push(';');

    if (seg.action === 'new-tab') {
      args.push('new-tab');
    } else {
      args.push('split-pane');
      if (seg.split) args.push(seg.split);
    }

    args.push('--title', seg.title);

    // Shell: cmd /k keeps the window open after the node process exits
    args.push('cmd', '/k', seg.cmd);
  });

  return args;
}

/**
 * Launch Windows Terminal with the constructed split-pane layout.
 * @param {number} workerCount
 * @param {number} port
 */
function launch(workerCount, port) {
  const clampedWorkers = Math.min(Math.max(1, workerCount), config.maxWorkers);
  const args = buildWtArgs(clampedWorkers, port);

  console.log('[launcher] Starting Windows Terminal...');
  console.log('[launcher] wt.exe', args.join(' '));

  const wt = spawn('wt.exe', args, {
    detached: true,
    stdio: 'ignore',
    shell: false,
    windowsHide: false,
  });

  wt.on('error', (err) => {
    console.error('[launcher] Failed to start wt.exe:', err.message);
    console.error('[launcher] Make sure Windows Terminal is installed and wt.exe is in PATH.');
    process.exit(1);
  });

  wt.unref();
}

module.exports = { launch, buildWtArgs };
