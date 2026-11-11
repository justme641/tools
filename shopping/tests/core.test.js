const assert = require('assert');
const C = require('../core.js');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok -', name); };

t('單價：ml 與入數', () => {
  const u = C.unitPrice(120, { size: 500, unit: 'ml', packQty: 6 });
  assert.strictEqual(u.label, '每 100ml'); assert.ok(Math.abs(u.value - 4) < 1e-9);
});
t('單價：l 換算 ml', () => {
  const u = C.unitPrice(90, { size: 1.5, unit: 'l', packQty: 1 });
  assert.strictEqual(u.label, '每 100ml'); assert.ok(Math.abs(u.value - 6) < 1e-9);
});
t('單價：kg 換算 g；片數算每 1', () => {
  assert.ok(Math.abs(C.unitPrice(200, { size: 2, unit: 'kg' }).value - 10) < 1e-9);
  const p = C.unitPrice(120, { size: 30, unit: '片', packQty: 2 });
  assert.strictEqual(p.label, '每片'); assert.ok(Math.abs(p.value - 2) < 1e-9);
});
t('單價：缺容量回傳 null', () => { assert.strictEqual(C.unitPrice(50, { unit: 'ml' }), null); });

t('進位：逐行四捨五入', () => {
  const r = C.cartTotals([{ price: 37.5, qty: 1 }, { price: 37.5, qty: 1 }], 'line-round');
  assert.strictEqual(r.total, 76); // 38 + 38
});
t('進位：整單四捨五入', () => {
  const r = C.cartTotals([{ price: 37.5, qty: 1 }, { price: 37.5, qty: 1 }], 'total-round');
  assert.strictEqual(r.total, 75);
});
t('進位：捨去與進位', () => {
  assert.strictEqual(C.cartTotals([{ price: 10.4, qty: 3 }], 'line-floor').total, 31);
  assert.strictEqual(C.cartTotals([{ price: 10.4, qty: 3 }], 'line-ceil').total, 32);
  assert.strictEqual(C.cartTotals([{ price: 10.5, qty: 1 }], 'line-round').total, 11);
});
t('購物車數量與空車', () => {
  assert.strictEqual(C.cartTotals([], 'line-round').total, 0);
  assert.strictEqual(C.cartTotals([{ price: 20, qty: 3 }, { price: 5, qty: 2 }], 'line-round').qtyCount, 5);
});

t('最新價與最低價', () => {
  const ps = [
    { id: 1, storeId: 'a', price: 50, date: '2026-10-01' },
    { id: 2, storeId: 'a', price: 45, date: '2026-11-01' },
    { id: 3, storeId: 'b', price: 40, date: '2026-09-01' }];
  const m = C.latestByStore(ps);
  assert.strictEqual(m.a.price, 45); assert.strictEqual(m.b.price, 40);
  assert.strictEqual(C.lowestPrice(ps).price, 40);
});
t('搜尋網址', () => {
  assert.strictEqual(C.searchUrl('https://x.com/s?q={q}', '洗髮精 500ml'), 'https://x.com/s?q=%E6%B4%97%E9%AB%AE%E7%B2%BE%20500ml');
  assert.ok(C.isHttpUrl('https://a.com/b')); assert.ok(!C.isHttpUrl('javascript:alert(1)'));
});

const base = () => ({
  items: [{ id: 'i1', barcode: '4710000000011', name: '牙膏', photo: 'data:x' }],
  stores: [{ id: 's1', name: '全聯' }],
  prices: [{ id: 'p1', itemId: 'i1', storeId: 's1', price: 60, date: '2026-11-01' }],
  settings: { backupDays: 14 }
});
t('匯出不含照片、版本', () => {
  const e = C.buildExport(base(), { photos: false });
  assert.strictEqual(e.version, 1); assert.strictEqual(e.items[0].photo, undefined);
  assert.strictEqual(C.buildExport(base(), { photos: true }).items[0].photo, 'data:x');
});
t('匯入驗證與補表', () => {
  const m = C.migrate(C.buildExport(base(), {}));
  assert.ok(Array.isArray(m.records) && Array.isArray(m.promoRules));
  assert.throws(() => C.migrate({ app: 'other', version: 1 }));
  assert.throws(() => C.migrate({ app: 'shopping-db', version: 99 }));
});
t('合併：同條碼對應既有商品、價格改掛', () => {
  const cur = C.migrate(C.buildExport(base(), {}));
  const inc = C.migrate({
    app: 'shopping-db', version: 1,
    items: [{ id: 'iX', barcode: '4710000000011', name: '牙膏(桌機)' }, { id: 'i2', barcode: '4710000000028', name: '洗碗精' }],
    stores: [{ id: 'sX', name: '全聯' }, { id: 's2', name: '家樂福' }],
    prices: [{ id: 'p9', itemId: 'iX', storeId: 'sX', price: 55, date: '2026-11-05' },
             { id: 'p1', itemId: 'i1', storeId: 's1', price: 60, date: '2026-11-01' }]
  });
  const { data, stat } = C.mergeData(cur, inc);
  assert.strictEqual(data.items.length, 2);
  assert.strictEqual(data.stores.length, 2);
  const p9 = data.prices.find(p => p.id === 'p9');
  assert.strictEqual(p9.itemId, 'i1'); assert.strictEqual(p9.storeId, 's1');
  assert.strictEqual(data.prices.length, 2); // p1 重複略過
  assert.strictEqual(stat.added, 2); assert.strictEqual(stat.skipped, 2);
});
t('金額顯示', () => {
  assert.strictEqual(C.fmtMoney(1234), '$1,234'); assert.strictEqual(C.fmtMoney(37.5), '$37.5');
});
console.log('\n' + n + ' tests passed');
