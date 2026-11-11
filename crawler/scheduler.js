/**
 * @fileoverview Scheduler for the STAC crawler (default command of the Docker image)
 *
 * Every CRAWL_DAYS_INTERVAL days (default: 7) a full re-crawl cycle is started: all sources are
 * crawled from their root again and every collection is refreshed. The cycle state lives in the
 * database (crawl_cycle), so:
 * - a stopped/crashed container continues the running cycle on restart (no restart from scratch)
 * - the next cycle is due CRAWL_DAYS_INTERVAL days after the START of the previous one, but only
 *   starts once the previous cycle is finished
 * - a cycle that is not finished within CRAWL_DAYS_INTERVAL days is still crawled to the end and
 *   then reported as an error; the next (overdue) cycle starts right after it
 *
 * Optionally restricts crawling to specified time windows.
 * Stops on database errors.
 * @module scheduler
 */

import dotenv from 'dotenv';
import { crawler, requestShutdown, resetShutdownFlag } from './index.js';
import { formatDuration } from './utils/time.js';
import { parseCliArgs } from './utils/cli.js';
import db from './utils/db.js';

dotenv.config();

/**
 * Configuration
 */
const DAYS_INTERVAL = parseInt(process.env.CRAWL_DAYS_INTERVAL, 10) || 7; // Cycle length / interval in days
const RUN_ON_STARTUP = process.env.CRAWL_RUN_ON_STARTUP !== 'false'; // Only relevant when no cycle exists yet
const RETRY_ON_CRAWL_ERROR = process.env.CRAWL_RETRY_ON_ERROR !== 'false'; // Retry if crawl fails but DB is ok
const RETRY_DELAY_HOURS = parseInt(process.env.CRAWL_RETRY_DELAY_HOURS, 10) || 2; // Hours to wait before retry on crawl error
// Every scheduled run is part of a full re-crawl cycle (see file header).
// Set CRAWL_FULL_RECRAWL=false to fall back to resume/skip runs every CRAWL_DAYS_INTERVAL days.
const FULL_RECRAWL = process.env.CRAWL_FULL_RECRAWL !== 'false';

/**
 * Config overrides passed to every scheduled crawler run.
 * The debugging limits MAX_CATALOGS / MAX_APIS default to unlimited for the scheduler unless they
 * are set explicitly, otherwise a "full" re-crawl would only cover the first few sources.
 */
const CLI_ARGS = parseCliArgs();
const CRAWL_OVERRIDES = {
    fullRecrawl: FULL_RECRAWL || Boolean(CLI_ARGS.fullRecrawl),
    cycleIntervalDays: DAYS_INTERVAL,
    ...(process.env.MAX_CATALOGS === undefined && CLI_ARGS.maxCatalogs === undefined ? { maxCatalogs: 0 } : {}),
    ...(process.env.MAX_APIS === undefined && CLI_ARGS.maxApis === undefined ? { maxApis: 0 } : {})
};

// Time window configuration (crawler only starts between these hours)
const ALLOWED_START_HOUR = parseInt(process.env.CRAWL_ALLOWED_START_HOUR, 10) || 0; // Default: 00:00 (Midnight)
const ALLOWED_END_HOUR = parseInt(process.env.CRAWL_ALLOWED_END_HOUR, 10) || 23; // Default: 23:00 (11 PM)
const ENFORCE_TIME_WINDOW = process.env.CRAWL_ENFORCE_TIME_WINDOW === 'true'; // Set to true to enable time window check
const GRACE_PERIOD_MINUTES = parseInt(process.env.CRAWL_GRACE_PERIOD_MINUTES, 10) || 30; // Minutes to allow crawler to finish gracefully after end hour

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
// setTimeout overflows above 2^31-1 ms (~24.8 days) and would fire immediately
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * Scheduler state
 */
let crawlRunning = false;
let stopRequested = false;
let waitTimer = null;

/**
 * Check if an hour lies within the allowed time window
 * @param {number} hour - Hour (0-23)
 * @returns {boolean}
 */
