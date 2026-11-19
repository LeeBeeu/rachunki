// Obliczenia rachunków: kiedy płatność wypada, termin, status, podsumowanie miesiąca.
// Czyste funkcje bez DOM – testowane w tests/rachunki-calc.test.mjs.

export const EVERY = [
  { value: 1, label: 'co miesiąc' },
  { value: 2, label: 'co 2 miesiące' },
  { value: 3, label: 'co kwartał' },
  { value: 6, label: 'co pół roku' },
  { value: 12, label: 'raz w roku' },
  { value: 0, label: 'jednorazowo' },
];

export const CATEGORIES = ['Media', 'Mieszkanie', 'Kredyt', 'Ubezpieczenie', 'Abonamenty', 'Dzieci', 'Samochód', 'Podatki', 'Zakupy', 'Zdrowie', 'Prezenty', 'Inne'];

export const SOON_DAYS = 3;

export const METHODS = [
  { value: 'przelew', label: 'Przelew' },
  { value: 'gotowka', label: 'Gotówka' },
];

export const methodLabel = (v) => METHODS.find((m) => m.value === v)?.label ?? '';

/** Klucz imienia domownika w mapie household.names (Firestore nie lubi kropek w nazwach pól). */
export function nameKey(email) {
  return normalizeEmail(email).replace(/[^a-z0-9]/g, '_');
}

/** Imię do wyświetlenia: zapisane w domu → z konta → część adresu przed @. */
export function displayName(email, names = {}, fallback = '') {
  if (!email) return fallback;
  const n = names[nameKey(email)];
  if (n) return n;
  return fallback || normalizeEmail(email).split('@')[0];
}

/** Tylko „moje” pozycje: przypisane do mnie albo do nikogo i jeszcze niezapłacone przez kogoś innego. */
export function isMine(item, myEmail) {
  const me = normalizeEmail(myEmail);
  if (item.payment) return normalizeEmail(item.payment.payerEmail) === me;
  return !item.bill.payer || normalizeEmail(item.bill.payer) === me;
}

/** 'RRRR-MM' dla roku i miesiąca 0–11. */
export function periodKey(y, m) {
  return `${y}-${String(m + 1).padStart(2, '0')}`;
}

/** 'RRRR-MM' → liczba miesięcy od roku 0. */
export function monthIndex(period) {
  const [y, m] = period.split('-').map(Number);
  return y * 12 + m - 1;
}

export function shiftMonth({ y, m }, delta) {
  const i = y * 12 + m + delta;
  return { y: Math.floor(i / 12), m: ((i % 12) + 12) % 12 };
}

/** Czy płatność wypada w danym miesiącu. every = co ile miesięcy (0 = jednorazowo). */
export function occursIn(bill, period) {
  const diff = monthIndex(period) - monthIndex(bill.start);
  if (diff < 0) return false;
  if (bill.end && monthIndex(period) > monthIndex(bill.end)) return false;
  const every = Number(bill.every);
  return every === 0 ? diff === 0 : diff % every === 0;
}

/** Termin w danym miesiącu; dzień 31 w lutym przesuwa się na ostatni dzień miesiąca. */
export function dueDate(bill, period) {
  const [y, m] = period.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  return new Date(y, m - 1, Math.min(Number(bill.day) || 1, last));
}

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Liczba dni od dziś do terminu (ujemna = po terminie). */
export function daysUntil(due, today) {
  return Math.round((startOfDay(due) - startOfDay(today)) / 864e5);
}

/** 'paid' | 'late' | 'soon' | 'todo' */
export function statusOf(days, paid) {
  if (paid) return 'paid';
  if (days < 0) return 'late';
  if (days <= SOON_DAYS) return 'soon';
  return 'todo';
}

/** Pozycje do pokazania w miesiącu, posortowane po terminie. payments: { [billId]: płatność } */
export function monthItems(bills, payments, period, today) {
  return bills
    .filter((b) => occursIn(b, period))
    .map((bill) => {
      const due = dueDate(bill, period);
      const payment = payments[bill.id] || null;
      const days = daysUntil(due, today);
      return { bill, due, payment, days, status: statusOf(days, !!payment) };
    })
    .sort((a, b) => a.due - b.due || a.bill.name.localeCompare(b.bill.name, 'pl'));
}

/**
 * Podsumowanie miesiąca:
 *  due  – do zapłaty: niezapłacone pozycje ze znaną kwotą (kwota zmienna liczy się jako 0, dopóki jej nie podasz),
 *  paid – faktycznie zapłacone kwoty,
 *  total – razem (zapłacone + do zapłaty),
 *  variableDue – ile niezapłaconych pozycji ma kwotę zmienną.
 */
