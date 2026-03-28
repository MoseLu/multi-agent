'use strict';

/**
 * agent-runner.js — Runs inside each Windows Terminal pane.
 *
 * Uses Claude CLI in --print --output-format=stream-json --input-format=stream-json mode.
 * This gives structured JSON per token/event on stdout and accepts JSON user messages on stdin,
 * enabling reliable multi-turn operation without scraping interactive terminal output.
 *
 * Claude stdout events (one JSON per line):
 *   {"type":"content_block_delta","delta":{"type":"text_delta","text":"..."}}  — streaming token
 *   {"type":"message_stop"}  — response complete
 *   {"type":"message_start","message":{...}}  — new response starting
 *
 * Claude stdin input (one JSON per line):
 *   {"type":"user","message":{"role":"user","content":"..."}}
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
// ANSI color helpers
// ---------------------------------------------------------------------------
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';

// Limits to prevent memory overflow
const WS_QUEUE_MAX = 100;          // max queued WS messages while disconnected
const STREAM_BUFFER_MAX = 512 * 1024; // 512 KB max per Claude response buffer
const WS_RECONNECT_MAX_DELAY = 30000; // 30s ceiling for reconnect backoff
const WS_RECONNECT_MAX_ATTEMPTS = 20; // give up after ~10 min total

const COLORS = {
  main:     '\x1b[36m',  // cyan
  'worker-1': '\x1b[32m',  // green
  'worker-2': '\x1b[33m',  // yellow
  'worker-3': '\x1b[35m',  // magenta
  'worker-4': '\x1b[34m',  // blue
  'worker-5': '\x1b[91m',  // bright red
  'worker-6': '\x1b[92m',  // bright green
  'worker-7': '\x1b[93m',  // bright yellow
};

function color(id) {
  return COLORS[id] || '\x1b[37m';
}

function printHeader() {
  const c = color(agentId);
  const label = isMain ? 'Main Agent (user-facing)' : `${agentId}`;
  console.log(`${c}${BOLD}╔══════════════════════════════════════════╗${RESET}`);
  console.log(`${c}${BOLD}║  Multi-Agent System — ${label.padEnd(19)}║${RESET}`);
  console.log(`${c}${BOLD}╚══════════════════════════════════════════╝${RESET}`);
}

function printSystem(msg) {
  process.stdout.write(`${DIM}[system] ${msg}${RESET}\n`);
}

function printFromAgent(fromId, text) {
  const c = color(fromId);
  process.stdout.write(`\n${c}${BOLD}◀ [FROM:${fromId}]${RESET} ${text}\n`);
}

// ---------------------------------------------------------------------------
// System prompt loader
// ---------------------------------------------------------------------------
function buildWorkerList(n) {
  return Array.from({ length: n }, (_, i) => `worker-${i + 1}`).join(', ');
}

function loadPrompt() {
  const file = isMain ? 'main.txt' : 'worker.txt';
  const fullPath = path.resolve(__dirname, '..', 'prompts', file);
  try {
    return fs.readFileSync(fullPath, 'utf8')
      .replace(/\{id\}/g, agentId)
      .replace(/\{N\}/g, String(totalWorkers))
      .replace(/\{workers\}/g, buildWorkerList(totalWorkers));
  } catch {
    // Inline fallback
    return isMain ? inlineMainPrompt() : inlineWorkerPrompt();
  }
}

function inlineMainPrompt() {
  const workers = buildWorkerList(totalWorkers);
  return `You are the Main Coordinator Agent in a multi-agent terminal system.
Workers available: ${workers}.
To delegate: DISPATCH:<worker-id>:<task instruction>
Workers reply as RESPONSE:<worker-id>:<content>
Coordinate, delegate sub-tasks, synthesize results for the user.`;
}

function inlineWorkerPrompt() {
  return `You are ${agentId} in a multi-agent terminal system.
You receive task instructions and must respond with focused, actionable output.
Your responses are forwarded to the main agent. Be concise.`;
}

// ---------------------------------------------------------------------------
// WebSocket connection to orchestrator
// ---------------------------------------------------------------------------
let ws = null;
let wsReady = false;
const wsQueue = [];
let wsReconnectAttempts = 0;
let wsShuttingDown = false;

function connectOrchestrator() {
  ws = new WebSocket(`ws://127.0.0.1:${port}`);

  ws.on('open', () => {
    wsReady = true;
    wsReconnectAttempts = 0; // reset backoff counter on successful connection
    wsSend({ type: 'register', from: agentId, to: 'orchestrator', content: '' });
    wsQueue.splice(0).forEach(m => wsSend(m));
    printSystem(`Connected to orchestrator as "${agentId}"`);
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    handleWsMessage(msg);
  });

  ws.on('close', () => {
    wsReady = false;
    if (wsShuttingDown) return;
    wsReconnectAttempts++;
    if (wsReconnectAttempts > WS_RECONNECT_MAX_ATTEMPTS) {
      printSystem(`Orchestrator unreachable after ${WS_RECONNECT_MAX_ATTEMPTS} attempts — giving up.`);
      gracefulShutdown();
      return;
    }
    const delay = Math.min(1000 * Math.pow(2, wsReconnectAttempts - 1), WS_RECONNECT_MAX_DELAY);
    printSystem(`Disconnected. Reconnecting in ${Math.round(delay / 1000)}s (attempt ${wsReconnectAttempts})...`);
    setTimeout(connectOrchestrator, delay);
  });

  ws.on('error', (err) => {
    if (err.code !== 'ECONNREFUSED') printSystem(`WS error: ${err.message}`);
  });
}

function wsSend(msg) {
  if (wsReady && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  } else {
    if (wsQueue.length >= WS_QUEUE_MAX) {
      if (wsQueue.length === WS_QUEUE_MAX) {
        printSystem(`wsQueue at capacity (${WS_QUEUE_MAX}) — dropping oldest messages`);
      }
      wsQueue.shift();
    }
    wsQueue.push(msg);
  }
}

// ---------------------------------------------------------------------------
// Handle incoming WebSocket messages
// ---------------------------------------------------------------------------
function handleWsMessage(msg) {
  if (msg.type === 'system') {
    printSystem(msg.content);
    if (msg.content === 'shutdown') gracefulShutdown();
    return;
  }

  if (msg.type === 'message' || msg.type === 'broadcast') {
    // Targeted or broadcast message — show it and inject into Claude as context
    printFromAgent(msg.from, msg.content);
    injectUserMessage(`[FROM:${msg.from}]: ${msg.content}`);
    return;
  }
}

// ---------------------------------------------------------------------------
// Claude CLI process
// ---------------------------------------------------------------------------
let claudeProcess = null;
let streamBuffer = ''; // accumulates current response

function spawnClaude() {
  const systemPrompt = loadPrompt();

  claudeProcess = spawn(config.claudeCmd, config.claudeArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env },
  });

  claudeProcess.on('error', (err) => {
    console.error(`\x1b[31m[agent-runner] Claude CLI error: ${err.message}\x1b[0m`);
    console.error('\x1b[31mEnsure: npm install -g @anthropic-ai/claude-code\x1b[0m');
    process.exit(1);
  });

  claudeProcess.on('exit', (code, signal) => {
    printSystem(`Claude exited (code=${code}, signal=${signal})`);
    process.exit(code ?? 0);
  });

  // Forward stderr to our stderr (API errors, debug info)
  claudeProcess.stderr.on('data', (chunk) => {
    process.stderr.write(chunk);
  });

  // Parse Claude's structured JSON output line by line
  const rl = readline.createInterface({ input: claudeProcess.stdout, terminal: false });

  rl.on('line', (line) => {
    if (!line.trim()) return;
    let event;
    try { event = JSON.parse(line); } catch { return; }
    handleClaudeEvent(event);
  });

  // Inject system prompt as the very first user message
  injectUserMessage(systemPrompt);
}

/**
 * Write a user message to Claude's stdin in stream-json format.
 * Claude processes each JSON-line message and produces a response.
 */
