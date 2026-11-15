#!/usr/bin/env node
/** Read-only budget snapshot. Budget data can lag and is not a spending cap. */
import {makeAzRunner} from './common.mjs';
import {pathToFileURL} from 'node:url';

export function parseBudget(budget, now = new Date()) {
  const limit = Number(budget?.amount);
  const spent = Number(budget?.currentSpend?.amount);
  const currency = budget?.currentSpend?.unit;
  if (budget?.amount == null || String(budget.amount).trim() === '' || !Number.isFinite(limit) || limit <= 0 || budget?.currentSpend?.amount == null || String(budget.currentSpend.amount).trim() === '' || !Number.isFinite(spent) || spent < 0 || typeof currency !== 'string' || !currency) {
    throw new Error('Azure returned an incomplete or invalid budget; spending is unknown');
  }
  return {checkedAt: now.toISOString(), budgetName: budget.name, currency, budget: limit, reportedSpend: spent,
    reportedRemaining: Math.max(0, limit - spent), reportedFraction: spent / limit,
    note: 'Azure budget figures can lag actual usage; budget alerts do not cap charges.'};
}

export async function getCostSnapshot({az = makeAzRunner(), subscriptionId, budgetName, now, timeoutMs = 30000} = {}) {
  if (!subscriptionId || !budgetName) throw new Error('subscriptionId and budgetName are required');
  const budget = await az(['consumption', 'budget', 'show', '--subscription', subscriptionId, '--budget-name', budgetName], {timeoutMs});
  return parseBudget(budget, now);
}

export async function main({env = process.env, stdout = process.stdout, stderr = process.stderr} = {}) {
  try {
    const snapshot = await getCostSnapshot({subscriptionId: env.AZURE_SUBSCRIPTION_ID, budgetName: env.AZURE_BUDGET_NAME});
    stdout.write(`${JSON.stringify(snapshot)}\n`);
    return 0;
  } catch (error) {
    stderr.write(`Cost snapshot unavailable: ${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