export function summary(items) {
  let due = 0;
  let paid = 0;
  let paidCount = 0;
  let variableDue = 0;
  for (const i of items) {
    if (i.payment) {
      paid += paidAmount(i.payment, i.bill);
      paidCount += 1;
    } else if (Number(i.bill.amount)) {
      due += Number(i.bill.amount);
    } else {
      variableDue += 1;
    }
  }
  return {
    due: round2(due),
    paid: round2(paid),
    total: round2(due + paid),
    variableDue,
    count: items.length,
    paidCount,
    lateCount: items.filter((i) => i.status === 'late').length,
  };
}

/** Bieżący miesiąc jako 'RRRR-MM'. */
export function currentPeriod(today = new Date()) {
  return periodKey(today.getFullYear(), today.getMonth());
}

/** Zaległe płatności z wcześniejszych miesięcy (do `monthsBack` wstecz), których nikt nie odhaczył. */
export function overdueBefore(bills, paidKeys, period, today, monthsBack = 6) {
  const out = [];
  const end = monthIndex(period);
  for (let i = end - monthsBack; i < end; i++) {
    const p = periodKey(Math.floor(i / 12), i % 12);
    for (const bill of bills) {
      // Miesiące sprzed dodania płatności do aplikacji nie są zaległościami.
      if (bill.trackFrom && p < bill.trackFrom) continue;
      if (occursIn(bill, p) && !paidKeys.has(paymentId(bill.id, p)) && daysUntil(dueDate(bill, p), today) < 0) {
        out.push({ bill, period: p, due: dueDate(bill, p) });
      }
    }
  }
  return out.sort((a, b) => a.due - b.due);
}

export function paymentId(billId, period) {
  return `${billId}_${period}`;
}

/** '1 234,50 zł', '120.5', '99' → liczba; puste lub błędne → 0. */
export function parseAmount(text) {
  const clean = String(text ?? '').replace(/\s|zł|pln/gi, '').replace(',', '.');
  const n = Number.parseFloat(clean);
  return Number.isFinite(n) && n > 0 ? round2(n) : 0;
}

export function round2(n) {
  return Math.round(n * 100) / 100;
}

/** Walidacja formularza; zwraca { bill } albo { error }. */
export function validateBill(input) {
  const name = String(input.name ?? '').trim();
  if (!name) return { error: 'Wpisz nazwę płatności.' };
  if (!/^\d{4}-\d{2}$/.test(input.start ?? '')) return { error: 'Wybierz miesiąc, od którego płatność obowiązuje.' };
  const day = Math.trunc(Number(input.day));
  if (!(day >= 1 && day <= 31)) return { error: 'Dzień płatności musi być od 1 do 31.' };
  const every = Number(input.every);
  if (!EVERY.some((e) => e.value === every)) return { error: 'Wybierz, jak często płatność się powtarza.' };
  const end = input.end || '';
  if (end && (!/^\d{4}-\d{2}$/.test(end) || monthIndex(end) < monthIndex(input.start))) {
    return { error: 'Miesiąc zakończenia nie może być wcześniejszy niż początek.' };
  }
  return {
    bill: {
      name: name.slice(0, 60),
      amount: parseAmount(input.amount),
      day,
      every,
      start: input.start,
      end,
      category: CATEGORIES.includes(input.category) ? input.category : 'Inne',
      note: String(input.note ?? '').trim().slice(0, 200),
      payee: String(input.payee ?? '').trim().slice(0, 80),
      payer: normalizeEmail(input.payer).slice(0, 120),
      forWhom: String(input.forWhom ?? '').trim().slice(0, 40),
      method: METHODS.some((m) => m.value === input.method) ? input.method : 'przelew',
    },
  };
}

export function formatPLN(n) {
  return new Intl.NumberFormat('pl-PL', { style: 'currency', currency: 'PLN' }).format(n || 0);
}

export function normalizeEmail(email) {
  return String(email ?? '').trim().toLowerCase();
}

export function isEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(email));
}

/* ---------- Kwota zapłacona ---------- */

/** Kwota, którą faktycznie zapłacono (albo planowana, gdy nie wpisano innej). */
export function paidAmount(payment, bill) {
  if (!payment) return 0;
  const n = Number(payment.amount ?? bill?.amount);
  return Number.isFinite(n) ? n : 0;
}

/** 'RRRR-MM-DD' (lokalnie) dla daty. */
export function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Jednorazowy wydatek z daty 'RRRR-MM-DD' → pola płatności (every = 0). */
export function oneOffFromDate(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || '');
  if (!m) return null;
  return { start: `${m[1]}-${m[2]}`, day: Number(m[3]), every: 0, end: '' };
}

/* ---------- Historia ---------- */