function injectUserMessage(content) {
  if (!claudeProcess || !claudeProcess.stdin.writable) return;
  const msg = JSON.stringify({ type: 'user', message: { role: 'user', content } });
  claudeProcess.stdin.write(msg + '\n');
}

/**
 * Handle a structured JSON event from Claude's stdout.
 */
function handleClaudeEvent(event) {
  switch (event.type) {
    case 'content_block_delta': {
      const delta = event.delta?.text ?? event.delta?.partial_json ?? '';
      if (!delta) return;

      // Show in this pane
      process.stdout.write(delta);
      streamBuffer += delta;
      if (streamBuffer.length > STREAM_BUFFER_MAX) {
        // Keep the tail — routing directives (DISPATCH, SEND, BROADCAST) appear at the end
        streamBuffer = streamBuffer.slice(-STREAM_BUFFER_MAX);
        printSystem('streamBuffer exceeded cap — oldest content truncated');
      }
      break;
    }

    case 'message_stop': {
      // Response complete — parse for routing directives, then reset buffer
      const fullText = streamBuffer;
      streamBuffer = '';
      process.stdout.write('\n'); // newline after streamed response

      parseAndRouteDirectives(fullText);
      break;
    }

    case 'message_start':
    case 'content_block_start':
    case 'content_block_stop':
    case 'message_delta':
      // Structural events — no action needed
      break;

    default:
      // Unknown event — ignore
      break;
  }
}

