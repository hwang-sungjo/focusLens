jest.mock('../../backend/src/models/prismaClient', () => ({}));

const {
  RollupVerificationError,
  getRollupCutoffs,
  rollupConcentrationToHourly,
} = require('../../backend/src/services/rollup');

const createClient = (tx) => ({
  $transaction: jest.fn(async (operation) => operation(tx)),
});

describe('roll-up boundaries and transaction safety', () => {
  it('uses only fully closed UTC hour, day, and Monday week boundaries', () => {
    const cutoffs = getRollupCutoffs(new Date('2026-10-05T12:34:56.789Z'));

    expect(cutoffs).toEqual({
      hourly: new Date('2026-09-05T12:00:00.000Z'),
      daily: new Date('2026-07-07T00:00:00.000Z'),
      weekly: new Date('2025-09-29T00:00:00.000Z'),
    });
  });

  it('upserts, verifies, and deletes the exact source row count in one transaction', async () => {
    const tx = {
      $queryRaw: jest.fn()
        .mockResolvedValueOnce([{ source_rows: 3n, log_count: 3n, bucket_count: 2n }])
        .mockResolvedValueOnce([{ mismatch_count: 0n }]),
      $executeRaw: jest.fn()
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(2)
        .mockResolvedValueOnce(3),
    };
    const client = createClient(tx);

    const result = await rollupConcentrationToHourly(
      new Date('2026-09-05T12:00:00.000Z'),
      client,
    );

    expect(result).toEqual(expect.objectContaining({
      stage: 'hourly', source_rows: 3, log_count: 3, bucket_count: 2, deleted_rows: 3,
    }));
    expect(tx.$executeRaw).toHaveBeenCalledTimes(3);
    expect(client.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'Serializable', timeout: 60_000,
    });
  });

  it('throws before DELETE when aggregate verification fails', async () => {
    const tx = {
      $queryRaw: jest.fn()
        .mockResolvedValueOnce([{ source_rows: 3n, log_count: 3n, bucket_count: 1n }])
        .mockResolvedValueOnce([{ mismatch_count: 1n }]),
      $executeRaw: jest.fn()
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(1),
    };
    const client = createClient(tx);

    await expect(rollupConcentrationToHourly(new Date(), client))
      .rejects.toBeInstanceOf(RollupVerificationError);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
  });

  it('does no writes when there are no eligible source buckets', async () => {
    const tx = {
      $queryRaw: jest.fn()
        .mockResolvedValueOnce([{ source_rows: 0n, log_count: 0n, bucket_count: 0n }]),
      $executeRaw: jest.fn().mockResolvedValueOnce(1),
    };
    const client = createClient(tx);

    const result = await rollupConcentrationToHourly(new Date(), client);

    expect(result.deleted_rows).toBe(0);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
  });
});
