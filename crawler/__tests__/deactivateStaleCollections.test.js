import { jest } from '@jest/globals';
import db from '../utils/db.js';

describe('deactivateStaleCollections', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  test('sets is_active=false for collections older than crawl start (7 days window)', async () => {
    const querySpy = jest
      .spyOn(db.pool, 'query')
      .mockResolvedValue({ rowCount: 3 });

    const count = await db.deactivateStaleCollections();

    expect(querySpy).toHaveBeenCalledTimes(1);

    const sql = querySpy.mock.calls[0][0];
    expect(sql).toMatch(/UPDATE\s+collection/i);
    expect(sql).toMatch(/SET\s+is_active\s*=\s*false/i);
    expect(sql).toMatch(/updated_at\s*<\s*NOW\(\)\s*-\s*INTERVAL\s*'7 days'/i);
    expect(sql).toMatch(/AND\s+is_active\s*=\s*true/i);
    expect(count).toBe(3);
  });

  test('returns 0 when no collections are deactivated', async () => {
    jest.spyOn(db.pool, 'query').mockResolvedValue({ rowCount: 0 });

    const count = await db.deactivateStaleCollections();

    expect(count).toBe(0);
  });
});

describe('deactivateStaleCollections with crawl cycle (full re-crawl)', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  test('deactivates collections not refreshed since the start of the cycle', async () => {
    const querySpy = jest
      .spyOn(db.pool, 'query')
      .mockResolvedValue({ rowCount: 2 });

    const count = await db.deactivateStaleCollections({ cycleId: 42 });

    const [sql, params] = querySpy.mock.calls[0];
    expect(sql).toMatch(/SET\s+is_active\s*=\s*false/i);
    expect(sql).toMatch(/updated_at\s*<\s*\(SELECT\s+started_at\s+FROM\s+crawl_cycle\s+WHERE\s+id\s*=\s*\$1\)/i);
    expect(sql).not.toMatch(/INTERVAL/i);
    expect(params).toEqual([42]);
    expect(count).toBe(2);
  });
});

describe('isCollectionUrlCrawled', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  afterEach(() => {
    db.setCurrentCycle(null);
    jest.restoreAllMocks();
  });

  test('resume mode: any existing collection counts as crawled', async () => {
    const querySpy = jest.spyOn(db.pool, 'query').mockResolvedValue({ rows: [{}] });

    await expect(db.isCollectionUrlCrawled('https://x/collections/a')).resolves.toBe(true);

    const [sql, params] = querySpy.mock.calls[0];
    expect(sql).not.toMatch(/crawl_cycle/i);
    expect(params).toEqual(['https://x/collections/a']);
  });

  test('full re-crawl: only collections refreshed during the current cycle count as crawled', async () => {
    db.setCurrentCycle(7);
    const querySpy = jest.spyOn(db.pool, 'query').mockResolvedValue({ rows: [] });

    await expect(db.isCollectionUrlCrawled('https://x/collections/a')).resolves.toBe(false);

    const [sql, params] = querySpy.mock.calls[0];
    expect(sql).toMatch(/updated_at\s*>=\s*\(SELECT\s+started_at\s+FROM\s+crawl_cycle\s+WHERE\s+id\s*=\s*\$2\)/i);
    expect(params).toEqual(['https://x/collections/a', 7]);
  });
});

describe('crawl cycles', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  test('markSourcesCompleted inserts all non-empty ids and ignores duplicates', async () => {
    const querySpy = jest.spyOn(db.pool, 'query').mockResolvedValue({ rowCount: 2 });

    const count = await db.markSourcesCompleted(3, [10, null, 11]);

    const [sql, params] = querySpy.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO crawl_cycle_source/i);
    expect(sql).toMatch(/ON CONFLICT DO NOTHING/i);
    expect(params).toEqual([3, [10, 11]]);
    expect(count).toBe(2);
  });

  test('markSourcesCompleted does nothing without cycle or ids', async () => {
    const querySpy = jest.spyOn(db.pool, 'query');

    expect(await db.markSourcesCompleted(null, [1])).toBe(0);
    expect(await db.markSourcesCompleted(1, [])).toBe(0);
    expect(querySpy).not.toHaveBeenCalled();
  });

  test('completeCycle marks the cycle as overran when it exceeded the interval', async () => {
    const querySpy = jest.spyOn(db.pool, 'query')
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{
        id: 5, started_at: 's', finished_at: 'f', status: 'completed', overran: true,
        ms_until_due: '-1000', duration_ms: '700000000'
      }] });

    const cycle = await db.completeCycle(5, 7);

    const [sql, params] = querySpy.mock.calls[0];
    expect(sql).toMatch(/status\s*=\s*'completed'/i);
    expect(sql).toMatch(/overran\s*=\s*now\(\)\s*>\s*started_at\s*\+\s*make_interval\(days\s*=>\s*\$2\)/i);
    expect(params).toEqual([5, 7]);
    expect(cycle).toMatchObject({ id: 5, overran: true, msUntilDue: -1000, durationMs: 700000000 });
  });

  test('getRunningCycle returns null when there is no open cycle', async () => {
    jest.spyOn(db.pool, 'query').mockResolvedValue({ rows: [] });

    await expect(db.getRunningCycle(7)).resolves.toBeNull();
  });
});
