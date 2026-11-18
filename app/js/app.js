// Rachunki – ekrany i obsługa zdarzeń.
import {
  EVERY, CATEGORIES, periodKey, currentPeriod, shiftMonth, monthItems, summary, overdueBefore,
  validateBill, formatPLN, isEmail, normalizeEmail, parseAmount, paidAmount, isoDate, oneOffFromDate, dueDate,
  periodsBack, historyByMonth, categoryTotals, billHistory,
  METHODS, methodLabel, nameKey, displayName, isMine, totalsBy, calendarWeeks, calendarEvents,
} from './calc.js';
import { createStore } from './store.js';

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c != null && c !== false));
  return node;
};

const now = () => new Date();
const state = {
  store: null,
  user: null,
  household: null,
  cur: { y: now().getFullYear(), m: now().getMonth() },
  bills: [],
  payments: {},
  editing: null,
  confirmDelete: false,
  unsub: [],
  unsubPayments: null,
  view: 'board',
  formKind: 'recurring',
  paying: null,
  historyPayments: [],
  unsubHistory: null,
  historyPick: null,
  openBillId: null,
  mineOnly: false,
  calDay: null,
  nameSaved: false,
};

const isCloud = () => state.store?.mode === 'cloud';
/** Imię domownika do wyświetlenia (Ty → imię z konta, gdy nie zapisano innego). */
const nameOf = (email) => displayName(email, state.household?.names || {},
  email && email === state.user?.email ? firstName(state.user.name || '') : '');

const period = () => periodKey(state.cur.y, state.cur.m);
const isCurrentMonth = () => state.cur.y === now().getFullYear() && state.cur.m === now().getMonth();

/* ---------- Start ---------- */

async function init() {
  registerServiceWorker();
  fillSelects();
  bindEvents();
  try {
    state.store = await createStore();
    document.body.classList.toggle('local', state.store.mode === 'local');
  } catch (e) {
    console.error(e);
    return showGate('offline');
  }
  state.store.onAuth(onAuth);
}

async function onAuth(user) {
  stopWatching();
  state.user = user;
  state.household = null;
  if (!user) return showGate('login');
  if (!user.emailVerified) return showGate('verify');
  try {
    const household = await state.store.findHousehold();
    if (!household) return showGate('create');
    startBoard();
  } catch (e) {
    console.error(e);
    showGate('error', e);
  }
}

/* ---------- Ekran startowy ---------- */

function showGate(kind, error) {
  $('board').hidden = true;
  $('history').hidden = true;
  $('views').hidden = true;
  $('addBtn').hidden = true;
  $('menuBtn').hidden = kind === 'login' || kind === 'offline';
  $('hhName').textContent = 'Rachunki';
  const gate = $('gate');
  gate.hidden = false;
  gate.textContent = '';
  const logo = el('img', { src: 'icons/icon.svg', alt: '', className: 'logo' });

  if (kind === 'login') {
    gate.append(logo, el('h2', { textContent: 'Wspólne rachunki' }),
      el('p', { textContent: 'Zaloguj się, aby zobaczyć listę płatności Twojej rodziny i odhaczać zapłacone rachunki.' }),
      loginForm());
  } else if (kind === 'verify') {
    const check = el('button', { className: 'primary', textContent: 'Potwierdziłem – wchodzę' });
    const resend = el('button', { textContent: 'Wyślij link ponownie' });
    const out = el('button', { className: 'ghost', textContent: 'Wyloguj' });
    const msg = el('p', { className: 'err', hidden: true });
    check.onclick = checkVerified.bind(null, msg);
    resend.onclick = async () => {
      resend.disabled = true;
      try { await state.store.resendVerification(); msg.textContent = 'Wysłano nowy link.'; }
      catch (e) { msg.textContent = authError(e); }
      msg.hidden = false;
      setTimeout(() => { resend.disabled = false; }, 30000);
    };
    out.onclick = () => state.store.signOut();
    gate.append(logo, el('h2', { textContent: 'Potwierdź adres e-mail' }),
      el('p', { textContent: `Wysłaliśmy link na adres ${state.user.email}. Otwórz maila (sprawdź też folder Spam lub Oferty), kliknij link, a potem wróć tutaj.` }),
      check, msg, resend, out);
  } else if (kind === 'create') {
    const input = el('input', { id: 'hhNameInput', value: 'Nasz dom', maxLength: 40, ariaLabel: 'Nazwa listy' });
    const btn = el('button', { className: 'primary', textContent: 'Utwórz wspólną listę' });
    const err = el('p', { className: 'err', hidden: true });
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        await state.store.createHousehold(input.value.trim() || 'Nasz dom');
        startBoard();
      } catch (e) {
        console.error(e);
        err.textContent = 'Nie udało się utworzyć listy. Sprawdź połączenie z internetem i reguły Firestore.';
        err.hidden = false;
      }
      btn.disabled = false;
    };
    const out = el('button', { className: 'ghost', textContent: 'Zaloguj na inne konto' });
    out.onclick = () => state.store.signOut();
    gate.append(logo, el('h2', { textContent: 'Witaj!' }),
      el('p', { textContent: `Nie należysz jeszcze do żadnej listy. Jeśli żona lub ktoś z rodziny już ją założył, poproś o dopisanie adresu ${state.user.email} w Ustawieniach → Rodzina, a potem odśwież aplikację.` }),
      el('p', { textContent: 'Możesz też założyć nową listę i zaprosić domowników:' }),
      input, btn, err, out);
  } else if (kind === 'offline') {
    const btn = el('button', { className: 'primary', textContent: 'Spróbuj ponownie' });
    btn.onclick = () => location.reload();
    gate.append(logo, el('h2', { textContent: 'Brak połączenia' }),
      el('p', { textContent: 'Przy pierwszym uruchomieniu aplikacja potrzebuje internetu. Połącz się z siecią i spróbuj ponownie.' }), btn);
  } else {
    const btn = el('button', { className: 'primary', textContent: 'Spróbuj ponownie' });
    btn.onclick = () => onAuth(state.user);
    const out = el('button', { className: 'ghost', textContent: 'Wyloguj' });
    out.onclick = () => state.store.signOut();
    gate.append(logo, el('h2', { textContent: 'Nie udało się wczytać listy' }),
      el('p', { textContent: error?.code === 'permission-denied'
        ? 'Brak dostępu. Sprawdź, czy reguły z pliku firestore.rules są opublikowane w Firebase.'
        : 'Sprawdź połączenie z internetem i spróbuj ponownie.' }), btn, out);
  }
}

function authError(e) {
  switch (e?.code) {
    case 'auth/unauthorized-domain': return 'Ten adres strony nie jest dodany w Firebase (Authentication → Settings → Authorized domains).';
    case 'auth/network-request-failed': return 'Brak połączenia z internetem.';
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found': return 'Nieprawidłowy e-mail lub hasło. Jeśli nie masz jeszcze konta, wybierz „Załóż konto”.';
    case 'auth/email-already-in-use': return 'To konto już istnieje. Wybierz „Mam konto” i zaloguj się.';
    case 'auth/weak-password': return 'Hasło musi mieć co najmniej 6 znaków.';
    case 'auth/invalid-email': return 'Wpisz poprawny adres e-mail.';
    case 'auth/missing-password': return 'Wpisz hasło.';
    case 'auth/too-many-requests': return 'Za dużo prób. Odczekaj kilka minut i spróbuj ponownie.';
    case 'auth/operation-not-allowed': return 'Logowanie e-mailem nie jest włączone w Firebase (Authentication → Sign-in method → Email/Password).';
    default: return 'Nie udało się. Spróbuj ponownie.';
  }
}

