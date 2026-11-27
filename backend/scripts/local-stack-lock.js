const { mkdir } = require('node:fs/promises');
const path = require('node:path');

async function acquireLauncher(repoRoot) {
  const { DatabaseSync } = require('node:sqlite');
  const directory = path.join(repoRoot, '.local');
  await mkdir(directory, { recursive: true, mode: 0o700 });

  // SQLite permits one writer per file. The OS releases the lock even if
  // the launcher is killed; keep the same file for subsequent launchers.
  const database = new DatabaseSync(path.join(directory, 'launcher.sqlite3'));
  try {
    database.exec('BEGIN IMMEDIATE');
  } catch (error) {
    database.close();
    if (error.errcode === 5) return null; // SQLITE_BUSY
    throw error;
  }

  let released = false;
  return () => {
    if (!released) {
      database.close();
      released = true;
    }
  };
}

module.exports = { acquireLauncher };
