// Zapis danych. Dwa tryby z tym samym interfejsem:
//  - chmura (Firebase: logowanie Google + Firestore) – wspólna lista dla całej rodziny,
//  - lokalny (localStorage) – gdy firebase-config.js jest pusty; dane tylko na tym urządzeniu.
//
// Model danych w Firestore:
//   households/{hid}                  { name, owner, ownerEmail, members: [e-maile], createdAt }
//   households/{hid}/bills/{id}       { name, amount, day, every, start, end, category, note, createdAt, createdBy }
//   households/{hid}/payments/{billId_RRRR-MM}  { billId, period, amount, paidAt, paidBy, paidByName }

import { firebaseConfig } from './firebase-config.js';
import { normalizeEmail, paymentId, nameKey } from './calc.js';

const FB = 'https://www.gstatic.com/firebasejs/10.12.2';

export function isCloudConfigured() {
  return !!(firebaseConfig && firebaseConfig.apiKey && firebaseConfig.projectId);
}

export async function createStore() {
  return isCloudConfigured() ? createCloudStore() : createLocalStore();
}

/* ---------------- Tryb lokalny ---------------- */

function createLocalStore() {
  const KEY = 'rachunki-local-v1';
  const listeners = new Set();
  const load = () => {
    let d;
    try { d = JSON.parse(localStorage.getItem(KEY)); } catch { d = null; }
    d = d || {};
    return { bills: d.bills || {}, payments: d.payments || {}, household: { names: {}, children: [], ...(d.household || {}) } };
  };
  let data = load();
  const save = () => {
    try { localStorage.setItem(KEY, JSON.stringify(data)); } catch { /* brak miejsca lub tryb prywatny */ }
    listeners.forEach((fn) => fn());
  };
  window.addEventListener('storage', (e) => { if (e.key === KEY) { data = load(); listeners.forEach((fn) => fn()); } });
  const subscribe = (fn) => { listeners.add(fn); fn(); return () => listeners.delete(fn); };
  const id = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  const me = { uid: 'local', name: 'Ty', email: '' };

  return {
    mode: 'local',
    onAuth(cb) { cb({ ...me, emailVerified: true }); return () => {}; },
    async signIn() {},
    async signOut() {},
    async findHousehold() { return { id: 'local', name: 'Na tym urządzeniu', members: [], owner: 'local' }; },
    async createHousehold() { return this.findHousehold(); },
    watchHousehold(cb) {
      return subscribe(() => cb({ id: 'local', name: 'Na tym urządzeniu', members: [], owner: 'local', ...data.household }));
    },
    async setMemberName() {},
    async addChild(name) { if (!data.household.children.includes(name)) data.household.children.push(name); save(); },
    async removeChild(name) { data.household.children = data.household.children.filter((c) => c !== name); save(); },
    watchBills(cb) {
      return subscribe(() => cb(Object.entries(data.bills).map(([bid, b]) => ({ id: bid, ...b }))));
    },
    watchPayments(from, to, cb) {
      return subscribe(() => {
        const out = {};
        for (const [pid, p] of Object.entries(data.payments)) if (p.period >= from && p.period <= to) out[pid] = p;
        cb(out);
      });
    },
    async addBill(bill) { data.bills[id()] = { ...bill, createdAt: new Date().toISOString(), createdBy: me.name }; save(); },
    async updateBill(billId, bill) { data.bills[billId] = { ...data.bills[billId], ...bill }; save(); },
    async deleteBill(billId) {
      delete data.bills[billId];
      for (const [pid, p] of Object.entries(data.payments)) if (p.billId === billId) delete data.payments[pid];
      save();
    },
    async markPaid(bill, period, extra = {}) {
      data.payments[paymentId(bill.id, period)] = {
        billId: bill.id, period, amount: bill.amount || 0, paidAt: new Date().toISOString(), paidBy: me.uid, paidByName: me.name,
        payerEmail: '', method: bill.method || 'przelew', ...extra,
      };
      save();
    },
    async updatePayment(billId, period, fields) {
      const id = paymentId(billId, period);
      if (data.payments[id]) { data.payments[id] = { ...data.payments[id], ...fields }; save(); }
    },
    async unmarkPaid(billId, period) { delete data.payments[paymentId(billId, period)]; save(); },
    async addMember() { throw new Error('Wspólna lista wymaga podłączenia Firebase (patrz README).'); },
    async removeMember() {},
    async renameHousehold() {},
    exportData() { return data; },
  };
}

/* ---------------- Tryb chmury (Firebase) ---------------- */

