/* core.js — 純函式核心（無畫面、無資料庫），可在 Node 直接測試
 * 版本 0.1.0
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Core = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DATA_VERSION = 1;

  const DEFAULT_CATEGORIES = ['食品', '飲料', '生鮮', '清潔用品', '個人護理', '日用雜貨', '保健', '其他'];

  // 搜尋網址範本以 {q} 代入商品名稱；以下僅為預設值，務必在手機實測，可於設定中修改
  const DEFAULT_STORES = [
    { name: '全聯', kind: 'physical', template: 'https://www.google.com/search?q={q}+site:shop.pxmart.com.tw', rounding: 'line-round' },
    { name: '家樂福', kind: 'physical', template: 'https://online.carrefour.com.tw/zh/search/?q={q}', rounding: 'line-round' },
    { name: '康是美', kind: 'physical', template: 'https://www.google.com/search?q={q}+site:cosmed.com.tw', rounding: 'line-round' },
    { name: '寶雅', kind: 'physical', template: 'https://www.google.com/search?q={q}+site:poyabuy.com.tw', rounding: 'line-round' },
    { name: 'PChome 24h', kind: 'online', template: 'https://24h.pchome.com.tw/search/?q={q}', rounding: 'line-round' },
    { name: 'momo', kind: 'online', template: 'https://www.momoshop.com.tw/search/searchShop.jsp?keyword={q}', rounding: 'line-round' }
  ];
  const BIGGO_TEMPLATE = 'https://biggo.com.tw/s/{q}/';

  // 進位模式：line-* 逐行進位後加總；total-* 整單加總後進位
  const ROUNDING_MODES = {
    'line-round': '逐行四捨五入',
    'line-floor': '逐行無條件捨去',
    'line-ceil': '逐行無條件進位',
    'total-round': '整單四捨五入',
    'total-floor': '整單無條件捨去',
    'total-ceil': '整單無條件進位'
  };

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function pad(n) { return String(n).padStart(2, '0'); }
  function todayStr(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function stamp(d) {
    d = d || new Date();
    return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '_' + pad(d.getHours()) + pad(d.getMinutes());
  }

  // 避免 1.005 這類浮點誤差：先放大到分再處理
  function applyRound(x, how) {
    const v = Math.round(x * 1e6) / 1e6;
    if (how === 'floor') return Math.floor(v + 1e-9);
    if (how === 'ceil') return Math.ceil(v - 1e-9);
    return Math.floor(v + 0.5 + 1e-9);
  }
  function splitMode(mode) {
    const m = ROUNDING_MODES[mode] ? mode : 'line-round';
    const [scope, how] = m.split('-');
    return { scope, how };
  }

  // 單價：價格 ÷ (容量 × 每組入數)；ml、g 換算成每 100；l、kg 先換成 ml、g；其餘單位算每 1
  function unitPrice(price, item) {
    price = Number(price);
    const size = Number(item && item.size);
    const pack = Number(item && item.packQty) || 1;
    const unit = (item && item.unit) || '';
    if (!(price >= 0) || !(size > 0)) return null;
    let total = size * pack;
    let base = unit, label;
    if (unit === 'l' || unit === 'L') { total *= 1000; base = 'ml'; }
    else if (unit === 'kg') { total *= 1000; base = 'g'; }
    if (base === 'ml' || base === 'g') {
      return { value: price / total * 100, label: '每 100' + base };
    }
    return { value: price / total, label: '每' + (unit || '單位') };
  }

  // 購物車：lines = [{price, qty}]
  function cartTotals(lines, mode) {
    const { scope, how } = splitMode(mode);
    let rawSum = 0, qtyCount = 0;
    const out = lines.map(l => {
      const qty = Number(l.qty) || 0, price = Number(l.price) || 0;
      const raw = price * qty;
      rawSum += raw; qtyCount += qty;
      return { raw, sub: scope === 'line' ? applyRound(raw, how) : raw };
    });
    const total = scope === 'line'
      ? out.reduce((s, l) => s + l.sub, 0)
      : applyRound(rawSum, how);
    return { lines: out, total, qtyCount };
  }

  // 每家賣場的最新價（以日期、再以建立順序決定）
  function latestByStore(prices) {
    const map = {};
    prices.forEach(p => {
      const cur = map[p.storeId];
      if (!cur || p.date > cur.date || (p.date === cur.date && (p.createdAt || 0) >= (cur.createdAt || 0))) map[p.storeId] = p;
    });
    return map;
  }
  // 歷史最低價以「每件實際平均價」比較（含多件優惠）
  function lowestPrice(prices) {
    let low = null;
    prices.forEach(p => { if (!low || effectivePrice(p) < effectivePrice(low)) low = p; });
    return low;
  }

  function searchUrl(template, keyword) {
    if (!template) return '';
    return template.split('{q}').join(encodeURIComponent(keyword || ''));
  }
  function isHttpUrl(s) {
    try { const u = new URL(s); return u.protocol === 'http:' || u.protocol === 'https:'; } catch (e) { return false; }
  }

  // ---------- 匯出入 ----------
  const TABLES = ['items', 'stores', 'storeLinks', 'prices', 'refPrices', 'carts', 'records',
    'promoCampaigns', 'promoRules', 'promoItems'];

  function buildExport(db, opts) {
    opts = opts || {};
    const data = { app: 'shopping-db', version: DATA_VERSION, exportedAt: new Date().toISOString(), includePhotos: !!opts.photos };
    TABLES.forEach(t => { data[t] = (db[t] || []).map(x => ({ ...x })); });
    data.settings = { ...(db.settings || {}) };
    if (!opts.photos) data.items.forEach(i => { delete i.photo; });
    return data;
  }

  function migrate(data) {
    if (!data || data.app !== 'shopping-db') throw new Error('不是本系統匯出的備份檔');
    if (typeof data.version !== 'number') throw new Error('備份檔缺少版本資訊');
    if (data.version > DATA_VERSION) throw new Error('備份檔版本較新，請先更新程式');
    const out = { ...data };
    TABLES.forEach(t => { if (!Array.isArray(out[t])) out[t] = []; });
    out.settings = out.settings || {};
    // 之後版本升級在此依 data.version 逐級轉換
    out.version = DATA_VERSION;
    return out;
  }

  // 合併：以 id 比對；商品另以條碼比對（同條碼視為同一商品，沿用現有 id）
  function mergeData(cur, incoming) {
    const result = {};
    const idMap = {}; // 傳入商品 id → 保留的商品 id
    TABLES.forEach(t => { result[t] = (cur[t] || []).map(x => ({ ...x })); });
    result.settings = { ...(cur.settings || {}) };
    const stat = { added: 0, skipped: 0 };

    const byBarcode = {};
    result.items.forEach(i => { if (i.barcode) byBarcode[i.barcode] = i; });
    incoming.items.forEach(i => {
      const sameId = result.items.find(x => x.id === i.id);
      if (sameId) { idMap[i.id] = sameId.id; stat.skipped++; return; }
      if (i.barcode && byBarcode[i.barcode]) { idMap[i.id] = byBarcode[i.barcode].id; stat.skipped++; return; }
      result.items.push({ ...i }); idMap[i.id] = i.id; stat.added++;
      if (i.barcode) byBarcode[i.barcode] = i;
    });
    const remap = id => (idMap[id] !== undefined ? idMap[id] : id);

    // 賣場以 id 或名稱比對
    const storeMap = {};
    incoming.stores.forEach(s => {
      const hit = result.stores.find(x => x.id === s.id || x.name === s.name);
      if (hit) storeMap[s.id] = hit.id; else { result.stores.push({ ...s }); storeMap[s.id] = s.id; }
    });
    const rs = id => (storeMap[id] !== undefined ? storeMap[id] : id);

    function addRows(table, fix) {
      const have = new Set(result[table].map(x => x.id));
      (incoming[table] || []).forEach(r => {
        if (have.has(r.id)) { stat.skipped++; return; }
        result[table].push(fix ? fix({ ...r }) : { ...r }); stat.added++;
      });
    }
    addRows('storeLinks', r => { r.itemId = remap(r.itemId); r.storeId = rs(r.storeId); return r; });
    addRows('prices', r => { r.itemId = remap(r.itemId); r.storeId = rs(r.storeId); return r; });
    addRows('refPrices', r => { r.itemId = remap(r.itemId); return r; });
    addRows('records', r => {
      r.storeId = rs(r.storeId);
      (r.lines || []).forEach(l => { l.itemId = remap(l.itemId); });
      return r;
    });
    addRows('promoCampaigns', r => { r.storeId = rs(r.storeId); return r; });
    addRows('promoRules');
    addRows('promoItems', r => { r.itemId = remap(r.itemId); return r; });
    // 進行中的購物車不合併，保留現有
    return { data: result, stat };
  }

  // ---------- 特價與優惠 ----------
  const PROMO_TYPES = {
    buyget: '買 N 送 M',
    nth: '第 N 件 X 折',
    bundle: 'N 件 $X（組合價）',
    unitoff: '單件折扣',
    threshold: '滿額折抵（整單）'
  };
  const GROUP_TYPES = ['buyget', 'nth', 'bundle'];

  // 折數：5 → 5折（50%）、8 → 8折、85 → 85折（85%）；小於 10 視為「幾折」，10 以上視為百分比
  function zheToFraction(z) {
    z = Number(z);
    if (!(z >= 0)) return 1;
    return z < 10 ? z / 10 : z / 100;
  }

  // 一組的件數與組價；a = 每件平均單價
  function groupInfo(type, p, a) {
    p = p || {};
    const n = Math.floor(Number(p.n)), m = Math.floor(Number(p.m));
    if (type === 'buyget') {
      if (!(n >= 1) || !(m >= 1)) return null;
      return { k: n + m, price: n * a };
    }
    if (type === 'nth') {
      if (!(n >= 2) || !(Number(p.zhe) >= 0)) return null;
      return { k: n, price: (n - 1) * a + a * zheToFraction(p.zhe) };
    }
    if (type === 'bundle') {
      const t = Number(p.total);
      if (!(n >= 2) || !(t >= 0)) return null;
      return { k: n, price: t };
    }
    return null;
  }

  // 價格紀錄上的優惠 → 每件平均價
  function dealAverage(price, deal) {
    price = Number(price);
    if (!deal) return price;
    const g = groupInfo(deal.kind, deal, price);
    return g ? g.price / g.k : price;
  }
  function effectivePrice(p) {
    return p && p.deal ? dealAverage(p.price, p.deal) : Number(p && p.price);
  }

  function unitOffPrice(price, p) {
    p = p || {};
    const v = Number(p.value);
    if (!(v > 0)) return price;
    const np = p.mode === 'zhe' ? price * zheToFraction(v) : price - v;
    return Math.max(0, Math.min(price, np));
  }

  function describePromo(type, p) {
    p = p || {};
    if (type === 'buyget') return '買' + p.n + '送' + p.m;
    if (type === 'nth') return '第' + p.n + '件' + Number(p.zhe) + '折';
    if (type === 'bundle') return p.n + '件 $' + p.total;
    if (type === 'unitoff') return p.mode === 'zhe' ? '每件' + Number(p.value) + '折' : '每件折 $' + p.value;
    if (type === 'threshold') return '滿 $' + p.threshold + ' 折 $' + p.amount + (p.repeat ? '（每滿累計）' : '');
    return String(type);
  }

  function campaignStatus(c, date) {
    if (c.start && date < c.start) return 'upcoming';
    if (c.end && date > c.end) return 'expired';
    return 'active';
  }

  function roundNets(nets, mode) {
    const { scope, how } = splitMode(mode);
    if (scope === 'line') {
      const subs = nets.map(x => applyRound(x, how));
      return { subs, sum: subs.reduce((s, x) => s + x, 0) };
    }
    return { subs: nets.slice(), sum: applyRound(nets.reduce((s, x) => s + x, 0), how) };
  }

  function permutations(arr) {
    if (arr.length <= 1) return [arr.slice()];
    const out = [];
    arr.forEach((x, i) => {
      permutations(arr.slice(0, i).concat(arr.slice(i + 1))).forEach(p => out.push([x].concat(p)));
    });
    return out;
  }

  // 依指定順序套用「組合型」規則：每條規則取走它要的件數，其餘件數留給後面的規則
  function evalGroupOrder(order, ctx) {
    const { lines, unitPrice, qty } = ctx;
    const remaining = qty.slice();
    const disc = lines.map(() => 0);
    const notes = [];
    let total = 0;
    order.forEach(r => {
      const idxs = [];
      lines.forEach((l, i) => {
        if (remaining[i] > 0 && unitPrice[i] !== null && r.itemIds.includes(l.itemId)) idxs.push(i);
      });
      let units = 0, sumPrice = 0;
      idxs.forEach(i => { units += remaining[i]; sumPrice += remaining[i] * unitPrice[i]; });
      if (!units) return;
      const a = sumPrice / units; // 混搭商品以平均單價計
      const gi = groupInfo(r.type, r.params, a);
      if (!gi || units < gi.k) return;
      let g = Math.floor(units / gi.k);
      if (Number(r.limit) > 0) g = Math.min(g, Math.floor(Number(r.limit)));
      if (g < 1) return;
      const use = g * gi.k;
      const d = use * a - g * gi.price;
      if (d <= 1e-9) return;
      // 輪流從各行取走 use 件
      const take = idxs.map(() => 0);
      let left = use, p = 0;
      while (left > 0) {
        const j = p % idxs.length;
        if (take[j] < remaining[idxs[j]]) { take[j]++; left--; }
        p++;
      }
      const weights = idxs.map((i, j) => take[j] * unitPrice[i]);
      const wsum = weights.reduce((s, x) => s + x, 0) || 1;
      const share = [];
      idxs.forEach((i, j) => {
        remaining[i] -= take[j];
        const amt = d * weights[j] / wsum;
        disc[i] += amt;
        if (amt > 1e-9) share.push([i, amt]);
      });
      notes.push({ ruleId: r.id, units: use, groups: g, discount: d, lines: share });
      total += d;
    });
    return { total, disc, notes };
  }

  /* 購物車特價計算
   * lines: [{itemId, qty, price}]（price 為單件標價，null 表示尚未輸入）
   * rules: [{id, type, params, limit, itemIds}]（已篩成該賣場、該日有效且未被關閉的規則）
   * 順序：單件折扣 → 組合型（買送、第N件、N件$X；多條規則競爭時窮舉順序取最省）→ 進位 → 滿額折抵
   */
  function computePromos(lines, rules, mode) {
    rules = (rules || []).map(r => ({ ...r, itemIds: r.itemIds || [], params: r.params || {} }));
    const qty = lines.map(l => Math.max(0, Math.floor(Number(l.qty) || 0)));
    const hasPrice = lines.map(l => l.price !== null && l.price !== undefined && l.price !== '' && Number(l.price) >= 0);
    const price = lines.map((l, i) => (hasPrice[i] ? Number(l.price) : 0));
    const raw = price.map((p, i) => p * qty[i]);
    const unitPrice = price.map((p, i) => (hasPrice[i] ? p : null));
    const promos = lines.map(() => []);
    const applied = new Set();
    let promoDiscount = 0;

    // 1. 單件折扣：同一商品只取折得最多的一條，不疊加
    const off = lines.map(() => 0);
    const offRule = lines.map(() => null);
    rules.filter(r => r.type === 'unitoff').forEach(r => {
      lines.forEach((l, i) => {
        if (!hasPrice[i] || !qty[i] || !r.itemIds.includes(l.itemId)) return;
        const per = price[i] - unitOffPrice(price[i], r.params);
        if (per > off[i] + 1e-9) { off[i] = per; offRule[i] = r.id; }
      });
    });
    lines.forEach((l, i) => {
      if (!offRule[i]) return;
      unitPrice[i] = price[i] - off[i];
      const amt = off[i] * qty[i];
      promos[i].push({ ruleId: offRule[i], amount: amt });
      applied.add(offRule[i]);
      promoDiscount += amt;
    });

    // 2. 組合型規則
    const groupRules = rules.filter(r => GROUP_TYPES.includes(r.type));
    const ctx = { lines, unitPrice, qty };
    let best = { total: 0, disc: lines.map(() => 0), notes: [] };
    if (groupRules.length) {
      const orders = groupRules.length <= 6
        ? permutations(groupRules)
        : [groupRules.slice().sort((a, b) => evalGroupOrder([b], ctx).total - evalGroupOrder([a], ctx).total)];
      let first = true;
      orders.forEach(o => {
        const r = evalGroupOrder(o, ctx);
        if (first || r.total > best.total + 1e-9) { best = r; first = false; }
      });
    }
    best.notes.forEach(n => {
      applied.add(n.ruleId);
      n.lines.forEach(([i, amt]) => promos[i].push({ ruleId: n.ruleId, amount: amt }));
      promoDiscount += n.discount;
    });

    // 3. 進位
    const nets = raw.map((x, i) => x - off[i] * qty[i] - best.disc[i]);
    const rd = roundNets(nets, mode);
    const rawSum = raw.reduce((s, x) => s + x, 0);

    // 4. 滿額折抵：取折抵最多的一條
    let thr = null;
    rules.filter(r => r.type === 'threshold').forEach(r => {
      const T = Number(r.params.threshold), A = Number(r.params.amount);
      if (!(T > 0) || !(A > 0) || rd.sum < T) return;
      const times = r.params.repeat ? Math.floor(rd.sum / T) : 1;
      const d = Math.min(rd.sum, times * A);
      if (!thr || d > thr.amount) thr = { ruleId: r.id, amount: d };
    });
    if (thr) applied.add(thr.ruleId);
    const total = rd.sum - (thr ? thr.amount : 0);

    return {
      lines: lines.map((l, i) => ({ raw: raw[i], net: nets[i], sub: rd.subs[i], promos: promos[i] })),
      rawSum, subtotal: rd.sum, promoDiscount, threshold: thr, total,
      savings: promoDiscount + (thr ? thr.amount : 0),
      qtyCount: qty.reduce((s, x) => s + x, 0),
      applied: Array.from(applied), notes: best.notes
    };
  }

  function fmtMoney(n) {
    if (n === null || n === undefined || isNaN(n)) return '-';
    const v = Math.round(n * 100) / 100;
    return '$' + (Number.isInteger(v) ? v.toLocaleString('en-US') : v.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 2 }));
  }

  return {
    DATA_VERSION, DEFAULT_CATEGORIES, DEFAULT_STORES, BIGGO_TEMPLATE, ROUNDING_MODES, TABLES,
    uid, todayStr, stamp, applyRound, splitMode, unitPrice, cartTotals, latestByStore, lowestPrice,
    searchUrl, isHttpUrl, buildExport, migrate, mergeData, fmtMoney,
    PROMO_TYPES, GROUP_TYPES, zheToFraction, groupInfo, dealAverage, effectivePrice, unitOffPrice,
    describePromo, campaignStatus, computePromos
  };
});
