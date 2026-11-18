// Testy obliczeń aplikacji Rachunki. Uruchom: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  occursIn, dueDate, daysUntil, statusOf, monthItems, summary, overdueBefore,
  parseAmount, validateBill, shiftMonth, periodKey, paymentId,
} from '../app/js/calc.js';

const bill = (o) => ({ id: 'b', name: 'Woda', amount: 100, day: 10, every: 1, start: '2026-01', end: '', ...o });

test('płatność co miesiąc wypada od miesiąca startu', () => {
  assert.equal(occursIn(bill(), '2025-12'), false);
  assert.equal(occursIn(bill(), '2026-01'), true);
  assert.equal(occursIn(bill(), '2027-07'), true);
});

test('co 2 miesiące, co kwartał, raz w roku, jednorazowo', () => {
  const two = bill({ every: 2, start: '2026-01' });
  assert.deepEqual(['2026-01', '2026-02', '2026-03', '2026-12', '2027-01'].map((p) => occursIn(two, p)), [true, false, true, false, true]);
  const q = bill({ every: 3, start: '2026-03' });
  assert.deepEqual(['2026-03', '2026-06', '2026-07', '2027-03'].map((p) => occursIn(q, p)), [true, true, false, true]);
  const y = bill({ every: 12, start: '2026-05' });
  assert.deepEqual(['2026-05', '2027-04', '2027-05'].map((p) => occursIn(y, p)), [true, false, true]);
  const once = bill({ every: 0, start: '2026-05' });
  assert.deepEqual(['2026-05', '2026-06'].map((p) => occursIn(once, p)), [true, false]);
});

test('miesiąc zakończenia kończy płatność', () => {
  const b = bill({ end: '2026-03' });
  assert.equal(occursIn(b, '2026-03'), true);
  assert.equal(occursIn(b, '2026-04'), false);
});

test('termin 31 w lutym przesuwa się na ostatni dzień', () => {
  assert.equal(dueDate(bill({ day: 31 }), '2026-02').getDate(), 28);
  assert.equal(dueDate(bill({ day: 31 }), '2028-02').getDate(), 29);
  assert.equal(dueDate(bill({ day: 15 }), '2026-04').getDate(), 15);
});

test('dni do terminu i status', () => {
  const today = new Date(2026, 10, 18, 21, 30);
  assert.equal(daysUntil(new Date(2026, 10, 18), today), 0);
  assert.equal(daysUntil(new Date(2026, 10, 10), today), -8);
  assert.equal(statusOf(-1, false), 'late');
  assert.equal(statusOf(0, false), 'soon');
  assert.equal(statusOf(3, false), 'soon');
  assert.equal(statusOf(4, false), 'todo');
  assert.equal(statusOf(-5, true), 'paid');
});

test('pozycje miesiąca i podsumowanie', () => {
  const today = new Date(2026, 10, 18);
  const bills = [
    bill({ id: 'w', name: 'Woda', day: 10, amount: 150 }),
    bill({ id: 'p', name: 'Prąd', day: 20, amount: 200.5 }),
    bill({ id: 'c', name: 'Czynsz', day: 28, amount: 800 }),
    bill({ id: 'u', name: 'OC', day: 5, every: 12, start: '2026-03', amount: 900 }),
  ];
  const items = monthItems(bills, { p: { amount: 210 } }, '2026-11', today);
  assert.deepEqual(items.map((i) => [i.bill.id, i.status]), [['w', 'late'], ['p', 'paid'], ['c', 'todo']]);
  assert.deepEqual(summary(items), { total: 1150.5, paid: 210, left: 940.5, count: 3, paidCount: 1, lateCount: 1 });
});

test('zaległe z poprzednich miesięcy', () => {
  const today = new Date(2026, 10, 18);
  const bills = [bill({ id: 'w', start: '2026-09' })];
  const paid = new Set([paymentId('w', '2026-09')]);
  const out = overdueBefore(bills, paid, '2026-11', today);
  assert.deepEqual(out.map((o) => o.period), ['2026-10']);
});

test('płatność dodana dziś nie robi zaległości z miesięcy sprzed dodania', () => {
  const today = new Date(2026, 10, 18);
  const bills = [bill({ id: 'w', start: '2026-01', trackFrom: '2026-11' })];
  assert.deepEqual(overdueBefore(bills, new Set(), '2026-11', today), []);
  const later = overdueBefore(bills, new Set(), '2027-01', new Date(2027, 0, 20));
  assert.deepEqual(later.map((o) => o.period), ['2026-11', '2026-12']);
});

