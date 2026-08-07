import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

function getEnv(name, fallback = undefined) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return value;
}

const DEFAULT_RETRY_ATTEMPTS = 5;
const DEFAULT_RETRY_DELAY_MS = 250;
const DEFAULT_UPSERT_BATCH_SIZE = 50;

export function getRestoreNamespace(env = process.env, backupNamespace) {
  return env.PINECONE_NAMESPACE === undefined ? backupNamespace : env.PINECONE_NAMESPACE;
}

export function assertIndexShape(indexName, existingDescription, expectedDimension, expectedMetric) {
  if (existingDescription.dimension !== undefined && existingDescription.dimension !== expectedDimension) {
    throw new Error(
      `Target index ${indexName} dimension mismatch: backup requires ${expectedDimension}, existing index has ${existingDescription.dimension}`
    );
  }
  if (existingDescription.metric !== undefined && existingDescription.metric !== expectedMetric) {
    throw new Error(
      `Target index ${indexName} metric mismatch: backup requires ${expectedMetric}, existing index has ${existingDescription.metric}`
    );
  }
}

export async function resolveBackupDir(env = process.env, cwd = process.cwd()) {
  if (env.BACKUP_DIR !== undefined && env.BACKUP_DIR !== '') {
    return env.BACKUP_DIR;
  }

  const backupRoot = path.resolve(cwd, env.BACKUP_ROOT === undefined || env.BACKUP_ROOT === '' ? 'backups' : env.BACKUP_ROOT);

  let entries;
  try {
    entries = await fs.readdir(backupRoot, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      throw new Error(`No backups found: backup root does not exist at ${backupRoot}`);
    }
    throw new Error(`Failed to inspect backup root ${backupRoot}: ${error instanceof Error ? error.message : error}`);
  }

  const backupDirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(backupRoot, entry.name);
    try {
      await fs.access(path.join(candidate, 'index.json'));
      backupDirs.push(candidate);
    } catch {
      // Ignore directories that are not valid backup folders.
    }
  }

  if (backupDirs.length === 0) {
    throw new Error(`No backups found: no backup folders with index.json under ${backupRoot}`);
  }

  backupDirs.sort((left, right) => path.basename(right).localeCompare(path.basename(left)));
  return backupDirs[0];
}

function requireEnv(name, fallback = undefined) {
  const value = getEnv(name, fallback);
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf-8'));
}

function isRetryableError(error) {
  return error instanceof Error && error.name === 'PineconeConnectionError';
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withRetry(label, fn) {
  let attempt = 1;
  while (true) {
    try {
      return await fn();
    } catch (error) {
      if (!isRetryableError(error) || attempt >= DEFAULT_RETRY_ATTEMPTS) {
        throw error;
      }
      console.warn(
        `Retrying ${label} after transient connection failure (${attempt}/${DEFAULT_RETRY_ATTEMPTS - 1})`
      );
      await sleep(DEFAULT_RETRY_DELAY_MS * attempt);
      attempt += 1;
    }
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRequiredInteger(value, fieldName, { min = Number.MIN_SAFE_INTEGER } = {}) {
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`Invalid index metadata: ${fieldName} must be an integer >= ${min}`);
  }
  return value;
}

function parseRequiredString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Invalid index metadata: ${fieldName} must be a non-empty string`);
  }
  return value;
}

function parsePositiveInteger(rawValue, fieldName) {
  const value = Number.parseInt(rawValue, 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid ${fieldName}: expected a positive integer, got ${JSON.stringify(rawValue)}`);
  }
  return value;
}

function parseNamespace(value) {
  if (typeof value !== 'string') {
    throw new Error('Invalid index metadata: namespace must be a string');
  }
  return value;
}

async function loadIndexMeta(backupDir) {
  const indexPath = path.join(backupDir, 'index.json');
  let indexMeta;
  try {
    indexMeta = await readJson(indexPath);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      throw new Error(`Backup metadata file not found: ${indexPath}`);
    }
    throw new Error(`Failed to read backup metadata ${indexPath}: ${error instanceof Error ? error.message : error}`);
  }

  if (!isPlainObject(indexMeta)) {
    throw new Error('Invalid index metadata: index.json must contain a JSON object');
  }

  parseRequiredInteger(indexMeta.version, 'version', { min: 1 });
  parseRequiredString(indexMeta.createdAt, 'createdAt');
  if (Number.isNaN(Date.parse(indexMeta.createdAt))) {
    throw new Error('Invalid index metadata: createdAt must be a valid date-time string');
  }

  return {
    version: indexMeta.version,
    createdAt: indexMeta.createdAt,
    indexName: parseRequiredString(indexMeta.indexName, 'indexName'),
    namespace: parseNamespace(indexMeta.namespace),
    dimension: parseRequiredInteger(indexMeta.dimension, 'dimension', { min: 1 }),
    metric: parseRequiredString(indexMeta.metric, 'metric'),
    vectorCount: parseRequiredInteger(indexMeta.vectorCount, 'vectorCount', { min: 0 }),
    batchSize: parseRequiredInteger(indexMeta.batchSize, 'batchSize', { min: 1 }),
  };
}

async function listVectorFiles(backupDir, vectorCount) {
  const files = (await fs.readdir(backupDir))
    .filter(file => /^vectors-\d{4}\.json$/.test(file))
    .sort();

  if (vectorCount > 0 && files.length === 0) {
    throw new Error(`Backup is incomplete: expected vector batch files in ${backupDir} for vectorCount=${vectorCount}`);
  }

  return files;
}

