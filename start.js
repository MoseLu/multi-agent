'use strict';

/**
 * start.js — Entry point for the Multi-Agent Terminal System
 *
 * Usage:
 *   node start.js               # default 3 workers
 *   node start.js --workers=5   # 5 workers (max 7)
 *
 * Steps:
 *   1. Parse --workers argument
 *   2. Fork the orchestrator as a background process
 *   3. Wait for orchestrator to bind
 *   4. Launch Windows Terminal (wt.exe) with N+1 split panes
 */

const { program } = require('commander');
const { fork } = require('child_process');
const path = require('path');
const config = require('./src/config');
const { launch } = require('./src/launcher');

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
program
  .name('multi-agent')
  .description('Multi-agent terminal system — each pane runs a Claude CLI agent')
  .option('-w, --workers <n>', `Number of worker agents (1–${config.maxWorkers})`, String(config.defaultWorkers))
  .option('-p, --port <p>', 'Orchestrator WebSocket port', String(config.port))
  .parse(process.argv);

const opts = program.opts();
const workerCount = Math.min(Math.max(1, parseInt(opts.workers, 10) || config.defaultWorkers), config.maxWorkers);
const port = parseInt(opts.port, 10) || config.port;

console.log('');
console.log('  ╔══════════════════════════════════════════╗');
console.log('  ║       Multi-Agent Terminal System        ║');
console.log('  ╚══════════════════════════════════════════╝');
console.log(`  Workers  : ${workerCount}`);
console.log(`  Total    : ${workerCount + 1} panes (1 main + ${workerCount} workers)`);
console.log(`  WS port  : ${port}`);
console.log('');

// ---------------------------------------------------------------------------
// 1. Start orchestrator as a detached child process
// ---------------------------------------------------------------------------
const orchestratorPath = path.resolve(__dirname, 'src', 'orchestrator.js');

const orchestrator = fork(orchestratorPath, [], {
  detached: false, // keep alive as long as start.js is alive
  silent: false,   // let orchestrator print to this console
  env: { ...process.env, ORCHESTRATOR_PORT: String(port) },
});

orchestrator.on('error', (err) => {
  console.error('[start] Failed to fork orchestrator:', err.message);
  process.exit(1);
});

orchestrator.on('exit', (code) => {
  if (code !== 0) {
    console.error(`[start] Orchestrator exited with code ${code}`);
    process.exit(1);
  }
});

// ---------------------------------------------------------------------------
// 2. Wait for orchestrator to bind, then launch Windows Terminal
// ---------------------------------------------------------------------------
console.log(`[start] Starting orchestrator on port ${port}...`);

setTimeout(() => {
  console.log('[start] Launching Windows Terminal...');
  launch(workerCount, port);
  console.log('');
  console.log('[start] Windows Terminal launched. This process keeps the orchestrator alive.');
  console.log('[start] Press Ctrl+C to shut down all agents.');
}, config.orchestratorStartDelay);

// ---------------------------------------------------------------------------
// Keep alive & relay signals to orchestrator
// ---------------------------------------------------------------------------
process.on('SIGINT', () => {
  console.log('\n[start] Shutting down...');
  orchestrator.kill('SIGTERM');
  setTimeout(() => process.exit(0), 1000);
});

process.on('SIGTERM', () => {
  orchestrator.kill('SIGTERM');
  setTimeout(() => process.exit(0), 1000);
});