const isHourAllowed = (hour) => {
    // Handle time window that spans midnight (e.g., 22:00 - 07:00)
    if (ALLOWED_START_HOUR > ALLOWED_END_HOUR) {
        return hour >= ALLOWED_START_HOUR || hour < ALLOWED_END_HOUR;
    }
    // Normal time window (e.g., 09:00 - 17:00)
    return hour >= ALLOWED_START_HOUR && hour < ALLOWED_END_HOUR;
};

/**
 * Check if current time is within allowed time window
 * @returns {boolean} True if within allowed window
 */
const isWithinAllowedTimeWindow = () => {
    if (!ENFORCE_TIME_WINDOW) return true;
    return isHourAllowed(new Date().getHours());
};

/**
 * Move a delay forward so the run starts inside the allowed time window
 * @param {number} delayMs - Planned delay
 * @returns {number} Adjusted delay
 */
const adjustForTimeWindow = (delayMs) => {
    if (!ENFORCE_TIME_WINDOW) return delayMs;

    const scheduledTime = new Date(Date.now() + delayMs);
    if (isHourAllowed(scheduledTime.getHours())) return delayMs;

    const nextAllowed = new Date(scheduledTime);
    nextAllowed.setHours(ALLOWED_START_HOUR, 0, 0, 0);
    if (nextAllowed <= scheduledTime) {
        nextAllowed.setDate(nextAllowed.getDate() + 1);
    }
    console.log(`\nTime window enforcement: Next run moved to allowed window (${ALLOWED_START_HOUR}:00 - ${ALLOWED_END_HOUR}:00)`);
    return nextAllowed.getTime() - Date.now();
};

/**
 * Calculate milliseconds until the end of allowed time window
 * @returns {number} Milliseconds until end hour
 */
const getMillisecondsUntilEndTime = () => {
    const now = new Date();
    const endTime = new Date(now);
    endTime.setHours(ALLOWED_END_HOUR, 0, 0, 0);
    if (endTime <= now) {
        endTime.setDate(endTime.getDate() + 1);
    }
    return endTime.getTime() - now.getTime();
};

/**
 * Runs the crawler and returns statistics
 * Monitors time and requests a graceful stop at the end of the allowed window (the cycle is
 * continued in the next window)
 * @async
 * @function runCrawler
 * @returns {Promise<Object>} Crawler statistics
 */
const runCrawler = async () => {
    // Reset shutdown flag before starting a new crawl
    resetShutdownFlag();
    crawlRunning = true;

    const timestamp = new Date().toISOString();
    console.log(`\n${'='.repeat(60)}`);
    console.log(`[${timestamp}] Starting crawler run...`);
    console.log('='.repeat(60));

    let shutdownTimer = null;
    let gracePeriodTimer = null;

    if (ENFORCE_TIME_WINDOW) {
        const msUntilEnd = getMillisecondsUntilEndTime();
        const msUntilGraceEnd = msUntilEnd + (GRACE_PERIOD_MINUTES * 60 * 1000);

        if (msUntilEnd > 0 && msUntilEnd < 12 * HOUR_MS) {
            const endTime = new Date(Date.now() + msUntilEnd);
            console.log(`Note: Time window ends at ${endTime.toLocaleTimeString()} (${formatDuration(msUntilEnd)} remaining)`);
            console.log(`Grace period: ${GRACE_PERIOD_MINUTES} minutes after end time\n`);

            shutdownTimer = setTimeout(() => {
                console.warn(`\n${'!'.repeat(60)}`);
                console.warn(`WARNING: End time (${ALLOWED_END_HOUR}:00) reached!`);
                console.warn(`Crawler is still running. Grace period: ${GRACE_PERIOD_MINUTES} minutes`);
                console.warn('!'.repeat(60) + '\n');
            }, msUntilEnd);

            gracePeriodTimer = setTimeout(() => {
                console.error(`\n${'!'.repeat(60)}`);
                console.error(`Grace period expired (${ALLOWED_END_HOUR}:00 + ${GRACE_PERIOD_MINUTES}min)`);
                console.error(`Pausing the crawl - it continues at ${ALLOWED_START_HOUR}:00`);
                console.error('!'.repeat(60) + '\n');
                requestShutdown();
            }, msUntilGraceEnd);
        }
    }

    try {
        // Keep the DB pool open (it is reused for scheduling) and let the scheduler handle signals
        const stats = await crawler(CRAWL_OVERRIDES, { keepDbOpen: true, handleSignals: false });
        console.log(`\n[${new Date().toISOString()}] Crawler finished`);
        return stats;
    } catch (error) {
        console.error(`\n[${new Date().toISOString()}] Crawler encountered an error:`, error.message);
        return {
            success: false,
            dbError: true,
            crawlError: true,
            elapsedTime: 0,
            error: error.message
        };
    } finally {
        if (shutdownTimer) clearTimeout(shutdownTimer);
        if (gracePeriodTimer) clearTimeout(gracePeriodTimer);
        crawlRunning = false;
    }
};

