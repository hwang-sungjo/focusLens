const { statSync } = require('node:fs');
const path = require('node:path');

function defaultAiPython(repoRoot = path.resolve(__dirname, '../..')) {
  const executable = process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python';
  const python = path.join(repoRoot, '.local', 'ai-venv', executable);
  return statSync(python, { throwIfNoEntry: false })?.isFile() ? python : 'python3.11';
}

module.exports = { defaultAiPython };