test('kwota z polskim zapisem', () => {
  assert.equal(parseAmount('1 234,50 zł'), 1234.5);
  assert.equal(parseAmount('120.456'), 120.46);
  assert.equal(parseAmount(''), 0);
  assert.equal(parseAmount('abc'), 0);
  assert.equal(parseAmount('-5'), 0);
});

test('walidacja formularza', () => {
  assert.equal(validateBill({ name: ' ', start: '2026-01', day: 1, every: 1 }).error, 'Wpisz nazwę płatności.');
  assert.ok(validateBill({ name: 'X', start: '2026-01', day: 32, every: 1 }).error);
  assert.ok(validateBill({ name: 'X', start: '2026-05', end: '2026-01', day: 1, every: 1 }).error);
  const ok = validateBill({ name: ' Woda ', amount: '99,9', start: '2026-01', day: '10', every: '2', category: 'Media' });
  assert.deepEqual(ok.bill, {
    name: 'Woda', amount: 99.9, day: 10, every: 2, start: '2026-01', end: '', category: 'Media', note: '',
    payer: '', forWhom: '', method: 'przelew',
  });
  const full = validateBill({ name: 'Basen', start: '2026-01', day: 5, every: 1, payer: ' Ania@WP.pl ', forWhom: ' Zosia ', method: 'gotowka' });
  assert.deepEqual([full.bill.payer, full.bill.forWhom, full.bill.method], ['ania@wp.pl', 'Zosia', 'gotowka']);
  assert.equal(validateBill({ name: 'X', start: '2026-01', day: 5, every: 1, method: 'karta' }).bill.method, 'przelew');
});

test('przesuwanie miesięcy przez granicę roku', () => {
  assert.deepEqual(shiftMonth({ y: 2026, m: 11 }, 1), { y: 2027, m: 0 });
  assert.deepEqual(shiftMonth({ y: 2026, m: 0 }, -1), { y: 2025, m: 11 });
  assert.equal(periodKey(2026, 0), '2026-01');
});

import {
  paidAmount, oneOffFromDate, periodsBack, historyByMonth, categoryTotals, billHistory, isoDate,
} from '../app/js/calc.js';

test('kwota zapłacona: wpisana albo planowana', () => {
  assert.equal(paidAmount({ amount: 230 }, { amount: 210 }), 230);
  assert.equal(paidAmount({}, { amount: 210 }), 210);
  assert.equal(paidAmount(null, { amount: 210 }), 0);
});

test('jednorazowy wydatek z daty', () => {
  assert.deepEqual(oneOffFromDate('2026-12-05'), { start: '2026-12', day: 5, every: 0, end: '' });
  assert.equal(oneOffFromDate(''), null);
  assert.equal(isoDate(new Date(2026, 0, 3)), '2026-01-03');
});

test('historia: miesiące, kategorie, jedna płatność', () => {
  assert.deepEqual(periodsBack({ y: 2026, m: 1 }, 3), ['2025-12', '2026-01', '2026-02']);
  const bills = [
    { id: 'p', name: 'Prąd', amount: 200, day: 10, every: 1, start: '2025-12', category: 'Media' },
    { id: 'c', name: 'Czynsz', amount: 800, day: 10, every: 1, start: '2026-01', category: 'Mieszkanie' },
    { id: 'n', name: 'Naprawa auta', amount: 500, day: 3, every: 0, start: '2026-02', category: 'Samochód' },
  ];
  const pays = [
    { billId: 'p', period: '2025-12', amount: 180, paidAt: '2025-12-09T10:00:00Z', paidByName: 'Ania' },
    { billId: 'p', period: '2026-01', amount: 240 },
    { billId: 'c', period: '2026-01' },
    { billId: 'n', period: '2026-02', amount: 520 },
  ];
  const periods = ['2025-12', '2026-01', '2026-02'];
  assert.deepEqual(historyByMonth(bills, pays, periods), [
    { period: '2025-12', paid: 180, planned: 200, count: 1 },
    { period: '2026-01', paid: 1040, planned: 1000, count: 2 },
    { period: '2026-02', paid: 520, planned: 1500, count: 1 },
  ]);
  const cats = categoryTotals(bills, pays, periods);
  assert.deepEqual(cats.map((c) => [c.category, c.total]), [['Mieszkanie', 800], ['Samochód', 520], ['Media', 420]]);
  assert.ok(Math.abs(cats.reduce((s, c) => s + c.share, 0) - 1) < 1e-9);
  const variable = [{ id: 'v', amount: 0, day: 1, every: 1, start: '2026-01' }];
  assert.deepEqual(historyByMonth(variable, [{ billId: 'v', period: '2026-01', amount: 99 }], ['2026-01', '2026-02'])
    .map((r) => r.planned), [99, 0]);
  const h = billHistory(bills[0], pays);
  assert.deepEqual(h.list.map((x) => [x.period, x.amount]), [['2026-01', 240], ['2025-12', 180]]);
  assert.deepEqual([h.count, h.average, h.min, h.max], [2, 210, 180, 240]);
});