/** Formularz logowania: Google albo e-mail i hasło (logowanie, zakładanie konta, reset hasła). */
function loginForm() {
  let mode = 'signin';
  const google = el('button', { className: 'primary', type: 'button', textContent: 'Zaloguj się przez Google' });
  const tabs = el('div', { className: 'tabs', role: 'tablist' });
  const tabIn = el('button', { type: 'button', textContent: 'Mam konto' });
  const tabUp = el('button', { type: 'button', textContent: 'Załóż konto' });
  tabs.append(tabIn, tabUp);
  const name = el('input', { id: 'authName', autocomplete: 'given-name', placeholder: 'Imię (widoczne przy zapłaconych)', maxLength: 30 });
  const email = el('input', { id: 'authEmail', type: 'email', autocomplete: 'email', placeholder: 'Adres e-mail', inputMode: 'email' });
  const pass = el('input', { id: 'authPass', type: 'password', autocomplete: 'current-password', placeholder: 'Hasło' });
  const submit = el('button', { className: 'primary', type: 'submit' });
  const reset = el('button', { className: 'ghost', type: 'button', textContent: 'Nie pamiętam hasła' });
  const msg = el('p', { className: 'err', role: 'alert', hidden: true });
  const form = el('form', { className: 'auth', noValidate: true }, tabs, name, email, pass, submit, msg, reset);

  const setMode = (m) => {
    mode = m;
    tabIn.setAttribute('aria-selected', String(m === 'signin'));
    tabUp.setAttribute('aria-selected', String(m === 'signup'));
    name.hidden = m !== 'signup';
    pass.autocomplete = m === 'signup' ? 'new-password' : 'current-password';
    pass.placeholder = m === 'signup' ? 'Hasło (min. 6 znaków)' : 'Hasło';
    submit.textContent = m === 'signup' ? 'Załóż konto' : 'Zaloguj się';
    reset.hidden = m === 'signup';
    msg.hidden = true;
  };
  tabIn.onclick = () => setMode('signin');
  tabUp.onclick = () => setMode('signup');
  setMode('signin');

  const show = (text, ok) => { msg.textContent = text; msg.className = ok ? 'ok' : 'err'; msg.hidden = false; };
  google.onclick = async () => {
    google.disabled = true;
    try { await state.store.signIn(); } catch (e) { show(authError(e)); }
    google.disabled = false;
  };
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!isEmail(email.value)) return show('Wpisz poprawny adres e-mail.');
    if (!pass.value) return show('Wpisz hasło.');
    submit.disabled = true;
    try {
      if (mode === 'signup') {
        await state.store.signUpEmail(email.value, pass.value, name.value.trim());
        await onAuth(await state.store.refreshUser());
      } else {
        await state.store.signInEmail(email.value, pass.value);
      }
    } catch (err) {
      show(authError(err));
    }
    submit.disabled = false;
  });
  reset.onclick = async () => {
    if (!isEmail(email.value)) return show('Wpisz najpierw swój adres e-mail, a potem kliknij „Nie pamiętam hasła”.');
    try {
      await state.store.resetPassword(email.value);
      show(`Wysłaliśmy link do ustawienia nowego hasła na ${normalizeEmail(email.value)}.`, true);
    } catch (err) { show(authError(err)); }
  };

  return el('div', { className: 'login' }, google, el('p', { className: 'or', textContent: 'albo e-mailem i hasłem' }), form);
}

async function checkVerified(msg) {
  try {
    const user = await state.store.refreshUser();
    if (user?.emailVerified) return onAuth(user);
    msg.textContent = 'Adres nie jest jeszcze potwierdzony. Kliknij link w mailu i spróbuj ponownie.';
  } catch (e) {
    msg.textContent = authError(e);
  }
  msg.hidden = false;
}

/* ---------- Lista ---------- */

function startBoard() {
  $('gate').hidden = true;
  $('views').hidden = false;
  $('menuBtn').hidden = false;
  setView(viewFromHash());
  const s = state.store;
  const onError = (e) => {
    console.error(e);
    if (e?.code === 'permission-denied') { stopWatching(); showGate('error', e); }
  };
  state.unsub.push(s.watchHousehold((h) => {
    if (!h || (s.mode === 'cloud' && !h.members?.includes(state.user.email))) {
      // Ktoś usunął nas z listy.
      stopWatching();
      return showGate('create');
    }
    state.household = h;
    // Zapisz swoje imię w domu, żeby inni widzieli „Ania”, a nie adres e-mail.
    if (isCloud() && !state.nameSaved && state.user?.name && !h.names?.[nameKey(state.user.email)]) {
      state.nameSaved = true;
      s.setMemberName(state.user.email, firstName(state.user.name)).catch((e) => console.error(e));
    }
    fillPeopleSelects();
    render();
    renderHistory();
    $('hhName').textContent = s.mode === 'local' ? 'Rachunki' : h.name;
    renderMenu();
  }, onError));
  state.unsub.push(s.watchBills((bills) => {
    state.bills = bills;
    render();
    renderMenu();
    renderHistory();
  }, onError));
  watchPayments();
  render();
}

function watchPayments() {
  state.unsubPayments?.();
  const from = shiftMonth(state.cur, -6);
  state.unsubPayments = state.store.watchPayments(periodKey(from.y, from.m), period(), (p) => {
    state.payments = p;
    render();
  }, (e) => console.error(e));
}

function stopWatching() {
  state.unsub.forEach((fn) => fn());
  state.unsub = [];
  state.unsubPayments?.();
  state.unsubPayments = null;
  state.unsubHistory?.();
  state.unsubHistory = null;
  state.historyPayments = [];
  state.bills = [];
  state.payments = {};
}

