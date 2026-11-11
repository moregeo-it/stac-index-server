/**
 * @fileoverview Legacy STAC Index API (stacindex.org) crawler that fetches and processes catalog data
 * @module crawler
 */

import axios from 'axios';
import { processCatalogs } from './utils/normalization.js';
import { crawlCatalogs } from './catalogs/catalog.js';
import { crawlApis } from './apis/api.js';
import { getConfig, isStaticCatalogUrl } from './utils/config.js';
import { formatDuration } from './utils/time.js';
import db from './utils/db.js';
import globalStats from './utils/globalStats.js';

/**
 * URL of the legacy STAC Index API endpoint
 * @type {string}
 */
const targetUrl = 'https://www.stacindex.org/api/catalogs';

/**
 * Flag to track if shutdown was requested
 */
let shutdownRequested = false;

/**
 * Check if shutdown was requested (can be used by crawlers to stop early)
 * @returns {boolean} True if shutdown was requested
 */
export function isShutdownRequested() {
    return shutdownRequested;
}

/**
 * Request a graceful shutdown of the crawler
 * The crawler will stop after completing the current batch
 */
export function requestShutdown() {
    if (!shutdownRequested) {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('GRACEFUL SHUTDOWN REQUESTED');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('The crawler will stop after the current batch completes.');
        console.log('Already-crawled collections are saved in crawllog_collection.');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
        shutdownRequested = true;
    }
}

/**
 * Reset the shutdown flag (for scheduler to start a new crawl)
 */
export function resetShutdownFlag() {
    shutdownRequested = false;
}

/**
 * Fetches catalog data from the legacy STAC Index API and processes it
 * @async
 * @function crawler
 * @param {Object} [overrides] - Config values that take precedence over CLI/env (used by the scheduler,
 *                               e.g. { fullRecrawl: true })
 * @param {Object} [options]
 * @param {boolean} [options.keepDbOpen=false] - Do not close the DB pool at the end (scheduler reuses it)
 * @param {boolean} [options.handleSignals=true] - Install SIGINT/SIGTERM handlers (the scheduler has its own)
 * @returns {Promise<Object>} Returns statistics about the crawl including success status and runtime
 */
