'use strict';

/**
 * agent-runner.js — Runs inside each Windows Terminal pane.
 *
 * Responsibilities:
 *   1. Connect to the orchestrator WebSocket
 *   2. Spawn the Claude CLI process
 *   3. Inject the system prompt so Claude knows its role and the message protocol
 *   4. Bridge stdin (user keyboard) → Claude stdin
 *   5. Bridge Claude stdout → display in pane + stream to orchestrator
 *   6. Parse Claude stdout for [SEND:id] / [BROADCAST] directives and route them
 *   7. Receive incoming messages from orchestrator → inject into Claude stdin
 */

const { program } = require('commander');
const { spawn } = require('child_process');
const readline = require('readline');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const config = require('./config');

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
program
  .requiredOption('--id <id>', 'Agent ID (main | worker-N)')
  .requiredOption('--workers <n>', 'Total number of worker agents')
  .option('--port <p>', 'Orchestrator port', String(config.port))
  .parse(process.argv);

const { id: agentId, workers: workersStr, port: portStr } = program.opts();
const totalWorkers = parseInt(workersStr, 10);
const port = parseInt(portStr, 10);
const isMain = agentId === 'main';

// ---------------------------------------------------------------------------
// Terminal styling helpers (ANSI)
// ---------------------------------------------------------------------------
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';
const MAGENTA = '\x1b[35m';
const RED = '\x1b[31m';

function agentColor(id) {
  if (id === 'main') return CYAN;
  // cycle through colors for workers
  const colors = [GREEN, YELLOW, MAGENTA, '\x1b[34m', '\x1b[35m', '\x1b[91m', '\x1b[92m'];
  const n = parseInt(id.replace('worker-', ''), 10) - 1;
  return colors[n % colors.length];
}

function printHeader() {
  const color = agentColor(agentId);
  console.log(`${color}${BOLD}╔════════════════════════════════════════╗${RESET}`);
  console.log(`${color}${BOLD}║  Multi-Agent System — ${agentId.padEnd(17)}║${RESET}`);
  console.log(`${color}${BOLD}╚════════════════════════════════════════╝${RESET}`);
  console.log(`${DIM}Connecting to orchestrator on port ${port}...${RESET}`);
}

function printIncoming(fromId, content) {
  const color = agentColor(fromId);
  process.stdout.write(`\n${color}${BOLD}[FROM:${fromId}]${RESET} ${content}\n`);
}

function printSystem(content) {
  process.stdout.write(`${DIM}[system] ${content}${RESET}\n`);
}

// ---------------------------------------------------------------------------
// Load system prompt
// ---------------------------------------------------------------------------
function loadPrompt() {
  const promptFile = isMain ? 'main.txt' : 'worker.txt';
  const promptPath = path.resolve(__dirname, '..', 'prompts', promptFile);

  let template;
  try {
    template = fs.readFileSync(promptPath, 'utf8');
  } catch {
    // Fallback inline prompt if file not found
    template = isMain
      ? defaultMainPrompt(totalWorkers)
      : defaultWorkerPrompt(agentId, totalWorkers);
    return template;
  }

  // Replace placeholders
  return template
    .replace(/\{id\}/g, agentId)
    .replace(/\{N\}/g, String(totalWorkers))
    .replace(/\{workers\}/g, buildWorkerList(totalWorkers));
}

function buildWorkerList(n) {
  return Array.from({ length: n }, (_, i) => `worker-${i + 1}`).join(', ');
}

function defaultMainPrompt(n) {
  return `You are the Main Coordinator Agent in a multi-agent terminal system.
You have ${n} coworker agent(s) available: ${buildWorkerList(n)}.

COMMUNICATION PROTOCOL:
- To send a task to a specific agent, begin your message with: [SEND:worker-N] your message
- To broadcast a message to ALL workers, begin with: [BROADCAST] your message
- Workers' responses arrive prefixed with [FROM:worker-N]

Your role:
1. Receive tasks from the user
2. Break them down and delegate sub-tasks to appropriate workers using [SEND:] or [BROADCAST]
3. Synthesize workers' results and present a final answer to the user

Be concise and coordinate effectively. Workers are capable Claude agents.`;
}

function defaultWorkerPrompt(id, n) {
  return `You are ${id} in a multi-agent terminal system.
The main coordinator and ${n - 1} peer agent(s) are also running.

COMMUNICATION PROTOCOL:
- Messages from other agents arrive prefixed with [FROM:agent-id]
- To reply to the main agent or any peer: [SEND:main] or [SEND:worker-N] your message
- To broadcast to everyone: [BROADCAST] your message
- Normal responses (no prefix) are automatically forwarded to the main agent

Your role:
- Execute the specific sub-task assigned to you
- Report results clearly and concisely
- Collaborate with peer agents when needed`;
}

// ---------------------------------------------------------------------------
// WebSocket connection to orchestrator
// ---------------------------------------------------------------------------
let ws;
let wsReady = false;
const messageQueue = []; // queue messages while WS is connecting

