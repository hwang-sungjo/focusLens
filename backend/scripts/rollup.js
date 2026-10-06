#!/usr/bin/env node
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const prisma = require('../src/models/prismaClient');
const { runRollup } = require('../src/services/rollup');
const { logEvent, recordMetric } = require('../src/services/observability');

const main = async () => {
  try {
    const result = await runRollup();
    recordMetric('rollup_runs_total', { result: 'success' });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    recordMetric('rollup_runs_total', { result: 'failure' });
    logEvent('rollup_failed', {
      error_name: error.name,
      error_code: error.code ?? null,
      message: process.env.NODE_ENV === 'production' ? 'rollup_failed' : error.message,
    }, 'error');
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
};

main();
