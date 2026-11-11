/* app.js — 資料層與畫面
 * 版本 0.1.0（第一階段）
 */
(function () {
  'use strict';
  const VERSION = '0.1.0';
  const CHANGELOG = [
    ['0.1.0', '2026-11-11', '第一階段：掃碼、商品庫、價格紀錄、賣場連結、BigGo 參考、購物車、購物紀錄、JSON 匯出入']
  ];
  const UNITS = ['ml', 'l', 'g', 'kg', '片', '個', '入', '包', '抽', '瓶', '罐'];
  const PAYS = ['現金', '信用卡', '行動支付', '其他'];

  /* ---------- 小工具 ---------- */
  const $ = s => document.querySelector(s);
  const esc = s => String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const fmt = Core.fmtMoney;
  let toastTimer;
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
  }
  const safeImg = s => (typeof s === 'string' && s.startsWith('data:image/')) ? s : '';

  /* ---------- IndexedDB ---------- */
  const TABLES = Core.TABLES;
  let idb;
  function openDB() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('shopping-db', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        TABLES.concat(['settings']).forEach(t => {
          if (!d.objectStoreNames.contains(t)) d.createObjectStore(t, { keyPath: t === 'settings' ? 'key' : 'id' });
        });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  function tx(t, mode, fn) {
    return new Promise((res, rej) => {
      const x = idb.transaction(t, mode);
      const rq = fn(x.objectStore(t));
      x.oncomplete = () => res(rq && rq.result);
      x.onerror = () => rej(x.error);
      x.onabort = () => rej(x.error);
    });
  }
  const idbAll = t => tx(t, 'readonly', s => s.getAll());
  const idbPut = (t, o) => tx(t, 'readwrite', s => s.put(o));
  const idbDel = (t, id) => tx(t, 'readwrite', s => s.delete(id));
  const idbClear = t => tx(t, 'readwrite', s => s.clear());

  /* ---------- 記憶體資料（寫入時同步寫 IndexedDB） ---------- */
  const S = { settings: {} };
  TABLES.forEach(t => { S[t] = []; });

  async function loadAll() {
    for (const t of TABLES) S[t] = await idbAll(t);
    const rows = await idbAll('settings');
    S.settings = {};
    rows.forEach(r => { S.settings[r.key] = r.value; });
  }
  async function save(table, obj) {
    const i = S[table].findIndex(x => x.id === obj.id);
    if (i >= 0) S[table][i] = obj; else S[table].push(obj);
    await idbPut(table, obj);
    return obj;
  }
  async function remove(table, id) {
    S[table] = S[table].filter(x => x.id !== id);
    await idbDel(table, id);
  }
  async function setSetting(key, value) {
    S.settings[key] = value;
    await idbPut('settings', { key, value });
  }
  async function seed() {
    if (!S.stores.length) {
      for (const d of Core.DEFAULT_STORES) await save('stores', { id: Core.uid(), ...d });
    }
    if (!S.settings.categories) await setSetting('categories', Core.DEFAULT_CATEGORIES.slice());
    if (!S.settings.backupDays) await setSetting('backupDays', 14);
    if (!S.settings.bigGoTemplate) await setSetting('bigGoTemplate', Core.BIGGO_TEMPLATE);
    if (!S.settings.cart) await setSetting('cart', { storeId: '', lines: [] });
    if (!S.settings.installedAt) await setSetting('installedAt', Date.now());
  }

  /* ---------- 查詢輔助 ---------- */
  const itemById = id => S.items.find(i => i.id === id);
  const storeById = id => S.stores.find(s => s.id === id);
  const storeName = id => (storeById(id) || { name: '（已刪除賣場）' }).name;
  const pricesOf = itemId => S.prices.filter(p => p.itemId === itemId);
  const byDateDesc = (a, b) => (b.date + (b.createdAt || 0)).localeCompare(a.date + (a.createdAt || 0));
  const readOnly = () => !!S.settings.readOnly;
  function specText(i) {
    if (!(Number(i.size) > 0)) return '';
    return i.size + (i.unit || '') + (Number(i.packQty) > 1 ? ' × ' + i.packQty : '');
  }
  function latestPrice(itemId, storeId) {
    const ps = pricesOf(itemId).filter(p => p.storeId === storeId).sort(byDateDesc);
    return ps[0] || null;
  }
  function cart() { return S.settings.cart || { storeId: '', lines: [] }; }
  function cartStore() { return storeById(cart().storeId); }
  function roundingMode() { const s = cartStore(); return s && s.rounding ? s.rounding : 'line-round'; }

  /* ---------- 路由 ---------- */
  function route() {
    const h = location.hash.replace(/^#/, '') || '/';
    const [path, query] = h.split('?');
    const parts = path.split('/').filter(Boolean);
    const params = new URLSearchParams(query || '');
    return { parts, params };
  }
  function render() {
    const { parts, params } = route();
    const v = parts[0] || 'home';
    let html = '', nav = v;
    try {
      if (v === 'home') html = viewHome(params);
      else if (v === 'item') html = viewItem(parts[1]);
      else if (v === 'edit') { html = viewEdit(parts[1], params); nav = 'home'; }
      else if (v === 'cart') html = viewCart();
      else if (v === 'records') html = viewRecords();
      else if (v === 'record') { html = viewRecord(parts[1]); nav = 'records'; }
      else if (v === 'settings') html = viewSettings();
      else html = viewHome(params);
    } catch (e) {
      html = '<div class="card">畫面發生錯誤：' + esc(e.message) + '</div>';
      console.error(e);
    }
    $('#view').innerHTML = html;
    document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('on', a.dataset.nav === nav));
    const n = cart().lines.reduce((s, l) => s + (Number(l.qty) || 0), 0);
    $('#cartBadge').textContent = n ? ' (' + n + ')' : '';
    window.scrollTo(0, 0);
  }
  function go(hash) { if (location.hash === hash) render(); else location.hash = hash; }

  /* ---------- 首頁 ---------- */
  function itemRow(i) {
    const ps = pricesOf(i.id).sort(byDateDesc);
    const last = ps[0];
    const photo = safeImg(i.photo);
    return '<a class="row" href="#/item/' + esc(i.id) + '">' +
      '<div class="thumb">' + (photo ? '<img src="' + photo + '" alt="">' : '📦') + '</div>' +
      '<div class="grow"><b>' + esc(i.name) + '</b><div class="sub">' +
      esc([i.brand, specText(i), i.category].filter(Boolean).join(' · ')) + '</div></div>' +
      '<div class="right">' + (last ? '<b>' + fmt(last.price) + '</b><div class="sub">' + esc(storeName(last.storeId)) + '</div>'
        : '<span class="sub">尚無價格</span>') + '</div></a>';
  }
  let homeQuery = '';
  function viewHome(params) {
    const q = homeQuery.trim().toLowerCase();
    let list = S.items.slice();
    if (q) {
      list = list.filter(i => [i.name, i.brand, i.barcode, i.category].some(x => String(x || '').toLowerCase().includes(q)));
    }
    list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const days = Number(S.settings.backupDays) || 14;
    const last = S.settings.lastExport;
    let banner = '';
    if (S.items.length && (!last || (Date.now() - last) / 86400000 >= days)) {
      banner = '<div class="banner warn">' + (last ? '已超過 ' + days + ' 天未備份' : '尚未備份過') +
        '，資料只存在這支手機的瀏覽器裡，建議到「設定」匯出備份。</div>';
    }
    return '<h1>商品查價</h1>' + banner +
      (readOnly() ? '' : '<div class="btns"><button class="primary" data-act="scan">📷 掃描條碼</button></div>') +
      '<form data-form="barcode" class="grid2" style="grid-template-columns:1fr auto">' +
      '<input name="code" inputmode="numeric" placeholder="手動輸入條碼" autocomplete="off"><button class="primary">查詢</button></form>' +
      '<label>搜尋商品（名稱、品牌、條碼、分類）</label>' +
      '<input id="homeSearch" type="search" value="' + esc(homeQuery) + '" placeholder="例如：洗髮精" autocomplete="off">' +
      '<h2>' + (q ? '搜尋結果（' + list.length + '）' : '最近的商品') + '</h2>' +
      (list.length ? list.slice(0, 100).map(itemRow).join('') :
        '<div class="card sub">' + (S.items.length ? '沒有符合的商品。' : '還沒有商品，掃描條碼或按下方新增。') + '</div>') +
      (readOnly() ? '' : '<div class="btns"><a class="btn" href="#/edit/new">＋ 手動新增商品</a></div>');
  }

  /* ---------- 商品頁 ---------- */
  function linkUrl(item, store) {
    const l = S.storeLinks.find(x => x.itemId === item.id && x.storeId === store.id);
    if (l && Core.isHttpUrl(l.url)) return { url: l.url, bound: true };
    const u = Core.searchUrl(store.template, item.name);
    return { url: Core.isHttpUrl(u) ? u : '', bound: false };
  }
  function viewItem(id) {
    const it = itemById(id);
    if (!it) return '<div class="card">找不到這個商品。<div class="btns"><a class="btn" href="#/">回首頁</a></div></div>';
    const ps = pricesOf(id).sort(byDateDesc);
    const latest = Core.latestByStore(ps);
    const low = Core.lowestPrice(ps);
    const photo = safeImg(it.photo);
    const ro = readOnly();
    let h = '<h1>' + esc(it.name) + '</h1>';
    if (photo) h += '<img class="big-photo" src="' + photo + '" alt="">';
    h += '<div class="card"><div class="sub">' +
      esc([it.brand, it.category, specText(it)].filter(Boolean).join(' · ')) + '</div>' +
      '<div class="sub">條碼：' + esc(it.barcode || '無') + '</div>' +
      (it.note ? '<div style="margin-top:6px">' + esc(it.note) + '</div>' : '') + '</div>';

    // 各賣場最新價
    h += '<h2>各賣場最新價</h2>';
    const storeIds = Object.keys(latest);
    if (!storeIds.length) h += '<div class="card sub">尚無價格紀錄。</div>';
    else {
      h += '<div class="card"><table class="tbl"><tr><th>賣場</th><th class="r">價格</th><th class="r">單價</th></tr>';
      storeIds.sort((a, b) => latest[a].price - latest[b].price).forEach(sid => {
        const p = latest[sid], u = Core.unitPrice(p.price, it);
        h += '<tr><td>' + esc(storeName(sid)) + (p.onSale ? '<span class="chip warn">特價</span>' : '') +
          '<div class="sub">' + esc(p.date) + '</div></td><td class="r"><b>' + fmt(p.price) + '</b></td>' +
          '<td class="r sub">' + (u ? fmt(u.value) + '<br>' + esc(u.label) : '-') + '</td></tr>';
      });
      h += '</table>' + (low ? '<div class="sub" style="margin-top:6px">歷史最低價：' + fmt(low.price) + '（' +
        esc(storeName(low.storeId)) + '，' + esc(low.date) + '）</div>' : '') + '</div>';
    }

    // 新增價格
    if (!ro) {
      const lastStore = S.settings.lastStore || (S.stores[0] && S.stores[0].id);
      h += '<h2>記錄價格</h2><form class="card" data-form="price" data-id="' + esc(id) + '">' +
        '<div class="grid2"><div><label>賣場</label><select name="storeId">' +
        S.stores.map(s => '<option value="' + esc(s.id) + '"' + (s.id === lastStore ? ' selected' : '') + '>' + esc(s.name) + '</option>').join('') +
        '</select></div><div><label>價格（元）</label><input name="price" type="number" inputmode="decimal" step="any" min="0" required></div></div>' +
        '<div class="grid2"><div><label>日期</label><input name="date" type="date" value="' + Core.todayStr() + '" required></div>' +
        '<div><label>備註</label><input name="note" placeholder="例如：第二件5折"></div></div>' +
        '<label class="check"><input type="checkbox" name="onSale"> 這是特價價格</label>' +
        '<div class="btns"><button class="primary">儲存價格</button></div></form>';
    }

    // 查價連結
    h += '<h2>到賣場查價</h2><div class="card"><div class="hint">開啟賣場商品頁（已綁定網址）或用商品名稱搜尋，看完價格再回來記錄。</div>';
    S.stores.forEach(s => {
      const l = linkUrl(it, s);
      h += '<div class="row" style="margin:6px 0"><div class="grow"><b>' + esc(s.name) + '</b><div class="sub">' +
        (l.bound ? '已綁定商品頁' : '名稱搜尋') + '</div></div>' +
        (l.url ? '<a class="btn small" href="' + esc(l.url) + '" target="_blank" rel="noopener noreferrer">開啟</a>' : '<span class="sub">無網址範本</span>') +
        (ro ? '' : '<button class="small" data-act="bind" data-id="' + esc(it.id) + '" data-store="' + esc(s.id) + '">' + (l.bound ? '改網址' : '綁定') + '</button>') +
        '</div>';
    });
    h += '</div>';

    // BigGo 參考
    const refs = S.refPrices.filter(r => r.itemId === id).sort((a, b) => b.date.localeCompare(a.date));
    const bigUrl = Core.searchUrl(S.settings.bigGoTemplate || Core.BIGGO_TEMPLATE, it.name);
    h += '<h2>BigGo 歷史價（參考）</h2><div class="card"><div class="hint">僅供比較，不計入你的價格紀錄與結帳。</div>' +
      '<div class="btns"><a class="btn" href="' + esc(bigUrl) + '" target="_blank" rel="noopener noreferrer">開啟 BigGo</a></div>';
    refs.forEach(r => {
      h += '<div class="row" style="margin:6px 0"><div class="grow">' + fmt(r.price) + '<span class="chip">參考</span><div class="sub">' +
        esc(r.date) + (r.note ? ' · ' + esc(r.note) : '') + '</div></div>' +
        (ro ? '' : '<button class="small danger" data-act="delRef" data-id="' + esc(r.id) + '">刪除</button>') + '</div>';
    });
    if (!ro) {
      h += '<form data-form="ref" data-id="' + esc(id) + '"><div class="grid2"><div><label>參考價（元）</label>' +
        '<input name="price" type="number" inputmode="decimal" step="any" min="0" required></div>' +
        '<div><label>日期</label><input name="date" type="date" value="' + Core.todayStr() + '" required></div></div>' +
        '<label>備註</label><input name="note" placeholder="例如：近一年低點">' +
        '<div class="btns"><button>記下參考價</button></div></form>';
    }
    h += '</div>';

    // 價格歷史
    if (ps.length) {
      h += '<h2>我的價格歷史</h2><div class="card"><table class="tbl"><tr><th>日期</th><th>賣場</th><th class="r">價格</th><th></th></tr>';
      ps.slice(0, 60).forEach(p => {
        h += '<tr><td>' + esc(p.date) + '</td><td>' + esc(storeName(p.storeId)) + (p.onSale ? '<span class="chip warn">特價</span>' : '') +
          (p.note ? '<div class="sub">' + esc(p.note) + '</div>' : '') + '</td><td class="r">' + fmt(p.price) + '</td><td class="r">' +
          (ro ? '' : '<button class="small danger" data-act="delPrice" data-id="' + esc(p.id) + '">刪</button>') + '</td></tr>';
      });
      h += '</table></div>';
    }

    // 操作
    h += '<div class="btns">' + (ro ? '' : '<button class="primary" data-act="addCart" data-id="' + esc(id) + '">🛒 加入購物車</button>' +
      '<a class="btn" href="#/edit/' + esc(id) + '">編輯商品</a><button class="danger" data-act="delItem" data-id="' + esc(id) + '">刪除商品</button>') + '</div>';
    return h;
  }

  /* ---------- 新增／編輯商品 ---------- */
  function viewEdit(id, params) {
    if (readOnly()) return '<div class="card">目前是唯讀模式，無法編輯。</div>';
    const isNew = id === 'new';
    const it = isNew ? { barcode: params.get('barcode') || '', unit: 'ml', packQty: 1 } : itemById(id);
    if (!it) return '<div class="card">找不到這個商品。</div>';
    const cats = S.settings.categories || Core.DEFAULT_CATEGORIES;
    const photo = safeImg(it.photo);
    return '<h1>' + (isNew ? '新增商品' : '編輯商品') + '</h1>' +
      '<form class="card" data-form="item" data-id="' + esc(isNew ? '' : it.id) + '">' +
      '<label>條碼（無條碼的商品可留空）</label><input name="barcode" inputmode="numeric" value="' + esc(it.barcode) + '" autocomplete="off">' +
      '<label>名稱 *</label><input name="name" required value="' + esc(it.name) + '">' +
      '<div class="grid2"><div><label>品牌</label><input name="brand" value="' + esc(it.brand) + '"></div>' +
      '<div><label>分類</label><select name="category"><option value="">（未分類）</option>' +
      cats.map(c => '<option' + (c === it.category ? ' selected' : '') + '>' + esc(c) + '</option>').join('') + '</select></div></div>' +
      '<div class="grid2"><div><label>容量／數量</label><input name="size" type="number" inputmode="decimal" step="any" min="0" value="' + esc(it.size) + '"></div>' +
      '<div><label>單位</label><select name="unit">' +
      UNITS.map(u => '<option' + (u === it.unit ? ' selected' : '') + '>' + esc(u) + '</option>').join('') + '</select></div></div>' +
      '<label>每組入數（例如 6 入組填 6）</label><input name="packQty" type="number" inputmode="numeric" min="1" step="1" value="' + esc(it.packQty || 1) + '">' +
      '<label>照片</label>' + (photo ? '<img class="big-photo" id="photoPrev" src="' + photo + '" alt="">' : '<img class="big-photo" id="photoPrev" style="display:none" alt="">') +
      '<input id="photoFile" type="file" accept="image/*">' +
      (photo ? '<label class="check"><input type="checkbox" name="rmPhoto"> 移除照片</label>' : '') +
      '<label>備註</label><textarea name="note">' + esc(it.note) + '</textarea>' +
      '<div class="btns"><button class="primary">儲存</button><a class="btn" href="' + (isNew ? '#/' : '#/item/' + esc(it.id)) + '">取消</a></div></form>';
  }
  let pendingPhoto = null;
  function resizeImage(file) {
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onerror = () => rej(fr.error);
      fr.onload = () => {
        const img = new Image();
        img.onerror = () => rej(new Error('無法讀取這張圖片'));
        img.onload = () => {
          const max = 640, r = Math.min(1, max / Math.max(img.width, img.height));
          const c = document.createElement('canvas');
          c.width = Math.round(img.width * r); c.height = Math.round(img.height * r);
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          res(c.toDataURL('image/jpeg', 0.7));
        };
        img.src = fr.result;
      };
      fr.readAsDataURL(file);
    });
  }

  /* ---------- 購物車 ---------- */
  function viewCart() {
    if (readOnly()) return '<div class="card">目前是唯讀模式，購物車停用。</div>';
    const c = cart();
    const mode = roundingMode();
    const lines = c.lines.map(l => ({ price: l.price, qty: l.qty }));
    const tot = Core.cartTotals(lines, mode);
    const missing = c.lines.filter(l => !(Number(l.price) >= 0) || l.price === null || l.price === '').length;
    let h = '<h1>購物車</h1><label>結帳賣場</label><select id="cartStore"><option value="">請選擇賣場</option>' +
      S.stores.map(s => '<option value="' + esc(s.id) + '"' + (s.id === c.storeId ? ' selected' : '') + '>' + esc(s.name) + '</option>').join('') + '</select>';
    if (!c.lines.length) return h + '<div class="card sub" style="margin-top:12px">購物車是空的。到商品頁按「加入購物車」。</div>';
    h += '<div style="margin-top:8px">';
    c.lines.forEach((l, idx) => {
      const it = itemById(l.itemId);
      h += '<div class="card"><div class="row" style="border:0;padding:0;margin:0"><div class="grow"><b>' + esc(it ? it.name : '（已刪除商品）') + '</b>' +
        '<div class="sub">' + esc(it ? specText(it) : '') + '</div></div>' +
        '<button class="small danger" data-act="cartDel" data-i="' + idx + '">移除</button></div>' +
        '<div class="grid2" style="align-items:end"><div><label>單價（元）</label><input type="number" inputmode="decimal" step="any" min="0" data-cartprice="' + idx + '" value="' +
        (l.price === null || l.price === undefined ? '' : esc(l.price)) + '" placeholder="輸入價格"></div>' +
        '<div class="qty"><button data-act="cartQty" data-i="' + idx + '" data-d="-1">−</button><span>' + esc(l.qty) +
        '</span><button data-act="cartQty" data-i="' + idx + '" data-d="1">＋</button></div></div>' +
        '<div class="right sub" style="margin-top:6px">小計 ' + fmt(tot.lines[idx].sub) + '</div></div>';
    });
    h += '</div><div class="card"><div class="sub">共 ' + c.lines.length + ' 項、' + tot.qtyCount + ' 件 · ' + esc(Core.ROUNDING_MODES[mode]) + '</div>' +
      '<div class="total">' + fmt(tot.total) + '</div>' +
      (missing ? '<div class="banner warn">有 ' + missing + ' 項尚未輸入價格</div>' : '') +
      '<label>付款方式</label><select id="payMethod">' + PAYS.map(p => '<option>' + esc(p) + '</option>').join('') + '</select>' +
      '<label class="check"><input type="checkbox" id="recPrice" checked> 把這次輸入的新價格記入價格紀錄</label>' +
      '<div class="btns"><button class="primary" data-act="checkout">結帳完成</button><button class="danger" data-act="cartClear">清空</button></div></div>';
    return h;
  }
  async function addToCart(itemId) {
    const c = cart();
    const found = c.lines.find(l => l.itemId === itemId);
    if (found) found.qty = Number(found.qty) + 1;
    else {
      const p = c.storeId ? latestPrice(itemId, c.storeId) : null;
      c.lines.push({ itemId, qty: 1, price: p ? p.price : null, manual: false });
    }
    await setSetting('cart', c);
    toast('已加入購物車');
    render();
  }
  async function checkout() {
    const c = cart(), store = cartStore();
    if (!store) { toast('請先選擇結帳賣場'); return; }
    if (c.lines.some(l => l.price === null || l.price === '' || !(Number(l.price) >= 0))) { toast('還有商品沒有輸入價格'); return; }
    const mode = roundingMode();
    const tot = Core.cartTotals(c.lines.map(l => ({ price: l.price, qty: l.qty })), mode);
    const now = new Date(), date = Core.todayStr(now);
    const rec = {
      id: Core.uid(), date, time: now.toISOString(), storeId: store.id, storeName: store.name,
      payMethod: $('#payMethod').value, rounding: mode, total: tot.total, qtyCount: tot.qtyCount,
      lines: c.lines.map((l, i) => {
        const it = itemById(l.itemId) || {};
        return { itemId: l.itemId, name: it.name || '', qty: Number(l.qty), price: Number(l.price), sub: tot.lines[i].sub };
      })
    };
    await save('records', rec);
    if ($('#recPrice').checked) {
      for (const l of c.lines) {
        const last = latestPrice(l.itemId, store.id);
        if (!last || Number(last.price) !== Number(l.price)) {
          await save('prices', { id: Core.uid(), itemId: l.itemId, storeId: store.id, price: Number(l.price), date, onSale: false, note: '購物車結帳', createdAt: Date.now() });
        }
      }
    }
    await setSetting('cart', { storeId: store.id, lines: [] });
    toast('已儲存購物紀錄');
    go('#/record/' + rec.id);
  }

  /* ---------- 購物紀錄 ---------- */
  function viewRecords() {
    const list = S.records.slice().sort((a, b) => (b.time || '').localeCompare(a.time || ''));
    let h = '<h1>購物紀錄</h1>';
    if (!list.length) return h + '<div class="card sub">還沒有購物紀錄。</div>';
    list.forEach(r => {
      h += '<a class="row" href="#/record/' + esc(r.id) + '"><div class="grow"><b>' + esc(r.date) + ' · ' + esc(r.storeName || storeName(r.storeId)) +
        '</b><div class="sub">' + (r.lines || []).length + ' 項 · ' + esc(r.payMethod || '') + '</div></div><div class="right"><b>' + fmt(r.total) + '</b></div></a>';
    });
    return h;
  }
  function viewRecord(id) {
    const r = S.records.find(x => x.id === id);
    if (!r) return '<div class="card">找不到這筆紀錄。<div class="btns"><a class="btn" href="#/records">回紀錄</a></div></div>';
    let h = '<h1>' + esc(r.date) + ' · ' + esc(r.storeName || storeName(r.storeId)) + '</h1><div class="card">' +
      '<table class="tbl"><tr><th>商品</th><th class="r">數量</th><th class="r">單價</th><th class="r">小計</th></tr>';
    (r.lines || []).forEach(l => {
      const exists = itemById(l.itemId);
      h += '<tr><td>' + (exists ? '<a href="#/item/' + esc(l.itemId) + '">' + esc(l.name) + '</a>' : esc(l.name)) + '</td><td class="r">' + esc(l.qty) +
        '</td><td class="r">' + fmt(l.price) + '</td><td class="r">' + fmt(l.sub) + '</td></tr>';
    });
    h += '</table><div class="total" style="margin-top:8px">' + fmt(r.total) + '</div><div class="sub">' + esc(r.payMethod || '') + ' · ' +
      esc(Core.ROUNDING_MODES[r.rounding] || '') + ' · 紀錄編號 ' + esc(r.id) + '</div></div>' +
      '<div class="btns"><button data-act="copyLink" data-id="' + esc(r.id) + '">複製這筆明細的連結</button>' +
      (readOnly() ? '' : '<button class="danger" data-act="delRecord" data-id="' + esc(r.id) + '">刪除紀錄</button>') + '</div>' +
      '<div class="hint">連結可貼到個人記事本，之後點開就能回到這筆明細。</div>';
    return h;
  }

  /* ---------- 設定 ---------- */
  function viewSettings() {
    const ro = readOnly();
    let h = '<h1>設定</h1>';
    h += '<h2>外觀與模式</h2><div class="card"><label>主題</label><select id="theme">' +
      [['auto', '跟隨系統'], ['light', '淺色'], ['dark', '深色']].map(o => '<option value="' + o[0] + '"' + ((S.settings.theme || 'auto') === o[0] ? ' selected' : '') + '>' + o[1] + '</option>').join('') + '</select>' +
      '<label class="check"><input type="checkbox" id="readOnly"' + (ro ? ' checked' : '') + '> 唯讀模式（桌機查帳用，停用新增、修改、購物車）</label></div>';

    h += '<h2>備份與還原</h2><div class="card">' +
      '<div class="sub">上次匯出：' + (S.settings.lastExport ? esc(new Date(S.settings.lastExport).toLocaleString('zh-TW')) : '尚未匯出') + '</div>' +
      '<div class="btns"><button class="primary" data-act="export" data-photos="0">匯出（不含照片）</button>' +
      '<button data-act="export" data-photos="1">匯出（含照片）</button></div>' +
      '<div class="hint">備份檔可用 LINE 或 Email 傳給自己；經這些服務傳送時，檔案會經過該服務。</div>' +
      '<label>匯入備份檔</label><input id="importFile" type="file" accept=".json,application/json">' +
      '<label>匯入方式</label><select id="importMode"><option value="merge">合併（以條碼與編號去重）</option><option value="replace">取代（清除目前資料）</option></select>' +
      '<div class="hint">匯入前會先自動下載一份目前資料的備份。</div>' +
      '<label>備份提醒（天數）</label><input id="backupDays" type="number" min="1" step="1" value="' + esc(S.settings.backupDays || 14) + '"></div>';

    h += '<h2>賣場</h2>';
    S.stores.forEach(s => {
      h += '<form class="card" data-form="store" data-id="' + esc(s.id) + '"><label>名稱</label><input name="name" required value="' + esc(s.name) + '">' +
        '<div class="grid2"><div><label>類型</label><select name="kind"><option value="physical"' + (s.kind === 'physical' ? ' selected' : '') + '>實體</option><option value="online"' + (s.kind === 'online' ? ' selected' : '') + '>網路</option></select></div>' +
        '<div><label>進位模式</label><select name="rounding">' +
        Object.keys(Core.ROUNDING_MODES).map(k => '<option value="' + k + '"' + ((s.rounding || 'line-round') === k ? ' selected' : '') + '>' + esc(Core.ROUNDING_MODES[k]) + '</option>').join('') + '</select></div></div>' +
        '<label>搜尋網址範本（用 {q} 代入商品名稱）</label><input name="template" value="' + esc(s.template) + '">' +
        '<div class="btns"><button class="primary">儲存</button><button type="button" class="danger" data-act="delStore" data-id="' + esc(s.id) + '">刪除</button></div></form>';
    });
    h += '<form class="card" data-form="store" data-id=""><b>新增賣場</b><label>名稱</label><input name="name" required>' +
      '<div class="grid2"><div><label>類型</label><select name="kind"><option value="physical">實體</option><option value="online">網路</option></select></div>' +
      '<div><label>進位模式</label><select name="rounding">' +
      Object.keys(Core.ROUNDING_MODES).map(k => '<option value="' + k + '">' + esc(Core.ROUNDING_MODES[k]) + '</option>').join('') + '</select></div></div>' +
      '<label>搜尋網址範本</label><input name="template" placeholder="https://…?q={q}"><div class="btns"><button class="primary">新增</button></div></form>';

    h += '<h2>分類與 BigGo</h2><form class="card" data-form="misc"><label>商品分類（一行一個）</label><textarea name="cats">' +
      esc((S.settings.categories || []).join('\n')) + '</textarea><label>BigGo 搜尋網址範本</label><input name="bigGo" value="' + esc(S.settings.bigGoTemplate || '') + '">' +
      '<div class="btns"><button class="primary">儲存</button></div></form>';

    h += '<h2>關於</h2><div class="card"><div>版本 ' + VERSION + '</div><div class="sub">資料版本 ' + Core.DATA_VERSION + ' · 商品 ' + S.items.length + ' 筆 · 價格 ' + S.prices.length + ' 筆</div>' +
      '<div class="hint">各賣場的搜尋網址範本是預設值，請在手機實測，網站改版時在這裡修改即可。</div>' +
      '<table class="tbl" style="margin-top:8px">' + CHANGELOG.map(c => '<tr><td>' + esc(c[0]) + '</td><td>' + esc(c[1]) + '</td><td>' + esc(c[2]) + '</td></tr>').join('') + '</table></div>';
    return h;
  }

  /* ---------- 匯出入 ---------- */
  function download(name, text) {
    const blob = new Blob([text], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    return blob.size;
  }
  function currentDump(photos) {
    const settings = {};
    ['categories', 'backupDays', 'bigGoTemplate', 'theme'].forEach(k => { if (S.settings[k] !== undefined) settings[k] = S.settings[k]; });
    const db = { settings };
    TABLES.forEach(t => { db[t] = S[t]; });
    return Core.buildExport(db, { photos });
  }
  async function doExport(photos) {
    const text = JSON.stringify(currentDump(photos));
    const size = download('shopping_' + Core.stamp() + '.json', text);
    await setSetting('lastExport', Date.now());
    toast('已匯出（' + (size / 1024 < 1024 ? Math.round(size / 1024) + ' KB' : (size / 1048576).toFixed(1) + ' MB') + '）');
    render();
  }
  async function doImport(file, mode) {
    let data;
    try { data = Core.migrate(JSON.parse(await file.text())); }
    catch (e) { toast('匯入失敗：' + e.message); return; }
    if (mode === 'replace' && !confirm('取代會清除目前所有資料，確定嗎？')) return;
    download('shopping_before_import_' + Core.stamp() + '.json', JSON.stringify(currentDump(true)));
    if (mode === 'replace') {
      for (const t of TABLES) {
        await idbClear(t);
        S[t] = [];
        for (const row of data[t]) await save(t, row);
      }
      for (const k of ['categories', 'backupDays', 'bigGoTemplate', 'theme']) if (data.settings[k] !== undefined) await setSetting(k, data.settings[k]);
      await setSetting('cart', { storeId: '', lines: [] });
      toast('已取代為備份內容');
    } else {
      const cur = {}; TABLES.forEach(t => { cur[t] = S[t]; });
      const { data: merged, stat } = Core.mergeData(cur, data);
      for (const t of TABLES) for (const row of merged[t]) if (!S[t].some(x => x === row)) await save(t, row);
      toast('合併完成：新增 ' + stat.added + ' 筆，略過 ' + stat.skipped + ' 筆重複');
    }
    applyTheme();
    render();
  }

  /* ---------- 掃碼 ---------- */
  let scanStream = null, scanTimer = null;
  async function startScan() {
    if (!('BarcodeDetector' in window)) { toast('這個瀏覽器不支援相機掃碼，請手動輸入條碼'); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { toast('無法使用相機（需要 HTTPS 網址）'); return; }
    try {
      scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    } catch (e) { toast('無法開啟相機，請確認已允許相機權限'); return; }
    const v = $('#scanVideo'); v.srcObject = scanStream; await v.play().catch(() => {});
    $('#scan').classList.add('on');
    let formats = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'qr_code'];
    try { const sup = await BarcodeDetector.getSupportedFormats(); formats = formats.filter(f => sup.includes(f)); } catch (e) { /* 使用預設 */ }
    const det = new BarcodeDetector({ formats });
    let busy = false;
    scanTimer = setInterval(async () => {
      if (busy) return; busy = true;
      try {
        const codes = await det.detect(v);
        if (codes.length && codes[0].rawValue) { const code = codes[0].rawValue; stopScan(); if (navigator.vibrate) navigator.vibrate(60); handleCode(code); }
      } catch (e) { /* 單次失敗忽略 */ }
      busy = false;
    }, 250);
  }
  function stopScan() {
    clearInterval(scanTimer); scanTimer = null;
    if (scanStream) { scanStream.getTracks().forEach(t => t.stop()); scanStream = null; }
    $('#scan').classList.remove('on');
  }
  function handleCode(code) {
    code = String(code).trim();
    if (!code) return;
    const it = S.items.find(i => i.barcode === code);
    if (it) go('#/item/' + it.id);
    else { toast('資料庫沒有這個條碼，請新增商品'); go('#/edit/new?barcode=' + encodeURIComponent(code)); }
  }

  /* ---------- 主題 ---------- */
  function applyTheme() {
    const t = S.settings.theme || 'auto';
    if (t === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t);
  }

  /* ---------- 事件 ---------- */
  document.addEventListener('click', async e => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act, id = el.dataset.id;
    try {
      if (act === 'scan') startScan();
      else if (act === 'addCart') await addToCart(id);
      else if (act === 'delItem') {
        if (confirm('刪除這個商品與它的價格紀錄？')) {
          await remove('items', id);
          for (const p of S.prices.filter(x => x.itemId === id)) await remove('prices', p.id);
          for (const p of S.refPrices.filter(x => x.itemId === id)) await remove('refPrices', p.id);
          for (const p of S.storeLinks.filter(x => x.itemId === id)) await remove('storeLinks', p.id);
          const c = cart(); c.lines = c.lines.filter(l => l.itemId !== id); await setSetting('cart', c);
          toast('已刪除'); go('#/');
        }
      }
      else if (act === 'delPrice') { if (confirm('刪除這筆價格？')) { await remove('prices', id); render(); } }
      else if (act === 'delRef') { await remove('refPrices', id); render(); }
      else if (act === 'bind') {
        const sid = el.dataset.store, lid = id + '|' + sid;
        const cur = S.storeLinks.find(x => x.id === lid);
        const url = prompt('貼上 ' + storeName(sid) + ' 的商品頁網址（留空可解除綁定）', cur ? cur.url : '');
        if (url === null) return;
        if (!url.trim()) { if (cur) await remove('storeLinks', lid); }
        else if (!Core.isHttpUrl(url.trim())) { toast('網址必須以 http 或 https 開頭'); return; }
        else await save('storeLinks', { id: lid, itemId: id, storeId: sid, url: url.trim() });
        render();
      }
      else if (act === 'cartQty') {
        const c = cart(), l = c.lines[Number(el.dataset.i)];
        l.qty = Math.max(1, Number(l.qty) + Number(el.dataset.d));
        await setSetting('cart', c); render();
      }
      else if (act === 'cartDel') { const c = cart(); c.lines.splice(Number(el.dataset.i), 1); await setSetting('cart', c); render(); }
      else if (act === 'cartClear') { if (confirm('清空購物車？')) { const c = cart(); c.lines = []; await setSetting('cart', c); render(); } }
      else if (act === 'checkout') await checkout();
      else if (act === 'copyLink') {
        const link = location.origin + location.pathname + '#/record/' + id;
        try { await navigator.clipboard.writeText(link); toast('已複製連結'); } catch (err) { prompt('複製這個連結', link); }
      }
      else if (act === 'delRecord') { if (confirm('刪除這筆購物紀錄？')) { await remove('records', id); go('#/records'); } }
      else if (act === 'export') await doExport(el.dataset.photos === '1');
      else if (act === 'delStore') {
        const used = S.prices.some(p => p.storeId === id) || S.records.some(r => r.storeId === id);
        if (confirm(used ? '這個賣場已有價格或購物紀錄，刪除後紀錄會顯示為「已刪除賣場」。確定刪除？' : '刪除這個賣場？')) { await remove('stores', id); render(); }
      }
    } catch (err) { console.error(err); toast('發生錯誤：' + err.message); }
  });

  document.addEventListener('submit', async e => {
    const f = e.target.closest('form[data-form]');
    if (!f) return;
    e.preventDefault();
    const kind = f.dataset.form, id = f.dataset.id, fd = new FormData(f);
    try {
      if (kind === 'barcode') { handleCode(fd.get('code')); }
      else if (kind === 'price') {
        const price = Number(fd.get('price'));
        if (!(price >= 0)) { toast('請輸入價格'); return; }
        await save('prices', { id: Core.uid(), itemId: id, storeId: fd.get('storeId'), price, date: fd.get('date'), onSale: !!fd.get('onSale'), note: String(fd.get('note') || '').trim(), createdAt: Date.now() });
        await setSetting('lastStore', fd.get('storeId'));
        const it = itemById(id); if (it) { it.updatedAt = Date.now(); await save('items', it); }
        toast('已記錄價格'); render();
      }
      else if (kind === 'ref') {
        const price = Number(fd.get('price'));
        if (!(price >= 0)) { toast('請輸入價格'); return; }
        await save('refPrices', { id: Core.uid(), itemId: id, source: 'BigGo', price, date: fd.get('date'), note: String(fd.get('note') || '').trim() });
        toast('已記下參考價'); render();
      }
      else if (kind === 'item') {
        const barcode = String(fd.get('barcode') || '').trim();
        const name = String(fd.get('name') || '').trim();
        if (!name) { toast('請輸入名稱'); return; }
        if (barcode && S.items.some(i => i.barcode === barcode && i.id !== id)) { toast('這個條碼已經有商品了'); return; }
        const old = id ? itemById(id) : null;
        const it = Object.assign({}, old || { id: Core.uid(), createdAt: Date.now() }, {
          barcode, name, brand: String(fd.get('brand') || '').trim(), category: fd.get('category') || '',
          size: fd.get('size') === '' ? '' : Number(fd.get('size')), unit: fd.get('unit'),
          packQty: Math.max(1, Number(fd.get('packQty')) || 1), note: String(fd.get('note') || '').trim(), updatedAt: Date.now()
        });
        if (pendingPhoto) it.photo = pendingPhoto; else if (fd.get('rmPhoto')) delete it.photo;
        pendingPhoto = null;
        await save('items', it);
        toast('已儲存'); go('#/item/' + it.id);
      }
      else if (kind === 'store') {
        const name = String(fd.get('name') || '').trim();
        if (!name) { toast('請輸入賣場名稱'); return; }
        const tpl = String(fd.get('template') || '').trim();
        if (tpl && !Core.isHttpUrl(tpl.split('{q}').join('x'))) { toast('網址範本必須以 http 或 https 開頭'); return; }
        const old = id ? storeById(id) : null;
        await save('stores', Object.assign({}, old || { id: Core.uid() }, { name, kind: fd.get('kind'), rounding: fd.get('rounding'), template: tpl }));
        toast(id ? '已儲存' : '已新增賣場'); render();
      }
      else if (kind === 'misc') {
        const cats = String(fd.get('cats') || '').split('\n').map(s => s.trim()).filter(Boolean);
        const big = String(fd.get('bigGo') || '').trim();
        if (big && !Core.isHttpUrl(big.split('{q}').join('x'))) { toast('BigGo 網址範本必須以 http 或 https 開頭'); return; }
        await setSetting('categories', cats.length ? cats : Core.DEFAULT_CATEGORIES.slice());
        await setSetting('bigGoTemplate', big || Core.BIGGO_TEMPLATE);
        toast('已儲存'); render();
      }
    } catch (err) { console.error(err); toast('發生錯誤：' + err.message); }
  });

  function onSearchInput(e) {
    if (e.target.id === 'homeSearch') {
      if (e.isComposing) return; // 注音輸入選字中先不重繪，避免打斷輸入
      homeQuery = e.target.value;
      const pos = e.target.selectionStart;
      render();
      const el = $('#homeSearch'); if (el) { el.focus(); el.setSelectionRange(pos, pos); }
    }
  }
  document.addEventListener('input', onSearchInput);
  document.addEventListener('compositionend', onSearchInput);

  document.addEventListener('change', async e => {
    const t = e.target;
    try {
      if (t.id === 'cartStore') {
        const c = cart(); c.storeId = t.value;
        c.lines.forEach(l => { if (!l.manual) { const p = c.storeId ? latestPrice(l.itemId, c.storeId) : null; l.price = p ? p.price : null; } });
        await setSetting('cart', c); render();
      }
      else if (t.dataset && t.dataset.cartprice !== undefined) {
        const c = cart(), l = c.lines[Number(t.dataset.cartprice)];
        l.price = t.value === '' ? null : Number(t.value); l.manual = true;
        await setSetting('cart', c); render();
      }
      else if (t.id === 'theme') { await setSetting('theme', t.value); applyTheme(); }
      else if (t.id === 'readOnly') { await setSetting('readOnly', t.checked); toast(t.checked ? '已啟用唯讀模式' : '已關閉唯讀模式'); render(); }
      else if (t.id === 'backupDays') { await setSetting('backupDays', Math.max(1, Number(t.value) || 14)); toast('已儲存'); }
      else if (t.id === 'importFile' && t.files[0]) { await doImport(t.files[0], $('#importMode').value); t.value = ''; }
      else if (t.id === 'photoFile' && t.files[0]) {
        try {
          pendingPhoto = await resizeImage(t.files[0]);
          const p = $('#photoPrev'); p.src = pendingPhoto; p.style.display = 'block';
        } catch (err) { toast(err.message); }
      }
    } catch (err) { console.error(err); toast('發生錯誤：' + err.message); }
  });

  $('#scanClose').addEventListener('click', stopScan);
  window.addEventListener('hashchange', () => { stopScan(); render(); });

  /* ---------- 啟動 ---------- */
  (async function init() {
    try {
      if (!window.indexedDB) throw new Error('此瀏覽器不支援本機資料庫');
      idb = await openDB();
      await loadAll();
      await seed();
      applyTheme();
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
      render();
    } catch (e) {
      $('#view').innerHTML = '<div class="card">啟動失敗：' + esc(e.message) + '<div class="hint">私密瀏覽模式下可能無法使用本機資料庫。</div></div>';
      console.error(e);
    }
  })();
})();