function connectOrchestrator() {
  ws = new WebSocket(`ws://127.0.0.1:${port}`);

  ws.on('open', () => {
    wsReady = true;
    // Register this agent
    wsSend({ type: 'register', from: agentId, to: 'orchestrator', content: '' });
    // Flush queued messages
    while (messageQueue.length) wsSend(messageQueue.shift());
    printSystem(`Connected to orchestrator as "${agentId}"`);
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    handleIncoming(msg);
  });

  ws.on('close', () => {
    wsReady = false;
    printSystem('Disconnected from orchestrator. Reconnecting in 2s...');
    setTimeout(connectOrchestrator, 2000);
  });

  ws.on('error', (err) => {
    // Error is followed by 'close', reconnect handled there
    if (err.code !== 'ECONNREFUSED') {
      printSystem(`WS error: ${err.message}`);
    }
  });
}

function wsSend(msg) {
  if (wsReady && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  } else {
    messageQueue.push(msg);
  }
}

/**
 * Handle a message arriving from the orchestrator.
 * Inject it into Claude's stdin so Claude can see it and respond.
 */
function handleIncoming(msg) {
  if (msg.type === 'system') {
    printSystem(msg.content);
    if (msg.content === 'shutdown') {
      gracefulShutdown();
    }
    return;
  }

  if (msg.type === 'stream') {
    // Live output from another agent — display but don't inject into Claude
    // (avoids feedback loops; only targeted messages get injected)
    const color = agentColor(msg.from);
    process.stdout.write(`${color}${DIM}[${msg.from}] ${msg.content}${RESET}`);
    return;
  }

  if (msg.type === 'message' || msg.type === 'broadcast') {
    printIncoming(msg.from, msg.content);
    // Inject into Claude as context
    if (claudeProcess && claudeProcess.stdin.writable) {
      claudeProcess.stdin.write(`\n[FROM:${msg.from}]: ${msg.content}\n`);
    }
  }
}

// ---------------------------------------------------------------------------
// Claude CLI process
// ---------------------------------------------------------------------------
let claudeProcess = null;
let claudeBuffer = '';

function spawnClaude() {
  const systemPrompt = loadPrompt();

  claudeProcess = spawn(config.claudeCmd, config.claudeArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env },
  });

  claudeProcess.on('error', (err) => {
    console.error(`${RED}[agent-runner] Failed to start Claude CLI: ${err.message}${RESET}`);
    console.error(`${RED}Make sure "claude" is installed: npm install -g @anthropic-ai/claude-code${RESET}`);
    process.exit(1);
  });

  claudeProcess.on('exit', (code, signal) => {
    console.log(`\n${DIM}[agent-runner] Claude exited (code=${code}, signal=${signal})${RESET}`);
    process.exit(code ?? 0);
  });

  // Write system prompt as the very first input to Claude
  claudeProcess.stdin.write(systemPrompt + '\n');

  // Stream Claude's stdout: display locally + relay to orchestrator
  claudeProcess.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    process.stdout.write(text); // display in this pane

    // Buffer for directive parsing (newline-delimited)
    claudeBuffer += text;
    const lines = claudeBuffer.split('\n');
    claudeBuffer = lines.pop(); // keep incomplete last line

    for (const line of lines) {
      parseAndRoute(line);
    }

    // Stream chunks to all other agents (so they see live output)
    wsSend({ type: 'stream', from: agentId, to: 'all', content: text, timestamp: new Date().toISOString() });
  });

  // Forward Claude's stderr to our stderr
  claudeProcess.stderr.on('data', (chunk) => {
    process.stderr.write(chunk);
  });
}

/**
 * Parse a line of Claude output for routing directives.
 * Removes the directive from the forwarded stream content is fine —
 * the raw stdout is already displayed. We just extract and send.
 */
function parseAndRoute(line) {
  const trimmed = line.trim();

  // [SEND:target-id] message
  const sendMatch = trimmed.match(config.sendPattern);
  if (sendMatch) {
    const [, targetId, content] = sendMatch;
    wsSend({
      type: 'message',
      from: agentId,
      to: targetId,
      content: content.trim(),
      timestamp: new Date().toISOString(),
    });
    return;
  }

  // [BROADCAST] message
  const broadcastMatch = trimmed.match(config.broadcastPattern);
  if (broadcastMatch) {
    const content = broadcastMatch[1].trim();
    wsSend({
      type: 'broadcast',
      from: agentId,
      to: 'all',
      content,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  // For worker agents: non-directive lines are implicitly sent to main
  if (!isMain && trimmed.length > 0) {
    wsSend({
      type: 'message',
      from: agentId,
      to: 'main',
      content: trimmed,
      timestamp: new Date().toISOString(),
    });
  }
}

// ---------------------------------------------------------------------------
// Bridge: user keyboard → Claude stdin
// ---------------------------------------------------------------------------
function setupStdinBridge() {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });

  rl.on('line', (line) => {
    if (claudeProcess && claudeProcess.stdin.writable) {
      claudeProcess.stdin.write(line + '\n');
    }
  });

  rl.on('close', () => {
    gracefulShutdown();
  });
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
function gracefulShutdown() {
  if (claudeProcess) {
    try { claudeProcess.stdin.end(); } catch {}
  }
  if (ws) {
    try { ws.close(); } catch {}
  }
  setTimeout(() => process.exit(0), 500);
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
printHeader();
connectOrchestrator();

// Give the WS connection a moment before spawning Claude
setTimeout(() => {
  spawnClaude();
  setupStdinBridge();
}, 500);
