import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const BACKUP_VERSION = 1;
const DEFAULT_BATCH_SIZE = 1000;
const MAX_LIST_PAGE_SIZE = 99;
const DEFAULT_RETRY_ATTEMPTS = 5;
const DEFAULT_RETRY_DELAY_MS = 250;

function getEnv(name, fallback = undefined) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return value;
}

export function getConfiguredNamespace(env = process.env) {
  return env.PINECONE_NAMESPACE === undefined ? '__default__' : env.PINECONE_NAMESPACE;
}

export function getIndexMetric(indexDescription, indexStats) {
  const metric = indexDescription?.metric ?? indexStats?.metric;
  if (typeof metric !== 'string' || metric.trim() === '') {
    throw new Error('Unable to determine source index metric from Pinecone metadata');
  }
  return metric;
}

function requireEnv(name, fallback = undefined) {
  const value = getEnv(name, fallback);
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${name}`);
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

function timestampForPath(date = new Date()) {
  return date.toISOString().replace(/[:]/g, '-');
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, JSON.stringify(value, null, 2));
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

async function writeVectorBatch(backupDir, fileNumber, records, exported) {
  const fileName = `vectors-${String(fileNumber).padStart(4, '0')}.json`;
  await writeJson(path.join(backupDir, fileName), records);
  console.log(`Wrote ${fileName} (${records.length} vectors, total ${exported})`);
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

function resolveBackupNamespace(stats, requestedNamespace) {
  const namespaces = stats.namespaces ?? {};

  if (namespaces[requestedNamespace] !== undefined) {
    return {
      namespace: requestedNamespace,
      vectorCount: namespaces[requestedNamespace]?.recordCount ?? namespaces[requestedNamespace]?.vectorCount ?? 0,
    };
  }

  if (requestedNamespace === '__default__' && namespaces[''] !== undefined) {
    return {
      namespace: '',
      vectorCount: namespaces['']?.recordCount ?? namespaces['']?.vectorCount ?? 0,
    };
  }

  if (requestedNamespace === '' && namespaces.__default__ !== undefined) {
    return {
      namespace: '__default__',
      vectorCount: namespaces.__default__?.recordCount ?? namespaces.__default__?.vectorCount ?? 0,
    };
  }

  return {
    namespace: requestedNamespace,
    vectorCount: namespaces[requestedNamespace]?.recordCount ?? namespaces[requestedNamespace]?.vectorCount ?? 0,
  };
}

async function getIndex(pc, indexName) {
  const description = await pc.describeIndex(indexName);
  if (getEnv('PINECONE_MODE', 'local') !== 'local') {
    return {
      description,
      index: pc.index(indexName),
    };
  }
  const host = resolveLocalIndexHost(description.host);
  return {
    description,
    index: pc.index(indexName, host),
  };
}

async function main() {
  const indexName = requireEnv('PINECONE_INDEX_NAME', 'contextmcp-docs');
  const backupRoot = getEnv('BACKUP_ROOT', path.resolve(process.cwd(), 'backups'));
  const batchSize = parsePositiveInteger(
    getEnv('BACKUP_BATCH_SIZE', String(DEFAULT_BATCH_SIZE)),
    'BACKUP_BATCH_SIZE'
  );
  const namespace = getConfiguredNamespace();

  const backupDir = path.join(backupRoot, `${indexName}-${timestampForPath()}`);
  await ensureDir(backupDir);

  const pc = await makePinecone();
  const { description, index } = await getIndex(pc, indexName);
  const stats = await withRetry('describeIndexStats', () => index.describeIndexStats());
  const namespaceInfo = resolveBackupNamespace(stats, namespace);
  const dimension = stats.dimension ?? Number.parseInt(requireEnv('OLLAMA_DIMENSIONS', '768'), 10);
  const metric = getIndexMetric(description, stats);

  const indexMeta = {
    version: BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    indexName,
    namespace: namespaceInfo.namespace,
    dimension,
    metric,
    vectorCount: namespaceInfo.vectorCount,
    batchSize,
  };
  await writeJson(path.join(backupDir, 'index.json'), indexMeta);

  console.log(`Backup target: ${backupDir}`);
  console.log(`Index: ${indexName}`);
  console.log(`Namespace: ${JSON.stringify(namespaceInfo.namespace)}`);
  console.log(`Vectors reported by index stats: ${namespaceInfo.vectorCount}`);

  const namespaceIndex = index.namespace(namespaceInfo.namespace);
  const listPageSize = Math.min(batchSize, MAX_LIST_PAGE_SIZE);
  let token = undefined;
  let fileNumber = 1;
  let exported = 0;
  let pendingRecords = [];

  do {
    const listResponse = await withRetry('listPaginated', () =>
      namespaceIndex.listPaginated({
        prefix: '',
        limit: listPageSize,
        ...(token ? { paginationToken: token } : {}),
      })
    );

    const ids = listResponse.vectors?.map(v => v.id) ?? [];
    if (ids.length > 0) {
      const fetched = await withRetry('fetch', () => namespaceIndex.fetch(ids));
      const records = Object.values(fetched.records ?? {}).map(record => ({
        id: record.id,
        values: record.values,
        metadata: record.metadata ?? {},
      }));

      pendingRecords.push(...records);
      while (pendingRecords.length >= batchSize) {
        const batch = pendingRecords.slice(0, batchSize);
        exported += batch.length;
        await writeVectorBatch(backupDir, fileNumber, batch, exported);
        pendingRecords = pendingRecords.slice(batchSize);
        fileNumber += 1;
      }
    }

    token = listResponse.pagination?.next;
  } while (token);

  if (pendingRecords.length > 0) {
    exported += pendingRecords.length;
    await writeVectorBatch(backupDir, fileNumber, pendingRecords, exported);
  }

  console.log(`Backup complete: ${exported} vectors exported`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack : error);
    process.exit(1);
  });
}
