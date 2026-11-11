/**
 * @fileoverview Database helper module for STAC crawler using PostgreSQL connection pool
 * Provides functions for database initialization, collection/catalog management, and connection handling
 * @module utils/db
 * 
 * Exports:
 * - initDb() - Initialize and test database connection
 * - insertOrUpdateCatalog() - Process catalog (currently skips saving)
 * - insertOrUpdateCollection() - Insert or update STAC collection with retry logic
 * - close() - Close database connection pool
 * - pool - PostgreSQL connection pool instance
 */
import pkg from 'pg';
const { Pool } = pkg;
import dotenv from 'dotenv';
dotenv.config();

const pool = new Pool({
  host: process.env.PGHOST,
  port: parseInt(process.env.PGPORT, 10),
  user: process.env.PGUSER ,
  password: process.env.PGPASSWORD ,
  database: process.env.PGDATABASE ,
  max: 10,
});

/**
 * Initialize and test database connection
 * Tests the connection by executing a simple query and logs the result
 * @async
 * @function initDb
 * @returns {Promise<void>}
 * @throws {Error} If database connection fails
 */
async function initDb() {
  const host = process.env.PGHOST;
  const port = parseInt(process.env.PGPORT, 10);
  const database = process.env.PGDATABASE;
  const user = process.env.PGUSER;
  
  // Test database connection
  let client;
  try {
    client = await pool.connect();
    await client.query('SELECT 1');
    console.log(`DB connection established successfully to ${host}:${port}/${database}`);
  } catch (error) {
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.error('DATABASE CONNECTION FAILED');
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.error(`  Host:     ${host}`);
    console.error(`  Port:     ${port}`);
    console.error(`  Database: ${database}`);
    console.error(`  User:     ${user}`);
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.error(`  Error:    ${error.message}`);
    if (error.code) {
      console.error(`  Code:     ${error.code}`);
    }
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    throw error;
  } finally {
    if (client) {
      client.release();
    }
  }
}

/**
 * Process a catalog for traversal only - catalogs are not saved to database
 * Only collections are saved. Catalogs are only used to traverse deeper into the tree.
 * @param {Object} catalog - STAC catalog object
 * @returns {Promise<null>} always returns null (no catalog saved)
 */
async function insertOrUpdateCatalog(catalog) {
  if (!catalog || typeof catalog !== 'object') return null;
  
  // Catalogs are not saved to database - only used for tree traversal
  // Only collections will be saved
  console.log(`Skipping catalog save (used for traversal only): ${catalog.title || catalog.id}`);
  
  return null;
}

/**
 * Insert or update a catalog/API entry in crawllog_catalog table
 * This stores the URL queue for re-crawling and the slug for stac_id generation
 * @param {Object} catalogInfo - Catalog info object
 * @param {string} catalogInfo.slug - The STAC Index slug for this catalog
 * @param {string} catalogInfo.url - The source URL of the catalog/API
 * @param {boolean} catalogInfo.isApi - Whether this is an API (true) or static catalog (false)
 * @returns {Promise<number>} The crawllog_catalog id
 */
async function saveCrawllogCatalog(catalogInfo) {
  if (!catalogInfo || !catalogInfo.url) {
    throw new Error('Catalog info with url is required');
  }

  const { slug, url, isApi = false } = catalogInfo;
  
  const result = await pool.query(
    `INSERT INTO crawllog_catalog (slug, source_url, is_api, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (source_url) DO UPDATE SET
       slug = COALESCE(EXCLUDED.slug, crawllog_catalog.slug),
       is_api = EXCLUDED.is_api
     RETURNING id`,
    [slug || null, url, isApi]
  );
  
  return result.rows[0].id;
}

/**
 * Get all catalogs from crawllog_catalog for re-crawling
 * @param {Object} options - Query options
 * @param {boolean} options.isApi - If provided, filter by API status
 * @returns {Promise<Array>} Array of catalog objects with id, slug, source_url, is_api
 */