/**
 * Determine when the next run is due
 * @param {Object} options
 * @param {boolean} options.retry - Retry after a crawl error
 * @param {boolean} options.firstStart - Called on scheduler startup
 * @returns {Promise<{delayMs: number, reason: string}>}
 */
const getNextRun = async ({ retry = false, firstStart = false } = {}) => {
    if (retry) {
        return { delayMs: RETRY_DELAY_HOURS * HOUR_MS, reason: `retry after crawl error (${RETRY_DELAY_HOURS}h)` };
    }

    if (!FULL_RECRAWL) {
        if (firstStart && RUN_ON_STARTUP) return { delayMs: 0, reason: 'run on startup' };
        return { delayMs: DAYS_INTERVAL * DAY_MS, reason: `${DAYS_INTERVAL} days interval` };
    }

    // Full re-crawl: timing comes from the persisted cycles
    const latest = await db.getLatestCycle(DAYS_INTERVAL);

    if (!latest) {
        if (firstStart && !RUN_ON_STARTUP) {
            return { delayMs: DAYS_INTERVAL * DAY_MS, reason: `first cycle (CRAWL_RUN_ON_STARTUP=false, waiting ${DAYS_INTERVAL} days)` };
        }
        return { delayMs: 0, reason: 'first full re-crawl cycle' };
    }

    if (latest.status === 'running') {
        return { delayMs: 0, reason: `continue unfinished cycle #${latest.id}` };
    }

    if (latest.msUntilDue <= 0) {
        return { delayMs: 0, reason: `next cycle overdue (cycle #${latest.id} started ${formatDuration(-latest.msUntilDue + DAYS_INTERVAL * DAY_MS)} ago)` };
    }

    return {
        delayMs: latest.msUntilDue,
        reason: `${DAYS_INTERVAL} days after start of cycle #${latest.id}`
    };
};

/**
 * Wait for a delay, also beyond the setTimeout limit
 * @param {number} delayMs
 * @returns {Promise<void>}
 */
const wait = (delayMs) => new Promise(resolve => {
    const step = () => {
        const remaining = target - Date.now();
        if (remaining <= 0) {
            waitTimer = null;
            resolve();
            return;
        }
        waitTimer = setTimeout(step, Math.min(remaining, MAX_TIMEOUT_MS));
    };
    const target = Date.now() + delayMs;
    step();
});

/**
 * Main scheduling loop: wait until the next run is due, run the crawler, repeat
 * @param {boolean} firstStart
 */