/** n miesięcy kończących się na `cur` ({y, m}), od najstarszego. */
export function periodsBack(cur, n) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = shiftMonth(cur, -i);
    out.push(periodKey(d.y, d.m));
  }
  return out;
}

/** Dla każdego miesiąca: ile zapłacono i ile było zaplanowane. payments: lista dokumentów zapłat. */
export function historyByMonth(bills, payments, periods) {
  const byId = new Map(bills.map((b) => [b.id, b]));
  return periods.map((period) => {
    let paid = 0;
    let count = 0;
    for (const p of payments) {
      if (p.period !== period) continue;
      paid += paidAmount(p, byId.get(p.billId));
      count += 1;
    }
    // Płatność o zmiennej kwocie (bez kwoty planowanej) liczy się do planu tym, co zapłacono.
    const planned = bills.filter((b) => occursIn(b, period)).reduce((s, b) => {
      if (Number(b.amount)) return s + Number(b.amount);
      const p = payments.find((x) => x.billId === b.id && x.period === period);
      return s + paidAmount(p, b);
    }, 0);
    return { period, paid: round2(paid), planned: round2(planned), count };
  });
}

/** Suma zapłat w kategoriach w podanych miesiącach, od największej. */
export function categoryTotals(bills, payments, periods) {
  return totalsBy(bills, payments, periods, (bill) => bill?.category || 'Inne')
    .map(({ key, total, share }) => ({ category: key, total, share }));
}

/** Suma zapłat pogrupowana kluczem keyFn(bill, payment), od największej. */
export function totalsBy(bills, payments, periods, keyFn) {
  const set = new Set(periods);
  const byId = new Map(bills.map((b) => [b.id, b]));
  const sums = new Map();
  for (const p of payments) {
    if (!set.has(p.period)) continue;
    const bill = byId.get(p.billId);
    const key = keyFn(bill, p);
    sums.set(key, (sums.get(key) || 0) + paidAmount(p, bill));
  }
  const total = [...sums.values()].reduce((a, b) => a + b, 0);
  return [...sums.entries()]
    .map(([key, sum]) => ({ key, total: round2(sum), share: total ? sum / total : 0 }))
    .filter((c) => c.total > 0)
    .sort((a, b) => b.total - a.total);
}

/** Zapłaty jednej płatności, od najnowszej, ze statystyką. */
export function billHistory(bill, payments) {
  const list = payments
    .filter((p) => p.billId === bill.id)
    .map((p) => ({
      period: p.period, amount: paidAmount(p, bill), paidAt: p.paidAt, paidByName: p.paidByName || '', payerEmail: p.payerEmail || '', method: p.method || '',
    }))
    .sort((a, b) => b.period.localeCompare(a.period));
  const amounts = list.map((x) => x.amount);
  return {
    list,
    count: list.length,
    average: amounts.length ? round2(amounts.reduce((a, b) => a + b, 0) / amounts.length) : 0,
    min: amounts.length ? Math.min(...amounts) : 0,
    max: amounts.length ? Math.max(...amounts) : 0,
  };
}

/* ---------- Kalendarz ---------- */

/** Siatka miesiąca od poniedziałku: tygodnie po 7 dat, z dniami sąsiednich miesięcy. */
export function calendarWeeks(y, m) {
  const first = new Date(y, m, 1);
  const offset = (first.getDay() + 6) % 7; // pon = 0
  const start = new Date(y, m, 1 - offset);
  const last = new Date(y, m + 1, 0);
  const weeks = [];
  for (let d = new Date(start); d <= last || weeks.length === 0 || weeks[weeks.length - 1].length < 7;) {
    if (!weeks.length || weeks[weeks.length - 1].length === 7) {
      if (d > last) break;
      weeks.push([]);
    }
    weeks[weeks.length - 1].push(new Date(d));
    d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
  }
  return weeks;
}

/**
 * Zdarzenia dnia w miesiącu: terminy (pozycje z monthItems) i zapłaty wykonane tego dnia
 * (dowolnego okresu, np. zaległa z poprzedniego miesiąca zapłacona dziś).
 * Zwraca Map 'RRRR-MM-DD' → { due: [...items], paid: [{ bill, payment }] }.
 */
export function calendarEvents(items, payments, bills) {
  const out = new Map();
  const at = (key) => {
    if (!out.has(key)) out.set(key, { due: [], paid: [] });
    return out.get(key);
  };
  for (const i of items) at(isoDate(i.due)).due.push(i);
  const byId = new Map(bills.map((b) => [b.id, b]));
  for (const p of payments) {
    if (!p.paidAt) continue;
    const bill = byId.get(p.billId);
    if (!bill) continue;
    at(isoDate(new Date(p.paidAt))).paid.push({ bill, payment: p });
  }
  return out;
}