async function getCrawllogCatalogs(options = {}) {
  let query = 'SELECT id, slug, source_url, is_api, created_at, updated_at FROM crawllog_catalog';
  const params = [];
  
  if (options.isApi !== undefined) {
    query += ' WHERE is_api = $1';
    params.push(options.isApi);
  }
  
  query += ' ORDER BY id';
  
  const result = await pool.query(query, params);
  return result.rows.map(row => ({
    id: row.id,
    slug: row.slug,
    url: row.source_url,
    isApi: row.is_api,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
}

/**
 * Get crawllog_catalog ids that still have pending queue entries
 * @param {Object} options
 * @param {boolean} options.isApi - If provided, filter by API status
 * @returns {Promise<Array<number>>} Array of crawllog_catalog ids
 */
async function getCrawllogCatalogIdsWithPendingQueue(options = {}) {
  let query = `
    SELECT DISTINCT cc.crawllog_catalog_id
    FROM crawllog_collection cc
    JOIN crawllog_catalog c ON c.id = cc.crawllog_catalog_id
    WHERE cc.source_url IS NOT NULL
      AND cc.collection_id IS NULL
  `;
  const params = [];

  if (options.isApi !== undefined) {
    query += ' AND c.is_api = $1';
    params.push(options.isApi);
  }

  const result = await pool.query(query, params);
  return result.rows.map(row => row.crawllog_catalog_id);
}

/**
 * Get the crawllog_catalog id for a given source URL
 * @param {string} sourceUrl - The source URL to look up
 * @returns {Promise<number|null>} The crawllog_catalog id or null if not found
 */
async function getCrawllogCatalogIdByUrl(sourceUrl) {
  if (!sourceUrl) return null;
  
  const result = await pool.query(
    'SELECT id FROM crawllog_catalog WHERE source_url = $1',
    [sourceUrl]
  );
  
  return result.rows.length > 0 ? result.rows[0].id : null;
}

/**
 * Get the slug for a given crawllog_catalog id
 * Used to generate stac_id for collections
 * @param {number} crawllogCatalogId - The crawllog_catalog id
 * @returns {Promise<string|null>} The slug or null if not found
 */
async function getSlugByCrawllogCatalogId(crawllogCatalogId) {
  if (!crawllogCatalogId) return null;
  
  const result = await pool.query(
    'SELECT slug FROM crawllog_catalog WHERE id = $1',
    [crawllogCatalogId]
  );
  
  return result.rows.length > 0 ? result.rows[0].slug : null;
}

/**
 * Get already-crawled collection URLs for a given catalog (best-effort)
 * Used for pause/resume functionality - skip URLs that have already been processed
 * NOTE: crawllog_collection is used as a queue only; crawled URLs live in collection.source_url
 * @param {number} crawllogCatalogId - The crawllog_catalog id
 * @returns {Promise<Set<string>>} Set of source URLs already in collection
 */
async function getCrawledCollectionUrls(crawllogCatalogId) {
  if (!crawllogCatalogId) return new Set();

  const catalogResult = await pool.query(
    'SELECT source_url FROM crawllog_catalog WHERE id = $1',
    [crawllogCatalogId]
  );

  if (catalogResult.rows.length === 0) return new Set();

  const catalogUrl = catalogResult.rows[0].source_url;
  const likePattern = `${catalogUrl.replace(/\/$/, '')}/collections/%`;

  const result = await pool.query(
    'SELECT source_url FROM collection WHERE source_url IS NOT NULL AND (source_url = $1 OR source_url LIKE $2)',
    [catalogUrl, likePattern]
  );

  return new Set(result.rows.map(row => row.source_url));
}

/**
 * Id of the crawl cycle (full re-crawl) the current run belongs to.
 * When set, a collection only counts as "already crawled" if it was written at or after the
 * start of that cycle. When null (resume mode), any collection in the table counts as crawled.
 * @type {number|null}
 */
let currentCycleId = null;

/**
 * Set (or clear) the crawl cycle used by isCollectionUrlCrawled
 * @param {number|null} cycleId - crawl_cycle id, or null for resume mode
 */
function setCurrentCycle(cycleId) {
  currentCycleId = cycleId || null;
}

/**
 * Check if a specific collection URL has already been crawled
 * In resume mode: true if the URL exists in the collection table.
 * In a full re-crawl (see setCurrentCycle): true only if it was refreshed during the current cycle.
 * Timestamps are compared inside Postgres to avoid timezone conversions.
 * @param {string} sourceUrl - The source URL to check
 * @returns {Promise<boolean>} True if the URL should be skipped
 */
async function isCollectionUrlCrawled(sourceUrl) {
  if (!sourceUrl) return false;
  
  const result = currentCycleId
    ? await pool.query(
        `SELECT 1 FROM collection
         WHERE source_url = $1
           AND updated_at >= (SELECT started_at FROM crawl_cycle WHERE id = $2)
         LIMIT 1`,
        [sourceUrl, currentCycleId]
      )
    : await pool.query(
        'SELECT 1 FROM collection WHERE source_url = $1 LIMIT 1',
        [sourceUrl]
      );
  
  return result.rows.length > 0;
}

// ========================================
// CRAWL CYCLES (full re-crawl, see db/init/08_tables_crawl_cycle.sql)
// ========================================

/**
 * Map a crawl_cycle row to a JS object
 * @param {Object} row
 * @returns {Object|null}
 */
function mapCycle(row) {
  if (!row) return null;
  return {
    id: row.id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: row.status,
    overran: row.overran,
    // Milliseconds until started_at + intervalDays (negative if already overdue)
    msUntilDue: row.ms_until_due !== undefined && row.ms_until_due !== null ? Number(row.ms_until_due) : undefined,
    // Duration in milliseconds (finished cycles) or elapsed time so far (running cycles)
    durationMs: row.duration_ms !== undefined && row.duration_ms !== null ? Number(row.duration_ms) : undefined
  };
}

const CYCLE_COLUMNS = `
  id, started_at, finished_at, status, overran,
  EXTRACT(EPOCH FROM (started_at + make_interval(days => $1) - now())) * 1000 AS ms_until_due,
  EXTRACT(EPOCH FROM (COALESCE(finished_at, now()) - started_at)) * 1000 AS duration_ms
`;

/**
 * Get the most recent crawl cycle (running or finished)
 * @param {number} intervalDays - Cycle interval, used to compute msUntilDue
 * @returns {Promise<Object|null>}
 */
async function getLatestCycle(intervalDays = 7) {
  const result = await pool.query(
    `SELECT ${CYCLE_COLUMNS} FROM crawl_cycle ORDER BY id DESC LIMIT 1`,
    [intervalDays]
  );
  return mapCycle(result.rows[0]);
}

/**
 * Get the running (open) crawl cycle, if any
 * @param {number} intervalDays - Cycle interval, used to compute msUntilDue
 * @returns {Promise<Object|null>}
 */
async function getRunningCycle(intervalDays = 7) {
  const result = await pool.query(
    `SELECT ${CYCLE_COLUMNS} FROM crawl_cycle WHERE status = 'running' ORDER BY id DESC LIMIT 1`,
    [intervalDays]
  );
  return mapCycle(result.rows[0]);
}

/**
 * Start a new crawl cycle. Any running cycle is marked as abandoned.
 * @param {number} intervalDays - Cycle interval, used to compute msUntilDue
 * @returns {Promise<Object>} The new cycle
 */
async function startCycle(intervalDays = 7) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE crawl_cycle SET status = 'abandoned', finished_at = now() WHERE status = 'running'`
    );
    const inserted = await client.query('INSERT INTO crawl_cycle DEFAULT VALUES RETURNING id');
    const result = await client.query(
      `SELECT ${CYCLE_COLUMNS} FROM crawl_cycle WHERE id = $2`,
      [intervalDays, inserted.rows[0].id]
    );
    await client.query('COMMIT');
    return mapCycle(result.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Mark sources as completely crawled within a cycle
 * @param {number} cycleId
 * @param {Array<number>} crawllogCatalogIds
 * @returns {Promise<number>} Number of newly marked sources
 */
async function markSourcesCompleted(cycleId, crawllogCatalogIds) {
  const ids = (crawllogCatalogIds || []).filter(Boolean);
  if (!cycleId || ids.length === 0) return 0;

  const result = await pool.query(
    `INSERT INTO crawl_cycle_source (cycle_id, crawllog_catalog_id)
     SELECT $1, unnest($2::int[])
     ON CONFLICT DO NOTHING`,
    [cycleId, ids]
  );
  return result.rowCount;
}

/**
 * Get the crawllog_catalog ids that were already completed in a cycle
 * @param {number} cycleId
 * @returns {Promise<Set<number>>}
 */
async function getCompletedSourceIds(cycleId) {
  if (!cycleId) return new Set();
  const result = await pool.query(
    'SELECT crawllog_catalog_id FROM crawl_cycle_source WHERE cycle_id = $1',
    [cycleId]
  );
  return new Set(result.rows.map(row => row.crawllog_catalog_id));
}

/**
 * Finish a crawl cycle. Sets overran = true if it took longer than intervalDays.
 * @param {number} cycleId
 * @param {number} intervalDays
 * @returns {Promise<Object>} The finished cycle
 */
async function completeCycle(cycleId, intervalDays = 7) {
  await pool.query(
    `UPDATE crawl_cycle
     SET status = 'completed',
         finished_at = now(),
         overran = now() > started_at + make_interval(days => $2)
     WHERE id = $1`,
    [cycleId, intervalDays]
  );
  const result = await pool.query(
    `SELECT ${CYCLE_COLUMNS} FROM crawl_cycle WHERE id = $2`,
    [intervalDays, cycleId]
  );
  return mapCycle(result.rows[0]);
}

/**
 * Enqueue a collection URL into crawllog_collection without marking it as crawled
 * Used to persist newly discovered collection links for later processing
 * @param {Object} params
 * @param {string} params.sourceUrl - Collection URL to enqueue
 * @param {number|null} params.crawllogCatalogId - Parent crawllog_catalog id
 * @returns {Promise<void>}
 */
async function enqueueCollectionUrl({ sourceUrl, crawllogCatalogId = null }) {
  if (!sourceUrl) return;

  await pool.query(
    `INSERT INTO crawllog_collection (collection_id, source_url, crawllog_catalog_id)
     VALUES (NULL, $1, $2)
     ON CONFLICT (source_url) DO UPDATE SET
       crawllog_catalog_id = COALESCE(EXCLUDED.crawllog_catalog_id, crawllog_collection.crawllog_catalog_id)`,
    [sourceUrl, crawllogCatalogId]
  );
}

/**
 * Get pending (not yet crawled) collection URLs from crawllog_collection
 * Joined with crawllog_catalog to determine API vs catalog context
 * @param {Object} options
 * @param {boolean} options.isApi - If provided, filter by API status
 * @returns {Promise<Array>} Array of pending collection seed objects
 */
async function getPendingCollectionSeeds(options = {}) {
  let query = `
    SELECT cc.source_url, cc.crawllog_catalog_id, c.slug, c.is_api
    FROM crawllog_collection cc
    JOIN crawllog_catalog c ON c.id = cc.crawllog_catalog_id
    WHERE cc.collection_id IS NULL
      AND cc.source_url IS NOT NULL
  `;
  const params = [];

  if (options.isApi !== undefined) {
    query += ' AND c.is_api = $1';
    params.push(options.isApi);
  }

  query += ' ORDER BY cc.id';

  const result = await pool.query(query, params);
  return result.rows.map(row => ({
    url: row.source_url,
    crawllogCatalogId: row.crawllog_catalog_id,
    slug: row.slug,
    isApi: row.is_api
  }));
}

/**
 * Claim and remove a batch of pending collection URLs from crawllog_collection
 * Used to feed the in-memory queue in controlled batches
 * @param {Object} options
 * @param {number} options.limit - Maximum number of URLs to claim
 * @param {boolean} options.isApi - If provided, filter by API status
 * @returns {Promise<Array>} Array of claimed queue items
 */
async function claimCollectionQueueBatch({ limit = 900, isApi, crawllogCatalogIds } = {}) {
  if (!limit || limit <= 0) return [];

  const params = [];
  let apiFilter = '';
  let catalogFilter = '';
  let limitParam = '$1';

  if (isApi !== undefined) {
    apiFilter = 'AND c.is_api = $1';
    params.push(isApi);
    limitParam = '$2';
  }

  if (Array.isArray(crawllogCatalogIds) && crawllogCatalogIds.length > 0) {
    params.push(crawllogCatalogIds);
    catalogFilter = `AND cc.crawllog_catalog_id = ANY($${params.length})`;
    limitParam = `$${params.length + 1}`;
  }

  params.push(limit);

  const query = `
    WITH cte AS (
      SELECT cc.id
      FROM crawllog_collection cc
      JOIN crawllog_catalog c ON c.id = cc.crawllog_catalog_id
      WHERE cc.source_url IS NOT NULL
      ${apiFilter}
      ${catalogFilter}
      ORDER BY cc.id
      LIMIT ${limitParam}
    )
    DELETE FROM crawllog_collection cc
    USING cte, crawllog_catalog c
    WHERE cc.id = cte.id
      AND c.id = cc.crawllog_catalog_id
    RETURNING cc.source_url, cc.crawllog_catalog_id, c.slug, c.is_api;
  `;

  const result = await pool.query(query, params);
  return result.rows.map(row => ({
    url: row.source_url,
    crawllogCatalogId: row.crawllog_catalog_id,
    slug: row.slug,
    isApi: row.is_api
  }));
}

/**
 * Remove a URL from crawllog_collection queue
 * Used when a URL was processed outside of DB batch claiming
 * @param {string} sourceUrl - URL to remove
 * @returns {Promise<number>} Number of rows deleted
 */
async function removeFromCollectionQueue(sourceUrl) {
  if (!sourceUrl) return 0;

  const result = await pool.query(
    'DELETE FROM crawllog_collection WHERE source_url = $1',
    [sourceUrl]
  );

  return result.rowCount;
}

/**
 * Update the updated_at timestamp for a crawllog_catalog entry
 * Called when a catalog has been fully processed
 * @param {number} crawllogCatalogId - The crawllog_catalog id
 */
async function markCatalogCrawled(crawllogCatalogId) {
  if (!crawllogCatalogId) return;
  
  await pool.query(
    'UPDATE crawllog_catalog SET updated_at = now() WHERE id = $1',
    [crawllogCatalogId]
  );
}

/**
 * Clear all entries from crawllog_collection table
 * Used for fresh crawl - forces re-crawling of all collections
 * @returns {Promise<number>} Number of rows deleted
 */
async function clearCrawllogCollection() {
  const result = await pool.query('DELETE FROM crawllog_collection');
  return result.rowCount;
}

/**
 * Clear all entries from both crawllog tables
 * Used for complete fresh start
 * @returns {Promise<{catalogs: number, collections: number}>} Number of rows deleted from each table
 */
async function clearAllCrawllogs() {
  // Delete collections first (foreign key constraint)
  const collectionsResult = await pool.query('DELETE FROM crawllog_collection');
  const catalogsResult = await pool.query('DELETE FROM crawllog_catalog');
  
  return {
    catalogs: catalogsResult.rowCount,
    collections: collectionsResult.rowCount
  };
}

/**
 * Check if an error is a PostgreSQL deadlock error
 * @param {Error} error - The error to check
 * @returns {boolean} true if it's a deadlock error
 */
function isDeadlockError(error) {
  // PostgreSQL deadlock error code is '40P01'
  return error.code === '40P01' || error.message?.includes('deadlock detected');
}

/**
 * Sleep for a given number of milliseconds
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Insert or update a collection in the database with deadlock retry logic
 * @param {Object} collection - STAC collection object
 * @param {number} maxRetries - Maximum number of retry attempts for deadlocks (default: 3)
 * @returns {Promise<number>} collection ID
 */
async function insertOrUpdateCollection(collection, maxRetries = 3) {
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await _insertOrUpdateCollectionInternal(collection);
    } catch (error) {
      lastError = error;
      
      if (isDeadlockError(error) && attempt < maxRetries) {
        // Exponential backoff: 100ms, 200ms, 400ms, ...
        const delayMs = 100 * Math.pow(2, attempt - 1) + Math.random() * 50;
        console.warn(`WARN  [DB] Deadlock detected for collection "${collection.title || collection.id}", retrying in ${Math.round(delayMs)}ms (attempt ${attempt}/${maxRetries})`);
        await sleep(delayMs);
        continue;
      }
      
      // Not a deadlock or max retries reached, throw the error
      throw error;
    }
  }
  
  // Should not reach here, but just in case
  throw lastError;
}

/**
 * Internal implementation of insertOrUpdateCollection
 * @param {Object} collection - STAC collection object
 * @returns {Promise<number>} collection ID
 */
async function _insertOrUpdateCollectionInternal(collection) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Parse spatial extent (bbox)
    // Support both normalized format (bbox) and original STAC format (extent.spatial.bbox)
    let spatialExtent = null;
    let bbox = null;
    
    // Try normalized format first (from normalizeCollection)
    if (collection.bbox && Array.isArray(collection.bbox)) {
      bbox = collection.bbox;
    }
    // Fallback to original STAC format
    else if (collection.extent?.spatial?.bbox && collection.extent.spatial.bbox[0]) {
      bbox = collection.extent.spatial.bbox[0];
    }
    
    if (bbox && bbox.length === 4) {
      // Create polygon from bbox [west, south, east, north]
      // EWKT format requires SRID=4326, not EPSG:4326
      spatialExtent = `SRID=4326;POLYGON((${bbox[0]} ${bbox[1]}, ${bbox[2]} ${bbox[1]}, ${bbox[2]} ${bbox[3]}, ${bbox[0]} ${bbox[3]}, ${bbox[0]} ${bbox[1]}))`;
    }

    // Parse temporal extent
    // Support both normalized format (temporal) and original STAC format (extent.temporal.interval)
    let temporalStart = null;
    let temporalEnd = null;
    let interval = null;
    
    // Try normalized format first (from normalizeCollection)
    if (collection.temporal && Array.isArray(collection.temporal)) {
      interval = collection.temporal;
    }
    // Fallback to original STAC format
    else if (collection.extent?.temporal?.interval && collection.extent.temporal.interval[0]) {
      interval = collection.extent.temporal.interval[0];
    }
    
    if (interval) {
      temporalStart = interval[0] ? new Date(interval[0]) : null;
      temporalEnd = interval[1] ? new Date(interval[1]) : null;
    }

    // Insert or update collection
    const collectionTitle = collection.title || collection.id || 'Unnamed Collection';
    
    // Construct unique stac_id from sourceSlug and collection id
    // Format: {sourceSlug}_{collection_id} for uniqueness across different sources
    let stacId = null;
    if (collection.sourceSlug && collection.id) {
      stacId = `${collection.sourceSlug}_${collection.id}`;
    } else if (collection.id) {
      stacId = collection.id;
    }
    
    // Extract source URL - prefer crawledUrl (the actual absolute URL the collection was fetched from)
    // Fall back to links only if crawledUrl is not available
    let sourceUrl = null;
    if (collection.crawledUrl) {
      // Use the absolute URL from the crawler (most reliable)
      sourceUrl = collection.crawledUrl;
    } else if (collection.links && Array.isArray(collection.links)) {
      // Fallback to self/root links (may be relative URLs)
      const selfLink = collection.links.find(link => link.rel === 'self');
      const rootLink = collection.links.find(link => link.rel === 'root');
      sourceUrl = selfLink?.href || rootLink?.href || null;
    }
    
    // Check if collection with same stac_id already exists - stac_id is the unique key for upsert
    // stac_id format: {sourceSlug}_{collection.id} ensures uniqueness across sources
    let existingCollection;
    if (stacId) {
      // Primary matching: stac_id is unique, so match by stac_id alone
      existingCollection = await client.query(
        'SELECT id FROM collection WHERE stac_id = $1',
        [stacId]
      );
    } else {
      // Fallback for collections without stac_id: match by title + source_url
      existingCollection = await client.query(
        'SELECT id FROM collection WHERE stac_id IS NULL AND title = $1 AND source_url = $2',
        [collectionTitle, sourceUrl]
      );
    }
    
    // Use originalJson if available (from normalizeCollection), otherwise use the collection object
    // This ensures the full original STAC JSON is stored, not the normalized version
    const fullJsonData = collection.originalJson || collection;
    
    // Determine is_api based on source_url
    // If source_url ends with .json, it's NOT an API (static file)
    // Otherwise, it's an API endpoint
    let isApi = false;
    if (sourceUrl) {
      isApi = !sourceUrl.toLowerCase().endsWith('.json');
    }
    
    let collectionId;
    if (existingCollection.rows.length > 0) {
      // Update existing collection
      collectionId = existingCollection.rows[0].id;
      await client.query(
        `UPDATE collection SET 
          stac_id = $1,
          stac_version = $2,
          title = $3,
          description = $4,
          license = $5,
          spatial_extent = ST_GeomFromEWKT($6),
          temporal_extent_start = $7,
          temporal_extent_end = $8,
          is_active = $9,
          source_url = $10,
          full_json = $11,
          is_api = $12,
          updated_at = now()
         WHERE id = $13`,
        [
          stacId,
          collection.stac_version || null,
          collectionTitle,
          collection.description || null,
          collection.license || null,
          spatialExtent,
          temporalStart,
          temporalEnd,
          true, // is_active
          sourceUrl,
          JSON.stringify(fullJsonData),
          isApi,
          collectionId
        ]
      );
    } else {
      // Insert new collection - updated_at defaults to now() (same as created_at)
      // since we know the data is current as of this crawl
      const collectionResult = await client.query(
        `INSERT INTO collection (
          stac_id, stac_version, title, description, license,
          spatial_extent, temporal_extent_start, temporal_extent_end,
          is_active, source_url, full_json, is_api
        )
        VALUES ($1, $2, $3, $4, $5, ST_GeomFromEWKT($6), $7, $8, $9, $10, $11, $12)
        RETURNING id`,
        [
          stacId,
          collection.stac_version || null,
          collectionTitle,
          collection.description || null,
          collection.license || null,
          spatialExtent,
          temporalStart,
          temporalEnd,
          true, // is_active
          sourceUrl,
          JSON.stringify(fullJsonData),
          isApi
        ]
      );
      collectionId = collectionResult.rows[0].id;
    }

    // Insert summaries
    if (collection.summaries && typeof collection.summaries === 'object') {
      await client.query('DELETE FROM collection_summaries WHERE collection_id = $1', [collectionId]);
      for (const [name, value] of Object.entries(collection.summaries)) {
        await insertSummary(client, collectionId, name, value);
      }
    }

    // Insert keywords
    if (collection.keywords && Array.isArray(collection.keywords)) {
      await insertKeywords(client, collectionId, collection.keywords, 'collection');
    }

    // Insert STAC extensions
    if (collection.stac_extensions && Array.isArray(collection.stac_extensions)) {
      await insertStacExtensions(client, collectionId, collection.stac_extensions, 'collection');
    }

    // Insert providers
    if (collection.providers && Array.isArray(collection.providers)) {
      await insertProviders(client, collectionId, collection.providers);
    }

    // Insert assets
    if (collection.assets && typeof collection.assets === 'object') {
      await insertAssets(client, collectionId, collection.assets);
    }

    // Remove from crawllog_collection queue once crawled
    if (sourceUrl) {
      await client.query(
        'DELETE FROM crawllog_collection WHERE source_url = $1',
        [sourceUrl]
      );
    }

    await client.query('COMMIT');
    
    return collectionId;
  } catch (error) {
    await client.query('ROLLBACK');
    // Only log non-deadlock errors here, deadlocks are handled by retry wrapper
    if (!isDeadlockError(error)) {
      console.error('Error inserting collection:', error.message);
    }
    throw error;
  } finally {
    client.release();
  }
}



/**
 * Insert or update keywords for a collection
 * Deletes existing keywords for the parent and inserts new ones
 * @async
 * @function insertKeywords
 * @param {Object} client - PostgreSQL client from connection pool
 * @param {number} parentId - Parent entity ID (collection ID)
 * @param {string[]} keywords - Array of keyword strings
 * @param {string} type - Entity type ('collection')
 * @returns {Promise<void>}
 */
async function insertKeywords(client, parentId, keywords, type) {
  await client.query(
    `DELETE FROM ${type}_keywords WHERE ${type}_id = $1`,
    [parentId]
  );

  for (const keyword of keywords) {
    if (!keyword) continue;
    
    // Insert keyword if not exists
    const keywordResult = await client.query(
      'INSERT INTO keywords (keyword) VALUES ($1) ON CONFLICT (keyword) DO UPDATE SET keyword = EXCLUDED.keyword RETURNING id',
      [keyword]
    );
    const keywordId = keywordResult.rows[0].id;

    // Link keyword to parent
    await client.query(
      `INSERT INTO ${type}_keywords (${type}_id, keyword_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [parentId, keywordId]
    );
  }
}

/**
 * Insert or update STAC extensions for a collection
 * Deletes existing extensions for the parent and inserts new ones
 * @async
 * @function insertStacExtensions
 * @param {Object} client - PostgreSQL client from connection pool
 * @param {number} parentId - Parent entity ID (collection ID)
 * @param {string[]} extensions - Array of STAC extension URLs
 * @param {string} type - Entity type ('collection')
 * @returns {Promise<void>}
 */
async function insertStacExtensions(client, parentId, extensions, type) {
  await client.query(
    `DELETE FROM ${type}_stac_extension WHERE ${type}_id = $1`,
    [parentId]
  );

   for (const extension of extensions) {
    if (!extension) continue;

    // Insert extension if not exists
    const extResult = await client.query(
      'INSERT INTO stac_extensions (stac_extension) VALUES ($1) ON CONFLICT (stac_extension) DO UPDATE SET stac_extension = EXCLUDED.stac_extension RETURNING id',
      [extension]
    );
    const extId = extResult.rows[0].id;

    // Link extension to parent
    await client.query(
      `INSERT INTO ${type}_stac_extension (${type}_id, stac_extension_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [parentId, extId]
    );
  }
}


/**
 * Insert a single collection summary entry
 * Automatically determines the summary type (range, set, schema, or value) based on the value
 * @async
 * @function insertSummary
 * @param {Object} client - PostgreSQL client from connection pool
 * @param {number} collectionId - Collection ID
 * @param {string} name - Summary property name
 * @param {*} value - Summary value (can be array, object, or primitive)
 * @returns {Promise<void>}
 */
async function insertSummary(client, collectionId, name, value) {
  let kind = 'unknown';
  let rangeMin = null;
  let rangeMax = null;
  let setValue = null;
  let jsonSchema = null;

  if (Array.isArray(value)) {
    if (value.length === 2 && typeof value[0] === 'number' && typeof value[1] === 'number') {
      kind = 'range';
      rangeMin = value[0];
      rangeMax = value[1];
    } else {
      kind = 'set';
      setValue = JSON.stringify(value);
    }
  } else if (typeof value === 'object') {
    kind = 'schema';
    jsonSchema = JSON.stringify(value);
  } else {
    kind = 'value';
    setValue = String(value);
  }

  await client.query(
    'INSERT INTO collection_summaries (collection_id, name, kind, range_min, range_max, set_value, json_schema) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [collectionId, name, kind, rangeMin, rangeMax, setValue, jsonSchema]
  );
}

/**
 * Insert or update providers for a collection
 * Deletes existing provider links and creates new ones
 * @async
 * @function insertProviders
 * @param {Object} client - PostgreSQL client from connection pool
 * @param {number} collectionId - Collection ID
 * @param {Object[]} providers - Array of provider objects with name and roles
 * @returns {Promise<void>}
 */
async function insertProviders(client, collectionId, providers) {
  await client.query('DELETE FROM collection_providers WHERE collection_id = $1', [collectionId]);

  for (const provider of providers) {
    if (!provider.name) continue;

    // Insert provider if not exists
    const providerResult = await client.query(
      'INSERT INTO providers (provider) VALUES ($1) ON CONFLICT (provider) DO UPDATE SET provider = EXCLUDED.provider RETURNING id',
      [provider.name]
    );
    const providerId = providerResult.rows[0].id;

    // Link provider to collection
    const roles = provider.roles ? provider.roles.join(',') : null;
    await client.query(
      'INSERT INTO collection_providers (collection_id, provider_id, collection_provider_roles) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [collectionId, providerId, roles]
    );
  }
}

/**
 * Insert or update assets for a collection
 * Deletes existing asset links and creates new ones
 * @async
 * @function insertAssets
 * @param {Object} client - PostgreSQL client from connection pool
 * @param {number} collectionId - Collection ID
 * @param {Object} assets - Object mapping asset names to asset data (href, type, roles, metadata)
 * @returns {Promise<void>}
 */
async function insertAssets(client, collectionId, assets) {
  await client.query('DELETE FROM collection_assets WHERE collection_id = $1', [collectionId]);

  for (const [assetName, assetData] of Object.entries(assets)) {
    if (!assetData) continue;

    // Insert asset
    const assetResult = await client.query(
      'INSERT INTO assets (name, href, type, roles, metadata) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [
        assetName,
        assetData.href || null,
        assetData.type || null,
        assetData.roles || null,
        JSON.stringify(assetData)
      ]
    );
    const assetId = assetResult.rows[0].id;

    // Link asset to collection
    const roles = assetData.roles ? assetData.roles.join(',') : null;
    await client.query(
      'INSERT INTO collection_assets (collection_id, asset_id, collection_asset_roles) VALUES ($1, $2, $3)',
      [collectionId, assetId, roles]
    );
  }
}




/**
 * Mark collections as inactive if they were not refreshed recently.
 * Without arguments, collections not updated in the last 7 days are deactivated.
 * With `cycleId`, collections not updated since the start of that crawl cycle are deactivated —
 * used after a complete full re-crawl to deactivate everything that was not confirmed in it.
 * @async
 * @function deactivateStaleCollections
 * @param {Object} [options]
 * @param {number} [options.cycleId] - crawl_cycle id whose start is the cutoff
 * @returns {Promise<number>} Number of collections marked as inactive
 */
async function deactivateStaleCollections({ cycleId } = {}) {
  const result = cycleId
    ? await pool.query(`
        UPDATE collection
        SET is_active = false
        WHERE updated_at < (SELECT started_at FROM crawl_cycle WHERE id = $1)
          AND is_active = true
      `, [cycleId])
    : await pool.query(`
        UPDATE collection
        SET is_active = false
        WHERE updated_at < NOW() - INTERVAL '7 days'
          AND is_active = true
      `);
  
  const count = result.rowCount;
  if (count > 0) {
    const reason = cycleId ? 'not seen during this full re-crawl' : 'not updated in last 7 days';
    console.log(`Marked ${count} collection(s) as inactive (${reason})`);
  }
  
  return count;
}

/**
 * Close the database connection pool
 * Should be called when the application shuts down
 * @async
 * @function close
 * @returns {Promise<void>}
 */
async function close() {
  await pool.end();
}

export default { 
  initDb, 
  insertOrUpdateCatalog, 
  insertOrUpdateCollection,
  saveCrawllogCatalog,
  getCrawllogCatalogs,
  getCrawllogCatalogIdsWithPendingQueue,
  getCrawllogCatalogIdByUrl,
  getSlugByCrawllogCatalogId,
  getCrawledCollectionUrls,
  isCollectionUrlCrawled,
  setCurrentCycle,
  getLatestCycle,
  getRunningCycle,
  startCycle,
  markSourcesCompleted,
  getCompletedSourceIds,
  completeCycle,
  enqueueCollectionUrl,
  getPendingCollectionSeeds,
  claimCollectionQueueBatch,
  removeFromCollectionQueue,
  markCatalogCrawled,
  clearCrawllogCollection,
  clearAllCrawllogs,
  deactivateStaleCollections,
  close, 
  pool 
};
