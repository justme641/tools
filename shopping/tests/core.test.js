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

// ---------- 特價引擎 ----------
const near = (a, b, m) => assert.ok(Math.abs(a - b) < 1e-6, (m || '') + ' 實際 ' + a + ' 預期 ' + b);
const R = (id, type, params, itemIds, limit) => ({ id, type, params, itemIds, limit });

t('折數換算', () => {
  near(C.zheToFraction(5), 0.5); near(C.zheToFraction(85), 0.85); near(C.zheToFraction(7.5), 0.75); near(C.zheToFraction(0), 0);
});
t('買一送一：200 × 2 付 200', () => {
  const r = C.computePromos([{ itemId: 'a', qty: 2, price: 200 }], [R('r1', 'buyget', { n: 1, m: 1 }, ['a'])], 'line-round');
  near(r.total, 200); near(r.promoDiscount, 200); assert.deepStrictEqual(r.applied, ['r1']);
});
t('第二件5折：60 × 3 = 150', () => {
  const r = C.computePromos([{ itemId: 'a', qty: 3, price: 60 }], [R('r1', 'nth', { n: 2, zhe: 5 }, ['a'])], 'line-round');
  near(r.total, 150); near(r.savings, 30);
});
t('第二件85折', () => {
  near(C.computePromos([{ itemId: 'a', qty: 2, price: 100 }], [R('r1', 'nth', { n: 2, zhe: 85 }, ['a'])], 'line-round').total, 185);
});
t('任選3件$100（混搭、平均單價）：逐行與整單進位', () => {
  const lines = [{ itemId: 'a', qty: 1, price: 45 }, { itemId: 'b', qty: 1, price: 40 }, { itemId: 'c', qty: 1, price: 35 }, { itemId: 'd', qty: 1, price: 30 }];
  const rule = R('r1', 'bundle', { n: 3, total: 100 }, ['a', 'b', 'c', 'd']);
  const tr = C.computePromos(lines, [rule], 'total-round');
  near(tr.promoDiscount, 12.5); near(tr.total, 138);
  const lr = C.computePromos(lines, [rule], 'line-round');
  near(lr.total, 137);
  near(lr.rawSum, 150);
});
t('每單限購組數', () => {
  near(C.computePromos([{ itemId: 'a', qty: 6, price: 60 }], [R('r1', 'nth', { n: 2, zhe: 5 }, ['a'], 2)], 'line-round').total, 300);
});
t('件數不足不套用', () => {
  const r = C.computePromos([{ itemId: 'a', qty: 2, price: 50 }], [R('r1', 'bundle', { n: 3, total: 100 }, ['a'])], 'line-round');
  near(r.total, 100); assert.deepStrictEqual(r.applied, []);
});
t('單件折扣：折 $、打折、取最優不疊加', () => {
  const line = [{ itemId: 'a', qty: 2, price: 100 }];
  near(C.computePromos(line, [R('r1', 'unitoff', { mode: 'amount', value: 10 }, ['a'])], 'line-round').total, 180);
  near(C.computePromos(line, [R('r1', 'unitoff', { mode: 'zhe', value: 8 }, ['a'])], 'line-round').total, 160);
  const both = C.computePromos(line, [R('r1', 'unitoff', { mode: 'amount', value: 10 }, ['a']), R('r2', 'unitoff', { mode: 'zhe', value: 85 }, ['a'])], 'line-round');
  near(both.total, 170); assert.deepStrictEqual(both.applied, ['r2']);
});
t('單件折扣後再套買一送一', () => {
  const r = C.computePromos([{ itemId: 'a', qty: 2, price: 100 }],
    [R('r1', 'unitoff', { mode: 'amount', value: 20 }, ['a']), R('r2', 'buyget', { n: 1, m: 1 }, ['a'])], 'line-round');
  near(r.total, 80);
});
t('滿額折抵：單次、每滿累計、取最多', () => {
  const lines = [{ itemId: 'a', qty: 1, price: 1200 }];
  near(C.computePromos(lines, [R('t1', 'threshold', { threshold: 1000, amount: 100 }, [])], 'line-round').total, 1100);
  near(C.computePromos(lines, [R('t2', 'threshold', { threshold: 500, amount: 50, repeat: true }, [])], 'line-round').total, 1100);
  const best = C.computePromos(lines, [R('t1', 'threshold', { threshold: 1000, amount: 100 }, []), R('t3', 'threshold', { threshold: 1000, amount: 150 }, [])], 'line-round');
  near(best.total, 1050); assert.strictEqual(best.threshold.ruleId, 't3');
  near(C.computePromos([{ itemId: 'a', qty: 1, price: 900 }], [R('t1', 'threshold', { threshold: 1000, amount: 100 }, [])], 'line-round').total, 900);
});
t('規則競爭：同商品符合兩條，取最省的', () => {
  const r = C.computePromos([{ itemId: 'a', qty: 2, price: 100 }],
    [R('half', 'nth', { n: 2, zhe: 5 }, ['a']), R('bogo', 'buyget', { n: 1, m: 1 }, ['a'])], 'line-round');
  near(r.total, 100); assert.deepStrictEqual(r.applied, ['bogo']);
});
t('規則可分攤不同件數：買一送一與第二件5折各管一部分', () => {
  // a ×3：買一送一取 2 件（省 100），剩 1 件不夠第二件5折；總額 100 + 100 = 200
  const r = C.computePromos([{ itemId: 'a', qty: 3, price: 100 }],
    [R('bogo', 'buyget', { n: 1, m: 1 }, ['a'], 1), R('half', 'nth', { n: 2, zhe: 5 }, ['a'])], 'line-round');
  near(r.total, 200);
});
t('缺價格的行不參與也不當機', () => {
  const r = C.computePromos([{ itemId: 'a', qty: 2, price: null }, { itemId: 'b', qty: 1, price: 50 }], [R('r1', 'buyget', { n: 1, m: 1 }, ['a', 'b'])], 'line-round');
  near(r.total, 50);
});
t('優惠價格紀錄：平均價與最低價', () => {
  near(C.dealAverage(50, { kind: 'bundle', n: 2, total: 90 }), 45);
  near(C.dealAverage(50, { kind: 'buyget', n: 1, m: 1 }), 25);
  near(C.dealAverage(50, { kind: 'nth', n: 2, zhe: 5 }), 37.5);
  near(C.dealAverage(50, null), 50);
  const ps = [{ id: 1, price: 50, deal: { kind: 'bundle', n: 2, total: 90 } }, { id: 2, price: 48 }];
  assert.strictEqual(C.lowestPrice(ps).id, 1);
  near(C.effectivePrice(ps[0]), 45);
});
t('檔期狀態與規則描述', () => {
  const c = { start: '2026-11-10', end: '2026-11-16' };
  assert.strictEqual(C.campaignStatus(c, '2026-11-09'), 'upcoming');
  assert.strictEqual(C.campaignStatus(c, '2026-11-16'), 'active');
  assert.strictEqual(C.campaignStatus(c, '2026-11-17'), 'expired');
  assert.strictEqual(C.campaignStatus({ start: '', end: '' }, '2026-11-11'), 'active');
  assert.strictEqual(C.describePromo('buyget', { n: 1, m: 1 }), '買1送1');
  assert.strictEqual(C.describePromo('nth', { n: 2, zhe: 5 }), '第2件5折');
  assert.strictEqual(C.describePromo('bundle', { n: 3, total: 100 }), '3件 $100');
});

console.log('\n' + n + ' tests passed');
