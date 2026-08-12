/**
 * Maturity engine self-test (no HTTP server required).
 * Usage: node backend/scripts/test-maturity.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const {
  getMaturityCyclePeriod,
  buildMaturityView,
  initMaturityFields,
  calcProfitAmount
} = require('../services/maturityService');
const { getTodayDateStr } = require('../services/profitScheduleService');

let passed = 0;
let failed = 0;

const assert = (name, cond, detail = '') => {
  if (cond) {
    passed += 1;
    console.log('PASS', name);
  } else {
    failed += 1;
    console.error('FAIL', name, detail);
  }
};

// Weekly cycle dates
const w1 = getMaturityCyclePeriod({
  maturityType: 'weekly',
  maturityStartDate: '2026-08-03'
}, 1);
assert('weekly c1 start', w1.periodStart === '2026-08-03', w1.periodStart);
assert('weekly c1 end', w1.maturityDate === '2026-08-09', w1.maturityDate);

const w2 = getMaturityCyclePeriod({
  maturityType: 'weekly',
  maturityStartDate: '2026-08-03'
}, 2);
assert('weekly c2 start', w2.periodStart === '2026-08-10', w2.periodStart);
assert('weekly c2 end', w2.maturityDate === '2026-08-16', w2.maturityDate);

// Monthly
const m1 = getMaturityCyclePeriod({
  maturityType: 'monthly',
  maturityStartDate: '2026-08-03'
}, 1);
assert('monthly c1 maturity', m1.maturityDate === '2026-09-03', m1.maturityDate);

const m2 = getMaturityCyclePeriod({
  maturityType: 'monthly',
  maturityStartDate: '2026-08-03'
}, 2);
assert('monthly c2 maturity', m2.maturityDate === '2026-10-03', m2.maturityDate);

// Custom
const c1 = getMaturityCyclePeriod({
  maturityType: 'custom',
  maturityStartDate: '2026-08-01',
  customMaturityDate: '2026-08-20'
}, 1);
assert('custom maturity', c1.maturityDate === '2026-08-20', c1.maturityDate);

// Status: matured on end date
const invWeekly = {
  maturityEnabled: true,
  maturityType: 'weekly',
  maturityStartDate: '2026-08-03',
  maturityCyclesPaid: 0,
  recurringMaturity: true
};
const viewOnMaturityDay = buildMaturityView(invWeekly, { asOf: new Date('2026-08-09T12:00:00+06:00') });
assert('matured on end date', viewOnMaturityDay.isMatured === true, JSON.stringify(viewOnMaturityDay));

const viewBefore = buildMaturityView(invWeekly, { asOf: new Date('2026-08-08T12:00:00+06:00') });
assert('not matured before end', viewBefore.isMatured === false, JSON.stringify(viewBefore));

// Existing investments without flag → null view
assert('legacy ignored', buildMaturityView({ maturityEnabled: false }) === null);
assert('legacy unset ignored', buildMaturityView({ status: 'active' }) === null);

// Profit calc
assert('22×350', calcProfitAmount(22, 350) === 7700);

// init fields
const fields = initMaturityFields({
  maturityEnabled: true,
  maturityType: 'weekly',
  maturityStartDate: '2026-08-03'
});
assert('init next date', fields.nextMaturityDate === '2026-08-09', fields.nextMaturityDate);
assert('init enabled', fields.maturityEnabled === true);

// Paid one-time custom
const paidCustom = buildMaturityView({
  maturityEnabled: true,
  maturityType: 'custom',
  maturityStartDate: '2026-08-01',
  customMaturityDate: '2026-08-20',
  maturityCyclesPaid: 1,
  recurringMaturity: false
}, { asOf: new Date('2026-08-25T12:00:00+06:00') });
assert('custom paid status', paidCustom.maturityStatus === 'PAID' && paidCustom.isPaid);

console.log('\nToday BD:', getTodayDateStr());
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
