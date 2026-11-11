-- Crawl cycles for the weekly full re-crawl (crawler/scheduler.js).
--
-- A cycle is one complete pass over all sources in crawllog_catalog. Its state is kept in
-- the database so that a stopped/crashed crawler container continues the running cycle
-- on restart instead of starting over.
--
-- All statements are idempotent, so this script can also be run manually against an
-- existing database (as the admin user, see db/README.md).

-- One row per full re-crawl
-- status: 'running' (open, will be resumed), 'completed', 'abandoned' (replaced via --fresh)
-- overran: true if the cycle took longer than the configured interval (CRAWL_DAYS_INTERVAL)
CREATE TABLE IF NOT EXISTS crawl_cycle (
    id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    started_at TIMESTAMP NOT NULL DEFAULT now(),
    finished_at TIMESTAMP,
    status TEXT NOT NULL DEFAULT 'running',
    overran BOOLEAN NOT NULL DEFAULT FALSE
);

-- At most one open cycle at a time
CREATE UNIQUE INDEX IF NOT EXISTS crawl_cycle_one_running
    ON crawl_cycle (status) WHERE status = 'running';

-- Sources (catalogs/APIs) that were completely crawled within a cycle.
-- Sources without a row here are crawled (again) when the cycle is resumed.
CREATE TABLE IF NOT EXISTS crawl_cycle_source (
    cycle_id INTEGER NOT NULL REFERENCES crawl_cycle(id) ON DELETE CASCADE,
    crawllog_catalog_id INTEGER NOT NULL REFERENCES crawllog_catalog(id) ON DELETE CASCADE,
    completed_at TIMESTAMP NOT NULL DEFAULT now(),
    PRIMARY KEY (cycle_id, crawllog_catalog_id)
);

-- Explicit grants so the script also works when run manually on an existing database
-- (default privileges from 00_users.sh only apply to tables created by the same role).
GRANT SELECT, INSERT, UPDATE, DELETE ON crawl_cycle, crawl_cycle_source TO stac_crawler;
GRANT SELECT ON crawl_cycle, crawl_cycle_source TO stac_api;