async function createCloudStore() {
  const [{ initializeApp }, auth, fs] = await Promise.all([
    import(`${FB}/firebase-app.js`),
    import(`${FB}/firebase-auth.js`),
    import(`${FB}/firebase-firestore.js`),
  ]);
  const app = initializeApp(firebaseConfig);
  const a = auth.getAuth(app);
  a.languageCode = 'pl';
  let db;
  try {
    // Dane zostają na telefonie: lista działa bez internetu, zmiany wysyłają się po odzyskaniu sieci.
    db = fs.initializeFirestore(app, { localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }) });
  } catch {
    db = fs.getFirestore(app);
  }
  auth.getRedirectResult(a).catch(() => {});

  let user = null;
  let hid = null;
  const toUser = (u) => ({
    uid: u.uid, name: u.displayName || u.email, email: normalizeEmail(u.email), photo: u.photoURL, emailVerified: u.emailVerified,
  });
  const hh = () => fs.doc(db, 'households', hid);
  const col = (name) => fs.collection(db, 'households', hid, name);

  return {
    mode: 'cloud',
    onAuth(cb) {
      return auth.onAuthStateChanged(a, (u) => {
        user = u ? toUser(u) : null;
        cb(user);
      });
    },
    async signIn() {
      const provider = new auth.GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      try {
        await auth.signInWithPopup(a, provider);
      } catch (e) {
        // Niektóre telefony blokują okienka – wtedy logowanie przez przekierowanie.
        if (['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment', 'auth/cancelled-popup-request'].includes(e.code)) {
          await auth.signInWithRedirect(a, provider);
        } else if (e.code !== 'auth/popup-closed-by-user') {
          throw e;
        }
      }
    },
    async signInEmail(email, password) {
      await auth.signInWithEmailAndPassword(a, normalizeEmail(email), password);
    },
    async signUpEmail(email, password, name) {
      const cred = await auth.createUserWithEmailAndPassword(a, normalizeEmail(email), password);
      if (name) await auth.updateProfile(cred.user, { displayName: name });
      await auth.sendEmailVerification(cred.user, { url: location.href.split('#')[0] });
      user = toUser(cred.user);
    },
    async resetPassword(email) {
      await auth.sendPasswordResetEmail(a, normalizeEmail(email), { url: location.href.split('#')[0] });
    },
    async resendVerification() {
      await auth.sendEmailVerification(a.currentUser, { url: location.href.split('#')[0] });
    },
    /** Po kliknięciu linku w mailu: odśwież dane konta i token (reguły sprawdzają email_verified w tokenie). */
    async refreshUser() {
      if (!a.currentUser) return null;
      await auth.reload(a.currentUser);
      if (a.currentUser.emailVerified) await a.currentUser.getIdToken(true);
      user = toUser(a.currentUser);
      return user;
    },
    async signOut() { hid = null; await auth.signOut(a); },
    async findHousehold() {
      const q = fs.query(fs.collection(db, 'households'), fs.where('members', 'array-contains', user.email));
      const snap = await fs.getDocs(q);
      if (snap.empty) return null;
      const d = snap.docs[0];
      hid = d.id;
      return { id: d.id, ...d.data() };
    },
    async createHousehold(name) {
      const ref = await fs.addDoc(fs.collection(db, 'households'), {
        name: name || 'Nasz dom', owner: user.uid, ownerEmail: user.email, members: [user.email], createdAt: fs.serverTimestamp(),
      });
      hid = ref.id;
      return { id: ref.id, name, members: [user.email], owner: user.uid };
    },
    watchHousehold(cb, onError) {
      return fs.onSnapshot(hh(), (s) => cb(s.exists() ? { id: s.id, ...s.data() } : null), onError);
    },
    watchBills(cb, onError) {
      return fs.onSnapshot(col('bills'), (s) => cb(s.docs.map((d) => ({ id: d.id, ...d.data() }))), onError);
    },
    watchPayments(from, to, cb, onError) {
      const q = fs.query(col('payments'), fs.where('period', '>=', from), fs.where('period', '<=', to));
      return fs.onSnapshot(q, (s) => {
        const out = {};
        s.docs.forEach((d) => { out[d.id] = d.data(); });
        cb(out);
      }, onError);
    },
    async addBill(bill) { await fs.addDoc(col('bills'), { ...bill, createdAt: fs.serverTimestamp(), createdBy: user.name }); },
    async updateBill(billId, bill) { await fs.updateDoc(fs.doc(col('bills'), billId), bill); },
    async deleteBill(billId) {
      const paid = await fs.getDocs(fs.query(col('payments'), fs.where('billId', '==', billId)));
      const batch = fs.writeBatch(db);
      paid.docs.forEach((d) => batch.delete(d.ref));
      batch.delete(fs.doc(col('bills'), billId));
      await batch.commit();
    },
    async markPaid(bill, period, extra = {}) {
      await fs.setDoc(fs.doc(col('payments'), paymentId(bill.id, period)), {
        billId: bill.id, period, amount: bill.amount || 0, paidAt: new Date().toISOString(), paidBy: user.uid, paidByName: user.name,
        payerEmail: user.email, method: bill.method || 'przelew', ...extra,
      });
    },
    async updatePayment(billId, period, fields) {
      await fs.updateDoc(fs.doc(col('payments'), paymentId(billId, period)), fields);
    },
    async unmarkPaid(billId, period) { await fs.deleteDoc(fs.doc(col('payments'), paymentId(billId, period))); },
    async addMember(email) { await fs.updateDoc(hh(), { members: fs.arrayUnion(normalizeEmail(email)) }); },
    async removeMember(email) { await fs.updateDoc(hh(), { members: fs.arrayRemove(normalizeEmail(email)) }); },
    async renameHousehold(name) { await fs.updateDoc(hh(), { name }); },
    async setMemberName(email, name) { await fs.updateDoc(hh(), { [`names.${nameKey(email)}`]: name }); },
    async addChild(name) { await fs.updateDoc(hh(), { children: fs.arrayUnion(name) }); },
    async removeChild(name) { await fs.updateDoc(hh(), { children: fs.arrayRemove(name) }); },
  };
}
