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
  function lowestPrice(prices) {
    let low = null;
    prices.forEach(p => { if (!low || p.price < low.price) low = p; });
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

  function fmtMoney(n) {
    if (n === null || n === undefined || isNaN(n)) return '-';
    const v = Math.round(n * 100) / 100;
    return '$' + (Number.isInteger(v) ? v.toLocaleString('en-US') : v.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 2 }));
  }

  return {
    DATA_VERSION, DEFAULT_CATEGORIES, DEFAULT_STORES, BIGGO_TEMPLATE, ROUNDING_MODES, TABLES,
    uid, todayStr, stamp, applyRound, splitMode, unitPrice, cartTotals, latestByStore, lowestPrice,
    searchUrl, isHttpUrl, buildExport, migrate, mergeData, fmtMoney
  };
});