function render() {
  if (!$('calendar').hidden) renderCalendar();
  if ($('board').hidden) return;
  const p = period();
  $('monthLabel').textContent = new Date(state.cur.y, state.cur.m, 1).toLocaleDateString('pl-PL', { month: 'long', year: 'numeric' });

  const forMonth = {};
  for (const pay of Object.values(state.payments)) if (pay.period === p) forMonth[pay.billId] = pay;
  const items = monthItems(state.bills, forMonth, p, now());
  const sum = summary(items);
  $('sTotal').textContent = formatPLN(sum.total);
  $('sPaid').textContent = formatPLN(sum.paid);
  $('sLeft').textContent = formatPLN(sum.left);
  $('progress').style.width = `${sum.count ? (sum.paidCount / sum.count) * 100 : 0}%`;
  $('bar').setAttribute('aria-valuenow', String(sum.paidCount));
  $('bar').setAttribute('aria-valuemax', String(sum.count));

  renderOverdue();

  const groups = $('groups');
  groups.textContent = '';
  if (state.store.mode === 'local') {
    groups.append(el('p', { className: 'notice', textContent: 'Tryb lokalny: dane są tylko na tym urządzeniu. Aby dzielić listę z rodziną, podłącz Firebase (instrukcja w README).' }));
  }
  if (!items.length) {
    groups.append(el('div', { className: 'empty', textContent: state.bills.length
      ? 'W tym miesiącu nie ma zaplanowanych płatności.'
      : 'Lista jest pusta. Dodaj pierwszą płatność, np. wodę, prąd albo czynsz. Pojawi się w każdym miesiącu, w którym trzeba ją zapłacić.' }));
    return;
  }
  const shown = state.mineOnly && isCloud() ? items.filter((i) => isMine(i, state.user?.email)) : items;
  if (!shown.length) {
    groups.append(el('div', { className: 'empty', textContent: 'W tym miesiącu nie masz nic przypisanego do zapłaty.' }));
    return;
  }
  const sections = [['late', 'Po terminie'], ['soon', 'Termin w ciągu 3 dni'], ['todo', 'Do zapłaty'], ['paid', 'Zapłacone']];
  for (const [status, title] of sections) {
    const list = shown.filter((i) => i.status === status);
    if (!list.length) continue;
    groups.append(el('section', { className: 'group' },
      el('h2', { textContent: `${title} · ${list.length}` }),
      el('div', { className: 'list' }, ...list.map((i) => billRow(i, p)))));
  }
}

function billRow(item, p) {
  const { bill, payment, due, days, status } = item;
  const check = el('button', {
    className: 'check', textContent: '✓',
    ariaLabel: `${payment ? 'Cofnij zapłatę' : 'Oznacz jako zapłacone'}: ${bill.name}`,
  });
  check.setAttribute('aria-pressed', String(!!payment));
  check.onclick = () => togglePaid(bill, p, payment);

  const dd = due.toLocaleDateString('pl-PL', { day: 'numeric', month: 'short' });
  let pill;
  if (payment) {
    const when = new Date(payment.paidAt).toLocaleDateString('pl-PL', { day: 'numeric', month: 'short' });
    const who = payment.payerEmail ? nameOf(payment.payerEmail) : firstName(payment.paidByName || '');
    pill = el('span', { className: 'pill paid', textContent: `Zapłacone ${when}${who ? ` · ${who}` : ''}${payment.method === 'gotowka' ? ' · gotówką' : ''}` });
  } else if (status === 'late') {
    pill = el('span', { className: 'pill late', textContent: `Termin minął ${dd} (${-days} dn.)` });
  } else if (status === 'soon') {
    pill = el('span', { className: 'pill soon', textContent: days === 0 ? 'Termin dziś!' : days === 1 ? `Termin jutro, ${dd}` : `Termin ${dd}` });
  } else {
    pill = el('span', { textContent: `Termin ${dd}` });
  }
  const info = el('div', { className: 'info', role: 'button', tabIndex: 0, ariaLabel: `Edytuj: ${bill.name}` },
    el('div', { className: 'name', textContent: bill.name }),
    bill.payee ? el('div', { className: 'payee', textContent: bill.payee }) : null,
    el('div', { className: 'meta' }, pill,
      !payment && bill.payer && isCloud() ? el('span', { className: 'chip who', textContent: `płaci ${nameOf(bill.payer)}` }) : null,
      bill.forWhom ? el('span', { className: 'chip', textContent: bill.forWhom }) : null,
      !payment && bill.method === 'gotowka' ? el('span', { className: 'chip', textContent: 'gotówka' }) : null,
      el('span', { textContent: Number(bill.every) === 0 ? `${bill.category} · jednorazowo` : bill.category }),
      bill.note ? el('span', { className: 'note', textContent: bill.note }) : null));
  info.onclick = () => openBillForm(bill);
  info.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openBillForm(bill); } };
  const planned = Number(bill.amount) || 0;
  const amount = payment ? paidAmount(payment, bill) : planned;
  const amt = el('button', {
    type: 'button', className: 'amt', ariaLabel: `${payment ? 'Zmień zapłaconą kwotę' : 'Zapłać inną kwotą'}: ${bill.name}`,
  }, el('span', { textContent: amount ? formatPLN(amount) : 'zmienna' }),
  payment && planned && amount !== planned ? el('small', { textContent: `plan ${formatPLN(planned)}` }) : null);
  amt.onclick = () => openPaySheet(bill, p, payment);
  return el('div', { className: `bill ${status}` }, check, info, amt);
}

function renderOverdue() {
  const box = $('overdue');
  box.textContent = '';
  if (!isCurrentMonth()) return;
  const paidKeys = new Set(Object.keys(state.payments));
  const list = overdueBefore(state.bills, paidKeys, period(), now());
  if (!list.length) return;
  box.append(el('div', { className: 'overdue' },
    el('h2', { textContent: `Niezapłacone z poprzednich miesięcy · ${list.length}` }),
    ...list.map(({ bill, period: p, due }) => {
      const btn = el('button', { textContent: 'Zapłacone' });
      btn.onclick = () => togglePaid(bill, p, null);
      return el('div', { className: 'item' },
        el('span', { textContent: `${bill.name} – ${due.toLocaleDateString('pl-PL', { day: 'numeric', month: 'long' })}${bill.amount ? `, ${formatPLN(bill.amount)}` : ''}` }), btn);
    })));
}

async function togglePaid(bill, p, payment) {
  // Kwota zmienna: najpierw zapytaj, ile zapłacono.
  if (!payment && !Number(bill.amount)) return openPaySheet(bill, p, null);
  try {
    if (payment) {
      await state.store.unmarkPaid(bill.id, p);
      toast(`Cofnięto: ${bill.name}`);
    } else {
      await state.store.markPaid(bill, p);
      toast(`Zapłacone: ${bill.name}`, 'Inna kwota', () => openPaySheet(bill, p, { amount: bill.amount, paidAt: new Date().toISOString(), paidByName: state.user?.name }));
    }
  } catch (e) {
    console.error(e);
    toast('Nie udało się zapisać. Spróbuj ponownie.');
  }
}

const firstName = (name) => String(name).split(/[\s@]/)[0];

/* ---------- Zapłata: faktyczna kwota i data ---------- */

function openPaySheet(bill, p, payment) {
  state.paying = { bill, period: p, payment };
  const monthName = new Date(Number(p.slice(0, 4)), Number(p.slice(5)) - 1, 1).toLocaleDateString('pl-PL', { month: 'long', year: 'numeric' });
  $('payTitle').textContent = `${bill.name} · ${monthName}`;
  $('payPlan').textContent = [bill.payee ? `Odbiorca: ${bill.payee}` : '',
    Number(bill.amount) ? `Planowana kwota: ${formatPLN(bill.amount)}` : 'Kwota zmienna: wpisz, ile zapłacono.'].filter(Boolean).join(' · ');
  const amount = payment ? paidAmount(payment, bill) : Number(bill.amount) || 0;
  $('pAmount').value = amount ? String(amount).replace('.', ',') : '';
  $('pDate').value = isoDate(payment?.paidAt ? new Date(payment.paidAt) : new Date());
  $('pPayer').value = payment?.payerEmail || bill.payer || state.user?.email || '';
  if ($('pPayer').selectedIndex < 0) $('pPayer').value = state.user?.email || '';
  $('pMethod').value = payment?.method || bill.method || 'przelew';
  $('payWho').textContent = payment?.paidByName ? `Odhaczone przez: ${payment.paidByName}` : '';
  $('payWho').hidden = !payment?.paidByName;
  $('unpayBtn').hidden = !payment;
  $('unpayBtn').textContent = 'Cofnij zapłatę';
  $('paySave').textContent = payment ? 'Zapisz' : 'Zapłacone';
  $('pErr').hidden = true;
  $('paySheet').hidden = false;
  $('pAmount').focus();
}