export const crawler = async (overrides = {}, { keepDbOpen = false, handleSignals = true } = {}) => {
    // Start the timer
    const startTime = Date.now();
    let dbError = false;
    let crawlError = false;
    let config = null;
    // Crawl cycle of this full re-crawl; null in resume mode
    let cycle = null;
    // Whether this run covered all remaining sources (no MAX_CATALOGS/MAX_APIS truncation)
    let truncated = false;
    
    // Setup graceful shutdown handler
    const shutdownHandler = async (signal) => {
        if (shutdownRequested) {
            console.log('\nForce shutdown requested. Exiting immediately...');
            process.exit(1);
        }
        
        console.log(`\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        console.log(`PAUSE REQUESTED (${signal})`);
        console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        console.log(`The crawler will stop after the current batch completes.`);
        console.log(`Already-crawled collections are saved in crawllog_collection.`);
        console.log(`Re-run the crawler to resume from where it left off.`);
        console.log(`Press Ctrl+C again to force immediate exit.`);
        console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
        
        shutdownRequested = true;
    };
    
    if (handleSignals) {
        process.on('SIGINT', shutdownHandler);
        process.on('SIGTERM', shutdownHandler);
    }
    const removeSignalHandlers = () => {
        process.off('SIGINT', shutdownHandler);
        process.off('SIGTERM', shutdownHandler);
    };
    
    try {
        // Load configuration
        config = { ...getConfig(), ...overrides };
        if (config.fresh) config.fullRecrawl = true;
        
        // Initialize database connection
        try {
            await db.initDb();
        } catch (err) {
            console.error(`\nDatabase initialization failed: ${err.message}`);
            dbError = true;
            throw err;
        }
        
        // Full re-crawl (scheduler default, --full-recrawl, --fresh) runs inside a crawl cycle
        // that is persisted in the DB (crawl_cycle). If the process is stopped, the next run
        // continues the running cycle instead of starting over:
        // - sources already completed in the cycle are skipped
        // - all other sources are crawled from their root (also ones completed in earlier cycles)
        // - a collection is only skipped if it was already refreshed during this cycle
        if (config.fullRecrawl) {
            const running = config.fresh ? null : await db.getRunningCycle(config.cycleIntervalDays);
            if (running) {
                cycle = running;
                console.log(`\n=== Resuming full re-crawl cycle #${cycle.id} (started ${formatDuration(cycle.durationMs)} ago) ===`);
            } else {
                // New cycle: start every source from its root, so drop the old queue
                cycle = await db.startCycle(config.cycleIntervalDays);
                console.log(`\n=== Starting full re-crawl cycle #${cycle.id} ===`);
                try {
                    const cleared = await db.clearCrawllogCollection();
                    console.log(`Removed ${cleared} queued URL(s). All sources will be crawled from their root.`);
                } catch (err) {
                    console.error(`Warning: Failed to clear crawllog: ${err.message}`);
                }
            }
            config.cycleId = cycle.id;
            db.setCurrentCycle(cycle.id);
        } else {
            db.setCurrentCycle(null);
        }
        
        // Display configuration
        console.log('\n=== STAC Crawler Configuration ===');
        console.log(`Mode: ${config.mode}`);
        console.log(`Full Re-crawl: ${config.fullRecrawl ? 'enabled (crawl all sources and refresh every collection)' : 'disabled (resume/skip crawled URLs)'}`);
        console.log(`Max Catalogs: ${config.maxCatalogs === 0 ? 'unlimited' : config.maxCatalogs} (debugging limit)`);
        console.log(`Max APIs: ${config.maxApis === 0 ? 'unlimited' : config.maxApis} (debugging limit)`);
        console.log(`Timeout: ${config.timeout === Infinity ? 'unlimited' : config.timeout + 'ms'}`);
        console.log(`Max Depth: ${config.maxDepth === 0 ? 'unlimited' : config.maxDepth} levels`);
        console.log('--- Parallel Crawling ---');
        console.log(`Parallel Domains: ${config.parallelDomains}`);
        console.log(`Max Requests/Min per Domain: ${config.maxRequestsPerMinutePerDomain}`);
        console.log(`Max Concurrency per Domain: ${config.maxConcurrencyPerDomain}`);
        console.log(`Theoretical Max Throughput: ${config.parallelDomains * config.maxRequestsPerMinutePerDomain} req/min`);
        console.log('==================================\n');
        
        const response = await axios.get(targetUrl);
        const catalogs = processCatalogs(response.data);
        
        // Save catalogs from the legacy STAC Index to crawllog_catalog table
        // This creates the URL queue for re-crawling and stores the slug for stac_id generation
        console.log('\n=== Saving catalogs to crawllog_catalog ===');
        let catalogsSaved = 0;
        let catalogsFailed = 0;
        
        for (const catalog of catalogs) {
            try {
                const isApi = catalog.isApi === true && !isStaticCatalogUrl(catalog.url);
                const crawllogId = await db.saveCrawllogCatalog({
                    slug: catalog.slug,
                    url: catalog.url,
                    isApi: isApi
                });
                console.log(`Saved: ${catalog.title || catalog.slug} (crawllog_id: ${crawllogId}, isApi: ${isApi})`);
                catalogsSaved++;
            } catch (err) {
                console.error(`Failed: ${catalog.title || catalog.slug} - ${err.message}`);
                catalogsFailed++;
            }
        }
        
        console.log(`\nCrawllog Catalogs: ${catalogsSaved} saved, ${catalogsFailed} failed\n`);
        
        // Now fetch the URL queue from crawllog_catalog for re-crawling
        // This allows us to re-crawl existing catalogs without fetching from the legacy STAC Index again
        console.log('\n=== Loading catalogs from crawllog_catalog for crawling ===');
        const crawllogCatalogs = await db.getCrawllogCatalogs({ isApi: false });
        const crawllogApis = await db.getCrawllogCatalogs({ isApi: true });
        // In a full re-crawl every remaining source is seeded from its root (pending queue entries
        // are still pulled in addition), because nested child catalogs are not persisted in the queue
        const pendingCatalogIds = config.fullRecrawl
            ? new Set()
            : new Set(await db.getCrawllogCatalogIdsWithPendingQueue({ isApi: false }));
        const pendingApiIds = config.fullRecrawl
            ? new Set()
            : new Set(await db.getCrawllogCatalogIdsWithPendingQueue({ isApi: true }));
        const completedInCycle = cycle ? await db.getCompletedSourceIds(cycle.id) : new Set();
        
        console.log(`Loaded ${crawllogCatalogs.length} catalogs and ${crawllogApis.length} APIs from crawllog_catalog\n`);
        
        // Merge original catalog metadata with crawllog entries for crawling
        // We need the full catalog info (title, etc.) for processing
        const catalogUrlMap = new Map(catalogs.map(c => [c.url, c]));
        
        const regularCatalogs = crawllogCatalogs.map(cl => {
            const original = catalogUrlMap.get(cl.url) || {};
            return {
                ...original,
                id: cl.id,
                slug: cl.slug,
                url: cl.url,
                crawllogCatalogId: cl.id,  // Pass the crawllog_catalog id for linking
                createdAt: cl.createdAt,
                updatedAt: cl.updatedAt,
                hasPendingQueue: pendingCatalogIds.has(cl.id)
            };
        });

        
        const realApis = crawllogApis.map(cl => {
            const original = catalogUrlMap.get(cl.url) || {};
            return {
                ...original,
                id: cl.id,
                slug: cl.slug,
                url: cl.url,
                crawllogCatalogId: cl.id,  // Pass the crawllog_catalog id for linking
                createdAt: cl.createdAt,
                updatedAt: cl.updatedAt,
                hasPendingQueue: pendingApiIds.has(cl.id)
            };
        });

        
        console.log(`\nCatalog Classification (from crawllog_catalog):`);
        console.log(`  Catalogs: ${regularCatalogs.length}`);
        console.log(`  APIs: ${realApis.length}\n`);
        
        // Start global statistics tracking (no periodic logging, only final stats)
        const totalItems = [...regularCatalogs, ...realApis].length;
        globalStats.start(totalItems);
        
        const shouldCrawlSeed = (seed) => {
            if (config.fullRecrawl) return !completedInCycle.has(seed.crawllogCatalogId);
            if (seed.hasPendingQueue) return true;
            if (!seed.createdAt || !seed.updatedAt) return true;
            const createdAt = new Date(seed.createdAt).getTime();
            const updatedAt = new Date(seed.updatedAt).getTime();
            if (Number.isNaN(createdAt) || Number.isNaN(updatedAt)) return true;
            return updatedAt <= createdAt;
        };

        // Crawl catalogs if mode is 'catalogs' or 'both'
        if (config.mode === 'catalogs' || config.mode === 'both') {
            console.log('\nCrawling collections and nested catalogs with Crawlee...\n');

            const allCatalogsToProcess = regularCatalogs.filter(shouldCrawlSeed);
            const skippedCatalogs = regularCatalogs.length - allCatalogsToProcess.length;
            if (skippedCatalogs > 0) {
                console.log(config.fullRecrawl
                    ? `Skipping ${skippedCatalogs} catalogs already completed in cycle #${cycle.id}`
                    : `Skipping ${skippedCatalogs} catalogs already fully crawled (no pending queue)`);
            }
            
            // Note: MAX_CATALOGS limit is for debugging purposes only
            // Set maxCatalogs to 0 or use --max-catalogs 0 for unlimited catalog crawling
            const catalogsToProcess = config.maxCatalogs === 0 
                ? allCatalogsToProcess 
                : allCatalogsToProcess.slice(0, config.maxCatalogs);
            if (catalogsToProcess.length < allCatalogsToProcess.length) truncated = true;
            
            console.log(`Processing ${catalogsToProcess.length} catalogs (max: ${config.maxCatalogs === 0 ? 'unlimited' : config.maxCatalogs})\n`);
            
            try {
                const results = await crawlCatalogs(catalogsToProcess, config);
                console.log(`\nTotal collections found across all catalogs: ${results.stats.collectionsFound}`);
            } catch (error) {
                console.error(`Failed to crawl catalogs: ${error.message}`);
            }
        } else {
            console.log('\nSkipping catalog crawling (mode: apis)\n');
        }

        // Crawl APIs if mode is 'apis' or 'both'
        if (config.mode === 'apis' || config.mode === 'both') {
            console.log('\nCrawling APIs...');
            // Pass full API objects (including slug and crawllogCatalogId) instead of just URLs
            const apiObjects = realApis
                .filter(shouldCrawlSeed)
                .map(api => ({ 
                url: api.url, 
                slug: api.slug, 
                title: api.title,
                crawllogCatalogId: api.crawllogCatalogId,  // Link to crawllog_catalog for collections
                hasPendingQueue: api.hasPendingQueue
            }));
            const skippedApis = realApis.length - apiObjects.length;
            if (skippedApis > 0) {
                console.log(config.fullRecrawl
                    ? `Skipping ${skippedApis} APIs already completed in cycle #${cycle.id}`
                    : `Skipping ${skippedApis} APIs already fully crawled (no pending queue)`);
            }
                
            if (apiObjects.length > 0) {
                // Note: MAX_APIS limit is for debugging purposes only
                // Set maxApis to 0 or use --max-apis 0 for unlimited API crawling
                const apisToProcess = config.maxApis === 0 ? apiObjects : apiObjects.slice(0, config.maxApis);
                if (apisToProcess.length < apiObjects.length) truncated = true;
                console.log(`Found ${apiObjects.length} APIs. Processing ${apisToProcess.length} (max: ${config.maxApis === 0 ? 'unlimited' : config.maxApis})...`);
                
                try {
                    await crawlApis(apisToProcess, true, config);
                } catch (error) {
                    console.error(`Failed to crawl APIs: ${error.message}`);
                }
            } else {
                console.log('No APIs found to crawl.');
            }
        } else {
            console.log('\nSkipping API crawling (mode: catalogs)\n');
        }

    } catch (error) {
        console.error(`Error fetching ${targetUrl}: ${error.message}`);
        if (!dbError) {
            crawlError = true;
        }
    } finally {
        // Stop global statistics tracking and log final stats
        globalStats.stop();
        
        // Finish the crawl cycle if this run went through all remaining sources.
        // Interrupted runs (Ctrl+C, container stop, time window) and runs truncated by
        // MAX_CATALOGS/MAX_APIS leave the cycle open; the next run continues it.
        let cycleCompleted = false;
        let cycleOverran = false;
        if (!dbError && cycle && !crawlError && !shutdownRequested && !truncated) {
            try {
                // Deactivate collections that were not confirmed in this cycle. Only safe when both
                // catalogs and APIs were crawled — otherwise the other type would be deactivated.
                if (config.mode === 'both') {
                    console.log('\nChecking for stale collections...');
                    await db.deactivateStaleCollections({ cycleId: cycle.id });
                } else {
                    console.log(`\nSkipping stale-collection cleanup (mode "${config.mode}", only runs with mode "both")`);
                }

                const finished = await db.completeCycle(cycle.id, config.cycleIntervalDays);
                cycleCompleted = true;
                cycleOverran = finished.overran;
                console.log(`\nFull re-crawl cycle #${cycle.id} completed in ${formatDuration(finished.durationMs)}`);

                if (cycleOverran) {
                    console.error('\n' + '!'.repeat(60));
                    console.error(`ERROR: Full re-crawl cycle #${cycle.id} exceeded the ${config.cycleIntervalDays}-day window`);
                    console.error(`   Duration: ${formatDuration(finished.durationMs)}`);
                    console.error('   The crawl was finished anyway. The next cycle is overdue and starts right away.');
                    console.error('   Consider more PARALLEL_DOMAINS / higher rate limits or a longer CRAWL_DAYS_INTERVAL.');
                    console.error('!'.repeat(60) + '\n');
                }
            } catch (err) {
                console.error(`Error completing crawl cycle #${cycle.id}: ${err.message}`);
            }
        } else if (!dbError && cycle) {
            const reason = crawlError ? 'crawl error'
                : shutdownRequested ? 'interrupted'
                : 'limited by MAX_CATALOGS/MAX_APIS';
            console.log(`\nFull re-crawl cycle #${cycle.id} stays open (${reason}) - the next run continues it`);
        }
        db.setCurrentCycle(null);
        removeSignalHandlers();
        
        // Close database connection (the scheduler keeps the pool open for the next run)
        if (!dbError && !keepDbOpen) {
            try {
                await db.close();
                console.log('\nDatabase connection closed.');
            } catch (err) {
                console.error(`Error closing database: ${err.message}`);
            }
        }
        
        // Display total running time
        const endTime = Date.now();
        const elapsedTime = endTime - startTime;
        
        console.log('\n=== Crawler Time Statistics ===');
        console.log(`Total Running Time: ${formatDuration(elapsedTime)}`);
        console.log(`Total Running Time (ms): ${elapsedTime}ms`);
        console.log(`Status: ${dbError ? 'Database Error' : crawlError ? 'Crawl Error' : 'Success'}`);
        console.log('================================\n');
        
        // Return statistics
        return {
            success: !dbError && !crawlError,
            dbError,
            crawlError,
            interrupted: shutdownRequested,
            fullRecrawl: Boolean(config?.fullRecrawl),
            cycleId: cycle?.id ?? null,
            cycleCompleted,
            cycleOverran,
            elapsedTime,
            startTime,
            endTime
        };
    }
};

// Run crawler if this file is executed directly
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule || import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
    crawler().then(stats => {
        // Non-zero exit code on errors and on a full re-crawl cycle that exceeded its window
        if (!stats.success || stats.cycleOverran) process.exitCode = 1;
    });
}