function validateVectorRecord(record, file, index) {
  if (!isPlainObject(record)) {
    throw new Error(`Malformed vector payload in ${file} at index ${index}: record must be an object`);
  }
  if (typeof record.id !== 'string' || record.id.trim() === '') {
    throw new Error(`Malformed vector payload in ${file} at index ${index}: id must be a non-empty string`);
  }
  if (!Array.isArray(record.values) || record.values.length === 0 || record.values.some(value => typeof value !== 'number' || !Number.isFinite(value))) {
    throw new Error(`Malformed vector payload in ${file} at index ${index}: values must be a non-empty array of finite numbers`);
  }
  if (!isPlainObject(record.metadata)) {
    throw new Error(`Malformed vector payload in ${file} at index ${index}: metadata must be an object`);
  }
}

async function validateVectorFiles(backupDir, files) {
  let totalRecords = 0;
  for (const file of files) {
    const filePath = path.join(backupDir, file);
    let records;
    try {
      records = await readJson(filePath);
    } catch (error) {
      throw new Error(`Failed to read vector payload ${filePath}: ${error instanceof Error ? error.message : error}`);
    }

    if (!Array.isArray(records)) {
      throw new Error(`Malformed vector payload in ${file}: expected a JSON array`);
    }

    records.forEach((record, index) => validateVectorRecord(record, file, index));
    totalRecords += records.length;
  }

  return totalRecords;
}

async function makePinecone() {
  const { Pinecone } = await import('@pinecone-database/pinecone');
  const mode = getEnv('PINECONE_MODE', 'local');
  if (mode === 'local') {
    return new Pinecone({
      apiKey: getEnv('PINECONE_API_KEY', 'pclocal'),
      controllerHostUrl: getEnv('PINECONE_CONTROLLER_HOST', 'http://localhost:5080'),
    });
  }
  return new Pinecone({ apiKey: requireEnv('PINECONE_API_KEY') });
}

function resolveLocalIndexHost(host) {
  const rawHost = host.startsWith('http') ? host : `http://${host}`;
  const url = new URL(rawHost);

  if (url.hostname === 'pinecone') {
    const controllerUrl = new URL(getEnv('PINECONE_CONTROLLER_HOST', 'http://localhost:5080'));
    url.protocol = controllerUrl.protocol;
    url.hostname = controllerUrl.hostname;
  }

  return url.toString().replace(/\/$/, '');
}

async function getIndex(pc, indexName) {
  if (getEnv('PINECONE_MODE', 'local') !== 'local') {
    return pc.index(indexName);
  }
  const description = await pc.describeIndex(indexName);
  const host = resolveLocalIndexHost(description.host);
  return pc.index(indexName, host);
}

async function ensureIndex(pc, indexName, dimension, metric) {
  const indexes = await pc.listIndexes();
  const exists = indexes.indexes?.some(index => index.name === indexName);
  if (!exists) {
    await pc.createIndex({
      name: indexName,
      dimension,
      metric,
      spec: {
        serverless: {
          cloud: 'aws',
          region: 'us-east-1',
        },
      },
    });
    return;
  }

  const description = await pc.describeIndex(indexName);
  assertIndexShape(indexName, description, dimension, metric);
}

async function main() {
  const backupDir = await resolveBackupDir(process.env, process.cwd());
  const indexMeta = await loadIndexMeta(backupDir);
  const targetIndexName = getEnv('RESTORE_INDEX_NAME', indexMeta.indexName);
  const namespace = getRestoreNamespace(process.env, indexMeta.namespace);
  const clearFirst = getEnv('RESTORE_CLEAR_FIRST', 'true') !== 'false';
  const upsertBatchSize = parsePositiveInteger(
    getEnv('RESTORE_UPSERT_BATCH_SIZE', String(DEFAULT_UPSERT_BATCH_SIZE)),
    'RESTORE_UPSERT_BATCH_SIZE'
  );
  const files = await listVectorFiles(backupDir, indexMeta.vectorCount);
  const validatedRecordCount = await validateVectorFiles(backupDir, files);
  if (validatedRecordCount !== indexMeta.vectorCount) {
    throw new Error(
      `Backup record count mismatch: index.json declares ${indexMeta.vectorCount} vectors for namespace ${JSON.stringify(indexMeta.namespace)}, but vector files contain ${validatedRecordCount}`
    );
  }

  const pc = await makePinecone();
  await ensureIndex(pc, targetIndexName, indexMeta.dimension, indexMeta.metric);
  const index = await getIndex(pc, targetIndexName);
  const namespaceIndex = index.namespace(namespace);

  if (clearFirst) {
    await withRetry('deleteAll', () => namespaceIndex.deleteAll());
  }

  let restored = 0;
  for (const file of files) {
    const records = await readJson(path.join(backupDir, file));
    if (records.length === 0) continue;
    for (let offset = 0; offset < records.length; offset += upsertBatchSize) {
      const batch = records.slice(offset, offset + upsertBatchSize);
      await withRetry(`upsert ${file} batch ${offset / upsertBatchSize + 1}`, () => namespaceIndex.upsert(batch));
      restored += batch.length;
    }
    console.log(`Restored ${file} (${records.length} vectors, total ${restored})`);
  }

  if (restored !== indexMeta.vectorCount) {
    throw new Error(
      `Restore incomplete: restored ${restored} vectors into ${targetIndexName} for namespace ${JSON.stringify(namespace)}, expected ${indexMeta.vectorCount}`
    );
  }

  console.log(`Restore complete: ${restored} vectors restored into ${targetIndexName}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack : error);
    process.exit(1);
  });
}