async function savePayment(e) {
  e.preventDefault();
  const { bill, period: p, payment } = state.paying;
  const amount = parseAmount($('pAmount').value);
  if (!amount) return payError('Wpisz zapłaconą kwotę.');
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec($('pDate').value);
  if (!m) return payError('Wybierz datę zapłaty.');
  const paidAt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12).toISOString();
  $('paySave').disabled = true;
  try {
    const exists = Object.values(state.payments).some((x) => x.billId === bill.id && x.period === p)
      || state.historyPayments.some((x) => x.billId === bill.id && x.period === p);
    const fields = { amount, paidAt, method: $('pMethod').value };
    if (isCloud()) fields.payerEmail = $('pPayer').value;
    if (payment && exists) await state.store.updatePayment(bill.id, p, fields);
    else await state.store.markPaid(bill, p, fields);
    $('paySheet').hidden = true;
    toast(`Zapłacone: ${bill.name}, ${formatPLN(amount)}`);
  } catch (err) {
    console.error(err);
    payError('Nie udało się zapisać. Sprawdź połączenie i spróbuj ponownie.');
  }
  $('paySave').disabled = false;
}

async function unpay() {
  const btn = $('unpayBtn');
  if (!btn.dataset.confirm) { btn.dataset.confirm = '1'; btn.textContent = 'Na pewno cofnąć?'; return; }
  delete btn.dataset.confirm;
  const { bill, period: p } = state.paying;
  try {
    await state.store.unmarkPaid(bill.id, p);
    $('paySheet').hidden = true;
    toast(`Cofnięto: ${bill.name}`);
  } catch (err) {
    console.error(err);
    payError('Nie udało się cofnąć. Spróbuj ponownie.');
  }
}

function payError(text) {
  $('pErr').textContent = text;
  $('pErr').hidden = false;
}

/* ---------- Formularz płatności ---------- */

function fillSelects() {
  $('fEvery').append(...EVERY.filter((e) => e.value !== 0).map((e) => el('option', { value: String(e.value), textContent: e.label })));
  $('fCat').append(...CATEGORIES.map((c) => el('option', { value: c, textContent: c })));
  for (const id of ['fMethod', 'pMethod']) $(id).append(...METHODS.map((m) => el('option', { value: m.value, textContent: m.label })));
  fillPeopleSelects();
}

/** Listy wyboru zależne od domu: kto płaci, kto zapłacił, którego dziecka dotyczy. */
function fillPeopleSelects() {
  const members = state.household?.members || [];
  const keep = (id) => $(id).value;
  const [payer, paid, forWhom] = [keep('fPayer'), keep('pPayer'), keep('fFor')];
  $('fPayer').replaceChildren(el('option', { value: '', textContent: 'Ktokolwiek' }),
    ...members.map((m) => el('option', { value: m, textContent: nameOf(m) })));
  $('pPayer').replaceChildren(...members.map((m) => el('option', { value: m, textContent: nameOf(m) })));
  $('fFor').replaceChildren(el('option', { value: '', textContent: 'Cała rodzina' }),
    ...(state.household?.children || []).map((c) => el('option', { value: c, textContent: c })));
  $('fPayer').value = payer;
  $('pPayer').value = paid;
  $('fFor').value = forWhom;
}

function setFormKind(kind) {
  state.formKind = kind;
  const once = kind === 'once';
  $('kindRecurring').setAttribute('aria-selected', String(!once));
  $('kindOnce').setAttribute('aria-selected', String(once));
  document.querySelectorAll('#billForm .recurring').forEach((n) => { n.hidden = once; });
  document.querySelectorAll('#billForm .once').forEach((n) => { n.hidden = !once; });
  $('fAmountHint').hidden = once;
  $('fName').placeholder = once ? 'np. Naprawa pralki, prezent dla Zosi' : 'np. Woda – wodociągi';
  if (!state.editing) $('formTitle').textContent = once ? 'Nowy wydatek' : 'Nowa płatność';
}