/**
 * After a full response, scan for routing directives and send them via orchestrator.
 *
 * Supported syntax in Claude's output:
 *   DISPATCH:worker-N:task description   → targeted task to a worker
 *   [SEND:worker-N] message              → targeted message (legacy / explicit)
 *   [BROADCAST] message                  → message to all agents
 *
 * Workers implicitly send every response to main (handled in handleClaudeEvent).
 */
function parseAndRouteDirectives(text) {
  // DISPATCH pattern (primary dispatch for main agent)
  const dispatchRe = /DISPATCH:([\w-]+):([^\n]+)/g;
  let m;
  while ((m = dispatchRe.exec(text)) !== null) {
    const [, targetId, instruction] = m;
    wsSend({
      type: 'message',
      from: agentId,
      to: targetId,
      content: instruction.trim(),
      timestamp: new Date().toISOString(),
    });
  }

  // [SEND:id] pattern
  const sendRe = /\[SEND:([\w-]+)\]\s*([^\n\[]+)/g;
  while ((m = sendRe.exec(text)) !== null) {
    const [, targetId, content] = m;
    wsSend({
      type: 'message',
      from: agentId,
      to: targetId,
      content: content.trim(),
      timestamp: new Date().toISOString(),
    });
  }

  // [BROADCAST] pattern
  const broadcastRe = /\[BROADCAST\]\s*([^\n\[]+)/g;
  while ((m = broadcastRe.exec(text)) !== null) {
    wsSend({
      type: 'broadcast',
      from: agentId,
      to: 'all',
      content: m[1].trim(),
      timestamp: new Date().toISOString(),
    });
  }

  // Workers: auto-forward every complete response to main
  if (!isMain && text.trim()) {
    wsSend({
      type: 'message',
      from: agentId,
      to: 'main',
      content: text.trim(),
      timestamp: new Date().toISOString(),
    });
  }
}

// ---------------------------------------------------------------------------
// Bridge: user keyboard input → Claude stdin (main agent only)
// ---------------------------------------------------------------------------
function setupStdinBridge() {
  if (!isMain) return; // workers don't take keyboard input

  const rl = readline.createInterface({ input: process.stdin, terminal: false });

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    // Inject as a new user message to Claude
    injectUserMessage(trimmed);
    // Also broadcast to workers as context
    wsSend({
      type: 'broadcast',
      from: agentId,
      to: 'all',
      content: `[USER INPUT]: ${trimmed}`,
      timestamp: new Date().toISOString(),
    });
  });

  rl.on('close', gracefulShutdown);
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
function gracefulShutdown() {
  wsShuttingDown = true;
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

setTimeout(() => {
  spawnClaude();
  setupStdinBridge();
}, 500);