import { nameKey, displayName, isMine, totalsBy } from '../app/js/calc.js';

test('domownicy: klucz imienia, wyświetlana nazwa', () => {
  assert.equal(nameKey('Ania.Kowalska@wp.pl'), 'ania_kowalska_wp_pl');
  const names = { ania_wp_pl: 'Ania' };
  assert.equal(displayName('ania@wp.pl', names), 'Ania');
  assert.equal(displayName('leszek@gmail.com', names), 'leszek');
  assert.equal(displayName('leszek@gmail.com', names, 'Leszek B.'), 'Leszek B.');
  assert.equal(displayName('', names, 'Ktokolwiek'), 'Ktokolwiek');
});

test('filtr „Moje”: przypisane do mnie albo do nikogo; zapłacone – kto zapłacił', () => {
  const me = 'leszek@gmail.com';
  assert.equal(isMine({ bill: { payer: '' } }, me), true);
  assert.equal(isMine({ bill: { payer: 'leszek@gmail.com' } }, me), true);
  assert.equal(isMine({ bill: { payer: 'ania@wp.pl' } }, me), false);
  assert.equal(isMine({ bill: { payer: '' }, payment: { payerEmail: 'ania@wp.pl' } }, me), false);
  assert.equal(isMine({ bill: { payer: 'ania@wp.pl' }, payment: { payerEmail: me } }, me), true);
});

test('sumy: kto zapłacił i na kogo', () => {
  const bills = [
    { id: 'b', amount: 100, category: 'Dzieci', forWhom: 'Zosia' },
    { id: 'c', amount: 800, category: 'Mieszkanie', forWhom: '' },
  ];
  const pays = [
    { billId: 'b', period: '2026-01', payerEmail: 'ania@wp.pl' },
    { billId: 'c', period: '2026-01', payerEmail: 'leszek@gmail.com' },
    { billId: 'b', period: '2026-02', payerEmail: 'leszek@gmail.com', amount: 120 },
  ];
  const ps = ['2026-01', '2026-02'];
  assert.deepEqual(totalsBy(bills, pays, ps, (b) => b.forWhom || 'Cała rodzina').map((x) => [x.key, x.total]),
    [['Cała rodzina', 800], ['Zosia', 220]]);
  assert.deepEqual(totalsBy(bills, pays, ps, (b, p) => p.payerEmail).map((x) => [x.key, x.total]),
    [['leszek@gmail.com', 920], ['ania@wp.pl', 100]]);
});

import { calendarWeeks, calendarEvents, monthItems as mi } from '../app/js/calc.js';

test('kalendarz: tygodnie od poniedziałku', () => {
  const w = calendarWeeks(2026, 10); // listopad 2026: 1.11 to niedziela
  assert.equal(w.length, 6);
  assert.equal(isoDate(w[0][0]), '2026-10-26');
  assert.equal(isoDate(w[0][6]), '2026-11-01');
  assert.equal(isoDate(w[5][6]), '2026-12-06');
  assert.ok(w.every((week) => week.length === 7));
  const feb = calendarWeeks(2027, 1); // luty 2027: 1.02 to poniedziałek, 28 dni
  assert.equal(feb.length, 4);
  assert.equal(isoDate(feb[0][0]), '2027-02-01');
});

test('kalendarz: terminy i zapłaty w dniach', () => {
  const bills = [
    { id: 'w', name: 'Woda', amount: 100, day: 10, every: 1, start: '2026-01' },
    { id: 'p', name: 'Prąd', amount: 200, day: 20, every: 1, start: '2026-01' },
  ];
  const pays = [
    { billId: 'w', period: '2026-11', paidAt: new Date(2026, 10, 8, 12).toISOString() },
    { billId: 'p', period: '2026-10', paidAt: new Date(2026, 10, 8, 18).toISOString() },
  ];
  const items = mi(bills, { w: pays[0] }, '2026-11', new Date(2026, 10, 18));
  const ev = calendarEvents(items, pays, bills);
  assert.deepEqual(ev.get('2026-11-10').due.map((i) => [i.bill.id, i.status]), [['w', 'paid']]);
  assert.deepEqual(ev.get('2026-11-20').due.map((i) => [i.bill.id, i.status]), [['p', 'soon']]);
  assert.deepEqual(ev.get('2026-11-08').paid.map((x) => x.bill.id), ['w', 'p']);
});
