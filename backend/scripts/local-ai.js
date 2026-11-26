const { spawn } = require('node:child_process');
const path = require('node:path');
const { constants } = require('node:os');

const python = process.env.FOCUSLENS_AI_PYTHON || process.env.AI3_PYTHON || process.env.AI2_PYTHON || 'python3.11';
const child = spawn(python, ['-B', path.join(__dirname, 'local_ai.py'), ...process.argv.slice(2)], {
  cwd: path.resolve(__dirname, '../..'), stdio: 'inherit',
});
child.on('error', () => {
  console.error('Set FOCUSLENS_AI_PYTHON to a Python 3.11 environment with the AI dependencies installed.');
  process.exitCode = 1;
});
const forwarders = new Map(['SIGINT', 'SIGTERM'].map(signal => {
  const forward = () => child.kill(signal);
  process.on(signal, forward);
  return [signal, forward];
}));
child.on('exit', (code, signal) => {
  for (const [name, forward] of forwarders) process.removeListener(name, forward);
  process.exitCode = code ?? (128 + (constants.signals[signal] || 1));
});