const loop = async () => {
    let options = { firstStart: true };

    while (!stopRequested) {
        let next;
        try {
            next = await getNextRun(options);
        } catch (err) {
            console.error(`\nDATABASE ERROR while scheduling: ${err.message}`);
            console.error('   If the table crawl_cycle is missing, apply db/init/08_tables_crawl_cycle.sql.\n');
            process.exit(1);
        }

        const delayMs = adjustForTimeWindow(next.delayMs);
        if (delayMs > 0) {
            const nextRun = new Date(Date.now() + delayMs);
            console.log(`\nNext crawl scheduled for: ${nextRun.toLocaleString()}`);
            console.log(`   Reason: ${next.reason}`);
            console.log(`   Wait time: ${formatDuration(delayMs)}\n`);
            await wait(delayMs);
        } else {
            console.log(`\nStarting crawl now (${next.reason})`);
        }

        if (stopRequested) break;

        const stats = await runCrawler();

        if (stopRequested) break;

        if (stats.cycleOverran) {
            console.error(`\nERROR: Full re-crawl cycle #${stats.cycleId} took longer than ${DAYS_INTERVAL} days (finished anyway).`);
        }

        if (stats.dbError) {
            console.error('\nDATABASE ERROR DETECTED - Scheduler stopped to prevent data issues.');
            console.error('   Please fix the database connection and restart the scheduler.\n');
            process.exit(1);
        } else if (stats.crawlError && RETRY_ON_CRAWL_ERROR) {
            console.warn('\nCrawl error detected but database is OK - scheduling retry...');
            options = { retry: true };
        } else if (stats.crawlError) {
            console.error('\nCrawl failed - scheduler stopped.\n');
            process.exit(1);
        } else {
            options = {};
        }
    }

    console.log('\nScheduler stopped. The running cycle is continued on the next start.\n');
    try { await db.close(); } catch { /* ignore */ }
    process.exit(0);
};

/**
 * Graceful stop on SIGINT/SIGTERM (Ctrl+C, docker stop).
 * During a crawl: finish current domains, flush data and exit; the cycle stays open and is
 * continued on the next start. A second signal exits immediately (progress is still kept).
 */
const onSignal = (signal) => {
    if (stopRequested) {
        console.log('\nForce stop requested. Exiting immediately (cycle is continued on next start)...');
        process.exit(1);
    }
    stopRequested = true;

    if (crawlRunning) {
        console.log(`\n${signal} received - stopping after current domains. Send again to force exit.`);
        requestShutdown();
    } else {
        console.log(`\n${signal} received - stopping scheduler.`);
        if (waitTimer) clearTimeout(waitTimer);
        db.close().catch(() => {}).finally(() => process.exit(0));
    }
};

/**
 * Start the scheduler
 */
const startScheduler = async () => {
    console.log('\n╔═══════════════════════════════════════════════════════════╗');
    console.log('║           STAC Crawler Scheduler Started                 ║');
    console.log('╚═══════════════════════════════════════════════════════════╝\n');
    console.log(`Interval: Every ${DAYS_INTERVAL} days`);
    console.log(`Full re-crawl cycles: ${FULL_RECRAWL ? 'enabled (resumable, persisted in crawl_cycle)' : 'disabled'}`);
    console.log(`Run on startup (no cycle yet): ${RUN_ON_STARTUP}`);
    console.log(`Retry on crawl error: ${RETRY_ON_CRAWL_ERROR}`);
    if (RETRY_ON_CRAWL_ERROR) {
        console.log(`   Retry delay: ${RETRY_DELAY_HOURS} hour(s)`);
    }
    console.log(`Time window enforcement: ${ENFORCE_TIME_WINDOW ? 'ENABLED' : 'DISABLED'}`);
    if (ENFORCE_TIME_WINDOW) {
        console.log(`   Allowed hours: ${ALLOWED_START_HOUR}:00 - ${ALLOWED_END_HOUR}:00`);
        console.log(`   Currently in window: ${isWithinAllowedTimeWindow() ? 'YES' : 'NO'}`);
    }
    console.log(`Current time: ${new Date().toLocaleString()}\n`);

    process.on('SIGINT', () => onSignal('SIGINT'));
    process.on('SIGTERM', () => onSignal('SIGTERM'));

    try {
        await db.initDb();
    } catch (err) {
        console.error('\nDATABASE ERROR - Cannot start scheduler.');
        console.error('   Please fix the database connection and try again.\n');
        process.exit(1);
    }

    console.log('Scheduler is running. Press Ctrl+C to stop.\n');
    await loop();
};

// Start the scheduler
startScheduler();