function openBillForm(bill) {
  state.editing = bill || null;
  state.confirmDelete = false;
  const once = bill ? Number(bill.every) === 0 : false;
  $('formTitle').textContent = bill ? (once ? 'Edytuj wydatek' : 'Edytuj płatność') : 'Nowa płatność';
  $('fDate').value = bill && once
    ? `${bill.start}-${String(bill.day).padStart(2, '0')}`
    : isoDate(dueDate({ day: now().getDate() }, period()));
  $('fName').value = bill?.name ?? '';
  $('fPayee').value = bill?.payee ?? '';
  // Podpowiedzi: odbiorcy wpisani już przy innych płatnościach.
  const payees = [...new Set(state.bills.map((b) => b.payee).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pl'));
  $('payeeList').replaceChildren(...payees.map((v) => el('option', { value: v })));
  $('fAmount').value = bill?.amount ? String(bill.amount).replace('.', ',') : '';
  $('fDay').value = bill?.day ?? 10;
  $('fEvery').value = String(bill && !once ? bill.every : 1);
  $('fCat').value = bill?.category ?? 'Media';
  fillPeopleSelects();
  $('fPayer').value = bill?.payer ?? '';
  if ($('fPayer').selectedIndex < 0) $('fPayer').append(el('option', { value: bill.payer, textContent: nameOf(bill.payer), selected: true }));
  const forWhom = bill?.forWhom ?? '';
  if (forWhom && !(state.household?.children || []).includes(forWhom)) $('fFor').append(el('option', { value: forWhom, textContent: forWhom }));
  $('fFor').value = forWhom;
  $('fMethod').value = bill?.method || 'przelew';
  $('fStart').value = bill?.start ?? period();
  $('fEnd').value = bill?.end ?? '';
  $('fNote').value = bill?.note ?? '';
  $('delBtn').hidden = !bill;
  $('delBtn').textContent = 'Usuń';
  $('fErr').hidden = true;
  $('menuSheet').hidden = true;
  // Rodzaju nie zmienia się przy edycji – to inna rzecz (stała płatność vs jednorazowy wydatek).
  $('kindRecurring').disabled = !!bill && once;
  $('kindOnce').disabled = !!bill && !once;
  setFormKind(once ? 'once' : 'recurring');
  $('billSheet').hidden = false;
  if (!bill) $('fName').focus();
}

async function saveBill(e) {
  e.preventDefault();
  let when = { day: $('fDay').value, every: $('fEvery').value, start: $('fStart').value, end: $('fEnd').value };
  if (state.formKind === 'once') {
    when = oneOffFromDate($('fDate').value);
    if (!when) return formError('Wybierz, kiedy trzeba zapłacić.');
  }
  const { bill, error } = validateBill({
    name: $('fName').value, amount: $('fAmount').value, category: $('fCat').value, note: $('fNote').value, ...when,
    payee: $('fPayee').value,
    payer: isCloud() ? $('fPayer').value : '', forWhom: $('fFor').value, method: $('fMethod').value,
  });
  if (error) return formError(error);
  if (state.formKind === 'once' && !bill.amount) return formError('Wpisz kwotę wydatku.');
  $('saveBtn').disabled = true;
  try {
    if (state.editing) await state.store.updateBill(state.editing.id, bill);
    // Jednorazowy wydatek z przeszłości ma się pokazać jako zaległy; stała płatność liczy zaległości od dziś.
    else await state.store.addBill({ ...bill, trackFrom: bill.every === 0 ? bill.start : currentPeriod() });
    $('billSheet').hidden = true;
    toast(state.editing ? 'Zapisano zmiany' : `Dodano: ${bill.name}`);
  } catch (err) {
    console.error(err);
    formError('Nie udało się zapisać. Sprawdź połączenie i spróbuj ponownie.');
  }
  $('saveBtn').disabled = false;
}

async function deleteBill() {
  if (!state.confirmDelete) {
    state.confirmDelete = true;
    $('delBtn').textContent = 'Usunąć razem z historią zapłat?';
    return;
  }
  try {
    await state.store.deleteBill(state.editing.id);
    $('billSheet').hidden = true;
    toast(`Usunięto: ${state.editing.name}`);
  } catch (err) {
    console.error(err);
    formError('Nie udało się usunąć. Spróbuj ponownie.');
  }
}

function formError(text) {
  $('fErr').textContent = text;
  $('fErr').hidden = false;
}

/* ---------- Menu ---------- */

function renderMenu() {
  const s = state.store;
  const h = state.household;
  const local = s?.mode === 'local';
  $('familyBlock').hidden = local;
  if (h && !local) {
    $('members').textContent = '';
    for (const email of h.members || []) {
      const label = el('span', {}, nameOf(email),
        el('small', { textContent: email + (email === h.ownerEmail ? ' · założyciel' : email === state.user?.email ? ' · Ty' : '') }));
      const li = el('li', {}, label);
      const rename = el('button', { textContent: 'Imię' });
      rename.onclick = () => {
        const input = el('input', { value: nameOf(email), maxLength: 30, ariaLabel: `Imię dla ${email}` });
        const ok = el('button', { className: 'primary', textContent: 'Zapisz' });
        ok.onclick = async () => {
          const v = input.value.trim();
          if (!v) return;
          try { await s.setMemberName(email, v); } catch (e) { console.error(e); memberError('Nie udało się zapisać imienia.'); }
        };
        input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); ok.click(); } };
        li.replaceChildren(input, ok);
        input.focus();
      };
      li.append(rename);
      if (email !== h.ownerEmail && email !== state.user?.email) {
        const rm = el('button', { className: 'danger', textContent: 'Usuń' });
        rm.onclick = async () => {
          if (rm.dataset.confirm) {
            try { await s.removeMember(email); } catch (e) { console.error(e); memberError('Nie udało się usunąć osoby.'); }
          } else { rm.dataset.confirm = '1'; rm.textContent = 'Na pewno?'; }
        };
        li.append(rm);
      }
      $('members').append(li);
    }
  }
  $('children').textContent = '';
  const kids = h?.children || [];
  if (!kids.length) $('children').append(el('li', { className: 'hint', textContent: 'Nie dodano jeszcze dzieci.' }));
  for (const c of kids) {
    const rm = el('button', { className: 'danger', textContent: 'Usuń' });
    rm.onclick = async () => {
      if (!rm.dataset.confirm) { rm.dataset.confirm = '1'; rm.textContent = 'Na pewno?'; return; }
      try { await s.removeChild(c); } catch (e) { console.error(e); toast('Nie udało się usunąć.'); }
    };
    $('children').append(el('li', {}, el('span', { textContent: c }), rm));
  }
  const all = [...state.bills].sort((a, b) => a.name.localeCompare(b.name, 'pl'));
  $('allBills').textContent = '';
  if (!all.length) $('allBills').append(el('li', { className: 'hint', textContent: 'Brak płatności.' }));
  for (const b of all) {
    const every = EVERY.find((e) => e.value === Number(b.every))?.label ?? '';
    const edit = el('button', { textContent: 'Edytuj' });
    edit.onclick = () => openBillForm(b);
    $('allBills').append(el('li', {}, el('span', {},
      b.name, b.payee ? el('small', { textContent: b.payee }) : null, el('small', { textContent: Number(b.every) === 0
        ? `${formatPLN(b.amount)} · jednorazowo, ${b.day}.${b.start.slice(5)}.${b.start.slice(0, 4)}`
        : `${b.amount ? formatPLN(b.amount) : 'kwota zmienna'} · ${b.day}. dnia · ${every}${b.end ? ` · do ${b.end}` : ''}` })), edit));
  }
  $('accountInfo').textContent = local
    ? 'Tryb lokalny: dane są zapisane tylko w tej przeglądarce.'
    : `Zalogowano jako ${state.user?.name ?? ''} (${state.user?.email ?? ''}).`;
  $('signOutBtn').hidden = local;
}

async function addMember(e) {
  e.preventDefault();
  const email = normalizeEmail($('memberEmail').value);
  if (!isEmail(email)) return memberError('Wpisz poprawny adres e-mail.');
  if (state.household?.members?.includes(email)) return memberError('Ta osoba już jest na liście.');
  try {
    await state.store.addMember(email);
    $('memberEmail').value = '';
    $('memberErr').hidden = true;
    toast(`Dodano ${email}. Niech otworzy aplikację i zaloguje się tym adresem (Google albo e-mail i hasło).`);
  } catch (err) {
    console.error(err);
    memberError('Nie udało się dodać osoby. Sprawdź połączenie.');
  }
}

function memberError(text) {
  $('memberErr').textContent = text;
  $('memberErr').hidden = false;
}

/* ---------- Zdarzenia ---------- */

