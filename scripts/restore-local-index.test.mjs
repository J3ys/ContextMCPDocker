import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import * as restoreScript from './restore-local-index.mjs';

test('resolveBackupDir defaults to the latest valid backup when BACKUP_DIR is unset', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'restore-local-index-'));

  try {
    const backupsRoot = path.join(tempRoot, 'backups');
    const olderBackup = path.join(backupsRoot, 'contextmcp-docs-2026-07-31T13-51-17.846Z');
    const newerBackup = path.join(backupsRoot, 'contextmcp-docs-2026-08-01T09-00-00.000Z');

    await fs.mkdir(olderBackup, { recursive: true });
    await fs.mkdir(newerBackup, { recursive: true });
    await fs.writeFile(path.join(olderBackup, 'index.json'), '{}');
    await fs.writeFile(path.join(newerBackup, 'index.json'), '{}');

    assert.equal(typeof restoreScript.resolveBackupDir, 'function');

    const resolved = await restoreScript.resolveBackupDir({}, tempRoot);

    assert.equal(resolved, newerBackup);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
