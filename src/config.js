'use strict';

module.exports = {
  // WebSocket orchestrator port (localhost only)
  port: 3721,

  // Agent limits
  maxWorkers: 7,
  defaultWorkers: 3,

  // Claude CLI invocation
  claudeCmd: 'claude',
  claudeArgs: ['--dangerously-skip-permissions'],

  // How long to wait (ms) for the orchestrator to bind before launching terminal
  orchestratorStartDelay: 800,

  // Prefix patterns Claude uses to route messages
  sendPattern: /^\[SEND:([\w-]+)\]\s*([\s\S]+)/,
  broadcastPattern: /^\[BROADCAST\]\s*([\s\S]+)/,
};