function bindEvents() {
  $('prev').onclick = () => changeMonth(-1);
  $('next').onclick = () => changeMonth(1);
  $('monthLabel').onclick = () => { state.cur = { y: now().getFullYear(), m: now().getMonth() }; watchPayments(); render(); };
  $('addBtn').onclick = () => openBillForm(null);
  $('menuBtn').onclick = () => { renderMenu(); $('memberErr').hidden = true; $('menuSheet').hidden = false; };
  $('billForm').addEventListener('submit', saveBill);
  $('kindRecurring').onclick = () => setFormKind('recurring');
  $('clearForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('clearErr');
    const typed = $('clearConfirm').value.trim().toUpperCase();
    if (typed !== 'USUŃ' && typed !== 'USUN') {
      err.textContent = 'Aby potwierdzić, wpisz słowo USUŃ.';
      err.hidden = false;
      return;
    }
    const all = document.querySelector('input[name="clearWhat"]:checked').value === 'all';
    $('clearBtn').disabled = true;
    try {
      const n = await state.store.clearData(all);
      $('clearConfirm').value = '';
      err.hidden = true;
      $('menuSheet').hidden = true;
      const word = n === 1 ? 'wpis' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'wpisy' : 'wpisów';
      toast(all ? `Usunięto wszystkie płatności i zapłaty (${n} ${word}).` : `Usunięto historię zapłat (${n} ${word}).`);
    } catch (x) {
      console.error(x);
      err.textContent = 'Nie udało się usunąć. Sprawdź połączenie i spróbuj ponownie.';
      err.hidden = false;
    }
    $('clearBtn').disabled = false;
  });
  $('childForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('childName').value.trim().slice(0, 40);
    if (!name) return;
    try { await state.store.addChild(name); $('childName').value = ''; } catch (err) { console.error(err); toast('Nie udało się dodać.'); }
  });
  const setMine = (on) => {
    state.mineOnly = on;
    $('fltAll').setAttribute('aria-selected', String(!on));
    $('fltMine').setAttribute('aria-selected', String(on));
    render();
  };
  $('fltAll').onclick = () => setMine(false);
  $('fltMine').onclick = () => setMine(true);
  $('kindOnce').onclick = () => setFormKind('once');
  $('payForm').addEventListener('submit', savePayment);
  $('unpayBtn').onclick = unpay;
  $('tabBoard').onclick = () => goView('board');
  $('tabCalendar').onclick = () => goView('calendar');
  $('tabHistory').onclick = () => goView('history');
  window.addEventListener('hashchange', () => { if (!$('views').hidden) setView(viewFromHash()); });
  $('calPrev').onclick = () => { state.calDay = null; changeMonth(-1); };
  $('calNext').onclick = () => { state.calDay = null; changeMonth(1); };
  $('calLabel').onclick = () => { state.calDay = null; state.cur = { y: now().getFullYear(), m: now().getMonth() }; watchPayments(); render(); };
  let resizeTimer;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(renderHistory, 150); });
  $('delBtn').onclick = deleteBill;
  $('memberForm').addEventListener('submit', addMember);
  $('signOutBtn').onclick = async () => { $('menuSheet').hidden = true; await state.store.signOut(); };
  for (const sheet of document.querySelectorAll('.sheet')) {
    sheet.addEventListener('click', (e) => { if (e.target === sheet || e.target.closest('[data-close]')) sheet.hidden = true; });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') document.querySelectorAll('.sheet').forEach((s) => { s.hidden = true; });
  });
  // Po powrocie do aplikacji (np. następnego dnia) przelicz terminy.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    render();
    // Powrót z poczty po kliknięciu linku potwierdzającego – sprawdź od razu.
    if (state.user && !state.user.emailVerified && !$('gate').hidden) checkVerified($('gate').querySelector('.err') || document.createElement('p'));
  });
}

function changeMonth(delta) {
  state.cur = shiftMonth(state.cur, delta);
  watchPayments();
  render();
}

let toastTimer;
function toast(text, actionLabel, action) {
  $('toastText').textContent = text;
  const btn = $('toastAction');
  btn.hidden = !actionLabel;
  if (actionLabel) {
    btn.textContent = actionLabel;
    btn.onclick = () => { $('toast').hidden = true; action(); };
  }
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, actionLabel ? 6000 : 3500);
}

/* ---------- Instalacja i aktualizacje ---------- */

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js').then((reg) => {
    reg.addEventListener('updatefound', () => {
      const sw = reg.installing;
      sw?.addEventListener('statechange', () => {
        if (sw.state === 'installed' && navigator.serviceWorker.controller) $('updateBar').hidden = false;
      });
    });
  }).catch(() => {});
  $('reloadBtn').onclick = () => location.reload();
}

init();

/* ---------- Widok: Miesiąc / Historia ---------- */

const VIEW_HASH = { board: '', calendar: '#kalendarz', history: '#historia' };
const viewFromHash = () => (location.hash === '#historia' ? 'history' : location.hash === '#kalendarz' ? 'calendar' : 'board');

/** Przełączanie zakładek tak, żeby przycisk „wstecz” telefonu wracał do widoku Miesiąc. */
function goView(view) {
  if (view === state.view) return;
  if (view === 'board') {
    if (location.hash) history.back(); else setView('board');
  } else if (state.view === 'board') {
    location.hash = VIEW_HASH[view].slice(1);
  } else {
    location.replace(VIEW_HASH[view]);
  }
}

function setView(view) {
  state.view = view;
  $('board').hidden = view !== 'board';
  $('calendar').hidden = view !== 'calendar';
  $('history').hidden = view !== 'history';
  $('addBtn').hidden = view === 'history';
  $('tabBoard').setAttribute('aria-selected', String(view === 'board'));
  $('tabCalendar').setAttribute('aria-selected', String(view === 'calendar'));
  $('tabHistory').setAttribute('aria-selected', String(view === 'history'));
  if (view === 'history' && !state.unsubHistory) {
    const periods = historyPeriods();
    state.unsubHistory = state.store.watchPayments(periods[0], periods[periods.length - 1], (map) => {
      state.historyPayments = Object.values(map);
      renderHistory();
    }, (e) => console.error(e));
  }
  if (view === 'history') renderHistory(); else render();
  window.scrollTo(0, 0);
}

const historyPeriods = () => periodsBack({ y: now().getFullYear(), m: now().getMonth() }, 12);
const monthShort = (p) => new Date(Number(p.slice(0, 4)), Number(p.slice(5)) - 1, 1).toLocaleDateString('pl-PL', { month: 'short' }).replace('.', '');
const monthLong = (p) => new Date(Number(p.slice(0, 4)), Number(p.slice(5)) - 1, 1).toLocaleDateString('pl-PL', { month: 'long', year: 'numeric' });
const compactPLN = (n) => `${new Intl.NumberFormat('pl-PL', { notation: 'compact', maximumFractionDigits: 1 }).format(n)} zł`;
const SVG = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}) => {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};

/** Zaokrąglenie skali w górę do „ładnej” wartości (1, 2, 2,5, 5 × 10^n). */
function niceMax(v) {
  if (v <= 0) return 100;
  const pow = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * pow >= v) return m * pow;
  return 10 * pow;
}

