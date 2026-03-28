'use strict';

/**
 * Orchestrator — WebSocket message broker
 *
 * Runs as a standalone process (forked by start.js).
 * All agent-runner instances connect here and exchange messages.
 *
 * Message types (JSON):
 *   register   — agent announces its ID on connect
 *   message    — targeted: { from, to: "agent-id", content }
 *   broadcast  — to all:   { from, to: "all", content }
 *   stream     — live stdout chunk: { from, to: "all", content }
 *   system     — orchestrator → agents (shutdown, notice, etc.)
 */

const { WebSocketServer } = require('ws');
const config = require('./config');

const port = parseInt(process.env.ORCHESTRATOR_PORT || config.port, 10);

// Map<agentId, WebSocket>
const agents = new Map();

const wss = new WebSocketServer({ host: '127.0.0.1', port });

wss.on('listening', () => {
  console.log(`[orchestrator] listening on ws://127.0.0.1:${port}`);
});

wss.on('connection', (ws) => {
  let agentId = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return; // ignore malformed frames
    }

    switch (msg.type) {
      case 'register': {
        agentId = msg.from;
        agents.set(agentId, ws);
        console.log(`[orchestrator] registered: ${agentId} (total: ${agents.size})`);
        // Notify all others that a new agent joined
        broadcast(
          { type: 'system', from: 'orchestrator', to: 'all', content: `${agentId} joined` },
          agentId
        );
        break;
      }

      case 'message': {
        // Targeted — forward to specific agent
        const target = agents.get(msg.to);
        if (target && target.readyState === 1 /* OPEN */) {
          target.send(JSON.stringify(msg));
        }
        break;
      }

      case 'broadcast': {
        // Forward to everyone except the sender
        broadcast(msg, msg.from);
        break;
      }

      case 'stream':
        // Stream messages are dropped — broadcasting per-token deltas caused WS flood / OOM
        break;

      default:
        break;
    }
  });

  ws.on('close', () => {
    if (agentId) {
      agents.delete(agentId);
      console.log(`[orchestrator] disconnected: ${agentId} (remaining: ${agents.size})`);
      broadcast(
        { type: 'system', from: 'orchestrator', to: 'all', content: `${agentId} left` },
        agentId
      );
    }
  });

  ws.on('error', (err) => {
    console.error(`[orchestrator] ws error (${agentId}):`, err.message);
  });
});

wss.on('error', (err) => {
  console.error('[orchestrator] server error:', err.message);
  process.exit(1);
});

/**
 * Send a message to all connected agents except the sender.
 * @param {object} msg
 * @param {string} excludeId
 */
function broadcast(msg, excludeId) {
  const payload = JSON.stringify(msg);
  for (const [id, ws] of agents) {
    if (id !== excludeId && ws.readyState === 1 /* OPEN */) {
      ws.send(payload);
    }
  }
}

// Graceful shutdown
process.on('SIGTERM', () => {
  broadcast({ type: 'system', from: 'orchestrator', to: 'all', content: 'shutdown' }, null);
  wss.close(() => process.exit(0));
});
process.on('SIGINT', () => {
  broadcast({ type: 'system', from: 'orchestrator', to: 'all', content: 'shutdown' }, null);
  wss.close(() => process.exit(0));
});