/** Słupek z zaokrąglonym górnym końcem (4 px), oparty o oś. */
function barPath(x, y, w, h, r = 4) {
  if (h <= 0) return '';
  const rr = Math.min(r, h, w / 2);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

function renderHistory() {
  if ($('history').hidden) return;
  const periods = historyPeriods();
  const rows = historyByMonth(state.bills, state.historyPayments, periods);
  const firstIdx = rows.findIndex((r) => r.count > 0);
  const active = firstIdx < 0 ? [] : rows.slice(firstIdx);
  const total = rows.reduce((a, r) => a + r.paid, 0);
  $('hTotal').textContent = formatPLN(total);
  $('hAvg').textContent = active.length ? formatPLN(total / active.length) : '—';

  // Wykres miesięcy
  const box = $('hChart');
  box.textContent = '';
  if (!active.length) {
    box.append(el('p', { className: 'empty', textContent: 'Wykres pojawi się, gdy odhaczysz pierwsze zapłacone rachunki.' }));
    $('hReadout').textContent = '';
  } else {
    drawMonths(box, rows);
  }

  // Kategorie
  const cats = categoryTotals(state.bills, state.historyPayments, periods);
  barList($('hCats'), cats.map((c) => ({ label: c.category, total: c.total, share: c.share })));
  const payers = totalsBy(state.bills, state.historyPayments, periods, (b, p) => p.payerEmail || '');
  barList($('hPayers'), payers.map((c) => ({ label: c.key ? nameOf(c.key) : 'Nie wiadomo (stare wpisy)', total: c.total, share: c.share })));
  const forWhom = totalsBy(state.bills, state.historyPayments, periods, (b) => b?.forWhom || 'Cała rodzina');
  barList($('hFor'), forWhom.map((c) => ({ label: c.key, total: c.total, share: c.share })));

  // Każda płatność osobno
  const billBox = $('hBills');
  billBox.textContent = '';
  const withHistory = state.bills
    .map((b) => ({ bill: b, h: billHistory(b, state.historyPayments) }))
    .filter((x) => x.h.count > 0 || Number(x.bill.every) !== 0)
    .sort((a, b) => b.h.count - a.h.count || a.bill.name.localeCompare(b.bill.name, 'pl'));
  if (!withHistory.length) billBox.append(el('p', { className: 'hint', textContent: 'Brak płatności.' }));
  for (const { bill, h } of withHistory) {
    const open = state.openBillId === bill.id;
    const head = el('button', { type: 'button', className: 'bh-head', ariaExpanded: String(open) },
      el('span', { className: 'name', textContent: bill.name }),
      el('small', { textContent: h.count
        ? `${h.count} ${h.count === 1 ? 'zapłata' : h.count < 5 ? 'zapłaty' : 'zapłat'} · średnio ${formatPLN(h.average)}`
        : 'jeszcze bez zapłat' }));
    head.setAttribute('aria-expanded', String(open));
    head.onclick = () => { state.openBillId = open ? null : bill.id; renderHistory(); };
    const item = el('div', { className: 'bh' }, head);
    if (open && h.count) {
      if (h.count > 1) {
        item.append(el('p', { className: 'hint', textContent: `Najmniej ${formatPLN(h.min)}, najwięcej ${formatPLN(h.max)}.` }));
        item.append(miniBars(periods, h.list));
      }
      item.append(el('ul', { className: 'bh-list' }, ...h.list.map((x) => el('li', {},
        el('span', { textContent: monthLong(x.period) }),
        el('span', { className: 'who', textContent: [
          x.paidAt ? new Date(x.paidAt).toLocaleDateString('pl-PL', { day: 'numeric', month: 'short' }) : '',
          x.payerEmail ? nameOf(x.payerEmail) : firstName(x.paidByName || ''),
          x.method === 'gotowka' ? 'gotówką' : '',
        ].filter(Boolean).join(' · ') }),
        el('b', { textContent: formatPLN(x.amount) })))));
    }
    billBox.append(item);
  }
}

function drawMonths(box, rows) {
  const W = Math.max(280, box.clientWidth || 340);
  const H = 200;
  const pad = { l: 60, r: 4, t: 10, b: 24 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const max = niceMax(Math.max(...rows.map((r) => r.paid)));
  const y = (v) => pad.t + ih - (v / max) * ih;
  const band = iw / rows.length;
  const bw = Math.max(6, Math.min(28, band - 2));
  const chart = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': 'Zapłacone kwoty w ostatnich 12 miesiącach' });

  for (const t of [0, max / 2, max]) {
    chart.append(svg('line', { x1: pad.l, x2: W - pad.r, y1: y(t), y2: y(t), class: t ? 'grid' : 'axis' }));
    const label = svg('text', { x: pad.l - 6, y: y(t) + 4, 'text-anchor': 'end', class: 'tick' });
    label.textContent = t ? compactPLN(t) : '0';
    chart.append(label);
  }
  const current = rows.length - 1;
  if (state.historyPick == null || state.historyPick >= rows.length) state.historyPick = current;
  const bars = [];
  rows.forEach((r, i) => {
    const cx = pad.l + band * i + band / 2;
    const bar = svg('path', { d: barPath(cx - bw / 2, y(r.paid), bw, pad.t + ih - y(r.paid)), class: i === current ? 'bar now' : 'bar' });
    bars.push(bar);
    chart.append(bar);
    const lbl = svg('text', { x: cx, y: H - 6, 'text-anchor': 'middle', class: 'tick' });
    lbl.textContent = rows.length > 8 && W < 360 && i % 2 !== current % 2 ? '' : monthShort(r.period);
    chart.append(lbl);
    const hit = svg('rect', { x: pad.l + band * i, y: 0, width: band, height: H, class: 'hit', tabindex: 0 });
    const pick = () => { state.historyPick = i; mark(); };
    hit.addEventListener('pointerenter', pick);
    hit.addEventListener('click', pick);
    hit.addEventListener('focus', pick);
    chart.append(hit);
  });
  const mark = () => {
    bars.forEach((b, i) => b.classList.toggle('dim', i !== state.historyPick));
    const r = rows[state.historyPick];
    $('hReadout').textContent = r.count
      ? `${monthLong(r.period)}: zapłacono ${formatPLN(r.paid)}${r.planned ? ` (plan ${formatPLN(r.planned)})` : ''}, ${r.count} ${r.count === 1 ? 'płatność' : r.count < 5 ? 'płatności' : 'płatności'}`
      : `${monthLong(r.period)}: brak zapłat`;
  };
  mark();
  box.append(chart);

  // Widok tabeli – te same liczby co na wykresie.
  const table = el('table', {},
    el('thead', {}, el('tr', {}, el('th', { textContent: 'Miesiąc' }), el('th', { textContent: 'Zapłacono' }), el('th', { textContent: 'Plan' }))),
    el('tbody', {}, ...[...rows].reverse().map((r) => el('tr', {},
      el('td', { textContent: monthLong(r.period) }), el('td', { textContent: formatPLN(r.paid) }), el('td', { textContent: formatPLN(r.planned) })))));
  box.append(el('details', { className: 'table-view' }, el('summary', { textContent: 'Pokaż jako tabelę' }), el('div', { className: 'table-wrap' }, table)));
}

function miniBars(periods, list) {
  const byPeriod = new Map(list.map((x) => [x.period, x.amount]));
  const W = 300;
  const H = 56;
  const max = Math.max(...list.map((x) => x.amount), 1);
  const band = W / periods.length;
  const bw = Math.min(16, band - 3);
  const chart = svg('svg', { viewBox: `0 0 ${W} ${H + 14}`, class: 'mini', role: 'img', 'aria-label': 'Kwoty zapłat w kolejnych miesiącach' });
  periods.forEach((p, i) => {
    const v = byPeriod.get(p) || 0;
    const h = (v / max) * H;
    const x = band * i + (band - bw) / 2;
    if (v) {
      const b = svg('path', { d: barPath(x, H - h, bw, h, 3), class: 'bar' });
      const t = svg('title');
      t.textContent = `${monthLong(p)}: ${formatPLN(v)}`;
      b.append(t);
      chart.append(b);
    }
    if (i === 0 || i === periods.length - 1) {
      const l = svg('text', { x: band * i + band / 2, y: H + 12, 'text-anchor': 'middle', class: 'tick' });
      l.textContent = monthShort(p);
      chart.append(l);
    }
  });
  chart.append(svg('line', { x1: 0, x2: W, y1: H, y2: H, class: 'axis' }));
  return chart;
}

/** Lista poziomych słupków (jeden kolor): etykieta, kwota, udział. */
function barList(box, rows) {
  box.textContent = '';
  if (!rows.length) {
    box.append(el('p', { className: 'hint', textContent: 'Brak zapłat w ostatnich 12 miesiącach.' }));
    return;
  }
  const max = Math.max(...rows.map((r) => r.total), 1);
  for (const r of rows) {
    const track = el('div', { className: 'hbar' }, el('i', {}));
    track.firstChild.style.width = `${(r.total / max) * 100}%`;
    box.append(el('div', { className: 'cat' },
      el('div', { className: 'cat-head' }, el('span', { textContent: r.label }),
        el('b', { textContent: formatPLN(r.total) }), el('small', { textContent: `${Math.round(r.share * 100)}%` })),
      track));
  }
}

/* ---------- Kalendarz ---------- */

const WEEKDAYS = ['pn', 'wt', 'śr', 'cz', 'pt', 'so', 'nd'];
const STATUS_TEXT = { paid: 'zapłacone', late: 'po terminie', soon: 'termin wkrótce', todo: 'do zapłaty' };

function renderCalendar() {
  const p = period();
  $('calLabel').textContent = new Date(state.cur.y, state.cur.m, 1).toLocaleDateString('pl-PL', { month: 'long', year: 'numeric' });
  const forMonth = {};
  for (const pay of Object.values(state.payments)) if (pay.period === p) forMonth[pay.billId] = pay;
  const items = monthItems(state.bills, forMonth, p, now());
  const events = calendarEvents(items, Object.values(state.payments), state.bills);
  const todayKey = isoDate(now());
  if (!state.calDay || state.calDay.slice(0, 7) !== p) {
    state.calDay = todayKey.slice(0, 7) === p ? todayKey
      : [...events.keys()].filter((k) => k.slice(0, 7) === p).sort()[0] || `${p}-01`;
  }

  const grid = $('calGrid');
  grid.textContent = '';
  grid.append(...WEEKDAYS.map((d) => el('div', { className: 'wd', textContent: d, ariaHidden: 'true' })));
  for (const week of calendarWeeks(state.cur.y, state.cur.m)) {
    for (const date of week) {
      const key = isoDate(date);
      const inMonth = date.getMonth() === state.cur.m;
      if (!inMonth) { grid.append(el('div', { className: 'day out' }, el('span', { className: 'num', textContent: date.getDate() }))); continue; }
      const ev = events.get(key) || { due: [], paid: [] };
      const cls = ['day'];
      if (key === todayKey) cls.push('today');
      if (key === state.calDay) cls.push('sel');
      if (ev.due.some((i) => i.status === 'late')) cls.push('has-late');
      const dots = el('span', { className: 'dots' }, ...ev.due.slice(0, 4).map((i) => el('i', { className: `dot ${i.status}` })));
      const label = [date.toLocaleDateString('pl-PL', { day: 'numeric', month: 'long' }),
        ev.due.length ? `terminy: ${ev.due.map((i) => `${i.bill.name} (${STATUS_TEXT[i.status]})`).join(', ')}` : '',
        ev.paid.length ? `zapłacono: ${ev.paid.map((x) => x.bill.name).join(', ')}` : ''].filter(Boolean).join('; ');
      const cell = el('button', { type: 'button', className: cls.join(' '), ariaLabel: label },
        el('span', { className: 'num', textContent: date.getDate() }), dots,
        ev.due.length > 4 ? el('span', { className: 'more', textContent: `+${ev.due.length - 4}` }) : null,
        ev.paid.length ? el('i', { className: 'paid-mark', textContent: '✓', ariaHidden: 'true' }) : null);
      cell.setAttribute('aria-pressed', String(key === state.calDay));
      cell.onclick = () => { state.calDay = key; renderCalendar(); };
      grid.append(cell);
    }
  }
  renderCalDay(events.get(state.calDay) || { due: [], paid: [] }, p);
}

function renderCalDay(ev, p) {
  const box = $('calDay');
  box.textContent = '';
  const [y, m, d] = state.calDay.split('-').map(Number);
  box.append(el('h2', { textContent: new Date(y, m - 1, d).toLocaleDateString('pl-PL', { weekday: 'long', day: 'numeric', month: 'long' }) }));
  if (!ev.due.length && !ev.paid.length) {
    box.append(el('p', { className: 'hint', textContent: 'Tego dnia nie ma terminów ani zapłat.' }));
    return;
  }
  if (ev.due.length) {
    box.append(el('p', { className: 'cal-day-h', textContent: 'Termin płatności' }));
    box.append(el('ul', { className: 'cal-list' }, ...ev.due.map((i) => {
      const amount = i.payment ? paidAmount(i.payment, i.bill) : Number(i.bill.amount) || 0;
      const sub = i.payment
        ? `zapłacone ${new Date(i.payment.paidAt).toLocaleDateString('pl-PL', { day: 'numeric', month: 'short' })}${i.payment.payerEmail ? ` · ${nameOf(i.payment.payerEmail)}` : ''}`
        : [STATUS_TEXT[i.status], i.bill.payer && isCloud() ? `płaci ${nameOf(i.bill.payer)}` : '', i.bill.forWhom, i.bill.method === 'gotowka' ? 'gotówka' : '']
          .filter(Boolean).join(' · ');
      const li = el('li', {}, el('i', { className: `dot ${i.status}` }),
        el('span', {}, i.bill.name, el('small', { textContent: i.bill.payee ? `${i.bill.payee} · ${sub}` : sub })),
        el('b', { textContent: amount ? formatPLN(amount) : 'zmienna' }));
      li.onclick = () => openPaySheet(i.bill, p, i.payment);
      li.style.cursor = 'pointer';
      return li;
    })));
  }
  if (ev.paid.length) {
    box.append(el('p', { className: 'cal-day-h', textContent: 'Zapłacono tego dnia' }));
    box.append(el('ul', { className: 'cal-list' }, ...ev.paid.map(({ bill, payment }) => el('li', {},
      el('i', { className: 'paid-mark', textContent: '✓' }),
      el('span', {}, bill.name, el('small', { textContent: [
        payment.period !== p ? `za ${monthLong(payment.period)}` : '',
        payment.payerEmail ? nameOf(payment.payerEmail) : firstName(payment.paidByName || ''),
        payment.method === 'gotowka' ? 'gotówką' : '',
      ].filter(Boolean).join(' · ') })),
      el('b', { textContent: formatPLN(paidAmount(payment, bill)) })))));
  }
}
