// === content.js ===

['error','warn','info'].forEach(level => {
  const orig = console[level];
  console[level] = (...args) => {
    if (args.some(a => typeof a === 'string' && a.includes('Access to fetch'))) return;
    orig(...args);
  };
});

(async () => {
  console.log('[iNat] content.js loaded');
  chrome.runtime.sendMessage({ type: 'ping' }, () => {});

  let lastFetch = Date.now(), pauseUntil = 0;
  const INTERVAL_MS = 1000, PAUSE_MS = 60000;
  const sessionCache = new Map();

  function getWeekly(id) {
    const raw = localStorage.getItem(`inat_total_${id}`);
    if (!raw) return null;
    try {
      const { total, exp } = JSON.parse(raw);
      if (Date.now() >= exp) { localStorage.removeItem(`inat_total_${id}`); return null; }
      return total;
    } catch {
      // Corrupt cache entry; remove silently
      localStorage.removeItem(`inat_total_${id}`);
      return null;
    }
  }
  function setWeekly(id, total) {
    //console.log(`[iNat] setWeekly cache ${id} = ${total}`);
    //console.log(`[iNat] saving weekly cache for ${id}: ${total}`);
    const exp = Date.now() + 7*24*60*60*1000;
    localStorage.setItem(`inat_total_${id}`, JSON.stringify({ total, exp }));
  }
  async function throttle() {
    const now = Date.now();
    if (now < pauseUntil) {
      console.log(`[iNat] pausing until ${new Date(pauseUntil).toISOString()}`);
      await new Promise(r => setTimeout(r, pauseUntil - now));
    }
    const delta = now - lastFetch;
    if (delta < INTERVAL_MS) {
      console.log(`[iNat] throttling, waiting ${INTERVAL_MS - delta}ms`);
      await new Promise(r => setTimeout(r, INTERVAL_MS - delta));
    }
    lastFetch = Date.now();
  }

  const retryQueue = [], queuedTids = new Set();

  await new Promise(res => {
    const iv = setInterval(() => {
      const g = document.getElementById('taxa-grid');
      if (g && g.querySelector('.taxon-grid-cell')) { clearInterval(iv); res(); }
    }, 200);
  });
  const grid = document.getElementById('taxa-grid');
  //console.log('[iNat] Found species grid');

  function getTiles() {
    return Array.from(grid.querySelectorAll('.taxon-grid-cell'));
  }

  // Map of tid => total
  const totalsMap = {};

  // Helper to format caption within 19 chars
  function fmtLine(local,total){
    let base = `${local.toLocaleString()} / ${total.toLocaleString()}`;
    let pct  = (total? (local/total)*100 : 0);
    let pctStr = pct.toFixed(1);
    if ((base.length + pctStr.length + 3) > 19) pctStr = Math.round(pct).toString();
    if ((base.length + pctStr.length + 3) > 19) base = base.replace(' / ','/');
    const spacer = base.includes(' / ') ? ' ' : ' ';
    return `${base}${spacer}(${pctStr}%)`;
  }

  function patchTile(tile) {
    const link = tile.querySelector('.photometa a');
    if (!link || tile.dataset.patched) return;

    const local = Number(link.textContent.replace(/[^0-9]/g, ''));
    const href  = link.getAttribute('ng-href') || link.href;
    const tid   = Number(new URL(href, location.origin).searchParams.get('taxon_id'));

    // Cache check with verbose logging
    //console.log(`[iNat] cache check for ${tid}`);
    if (totalsMap[tid] == null) {
      if (sessionCache.has(tid)) {
        const hit = sessionCache.get(tid);
        //console.log(`[iNat] sessionCache hit for ${tid}: ${hit}`);
        totalsMap[tid] = hit;
      } else {
        const w = getWeekly(tid);
        if (w != null) {
          //console.log(`[iNat] weekly cache hit for ${tid}: ${w}`);
          totalsMap[tid] = w;
        } else {
          ;//console.log(`[iNat] cache miss for ${tid} – queueing`);
        }
      }
    }

    const total = totalsMap[tid];
    if (total == null) {
      if (!queuedTids.has(tid)) { queuedTids.add(tid); retryQueue.push({ tile, tid }); }
      return;
    }

    const pct = total ? (local / total) * 100 : 0;
    {
      let base = `${local.toLocaleString()} / ${total.toLocaleString()}`;
      let pctStr = ((local/total)*100).toFixed(2);
      if ((base.length + pctStr.length + 3) > 19) pctStr = Math.round((local/total)*100).toString();
      if ((base.length + pctStr.length + 3) > 19) base = base.replace(' / ','/');
      link.textContent = fmtLine(local,total);
    }

    tile.dataset.localRaw = local;
    tile.dataset.totalRaw = total;
    tile.dataset.pctRaw   = pct;
    tile.dataset.patched  = 'yes';
  }
  
  

  function patchAll() {
    console.log('[iNat] patchAll start');
    getTiles().forEach(patchTile);
    console.log('[iNat] patchAll complete');
  }

  // Initial collection & cache
  const allIds = getTiles().map(t => {
    const l = t.querySelector('.photometa a');
    return l ? Number(new URL(l.getAttribute('ng-href')||l.href, location.origin).searchParams.get('taxon_id')) : null;
  }).filter(Boolean);
  console.log('[iNat] Collected IDs:', allIds);

  const misses = [];
  allIds.forEach(id => {
    const w = getWeekly(id);
    if (w != null) { totalsMap[id] = w; }
    else if (sessionCache.has(id)) { totalsMap[id] = sessionCache.get(id); }
    else { misses.push(id); }
  });
  console.log('[iNat] Cache summary — misses:', misses);

  if (misses.length) {
    await throttle();
    console.log('[iNat] batch fetch for misses:', misses);
    const batch = misses.splice(0, 30);
    console.log('[iNat] sending batch fetch:', batch);
    chrome.runtime.sendMessage({ type:'fetchTotalsFacet', ids: batch }, resp => {
      console.log('[iNat] batch raw response:', resp);
      const t = (resp && resp.totals) || {};
      console.log('[iNat] parsed batch totals:', t);

      Object.entries(t).forEach(([id, count]) => {
        const num = Number(id);
        //console.log(`[iNat] caching ${num}=${count}`);
        sessionCache.set(num, count);
        //console.log(`[iNat] sessionCache set ${num} = ${count}`);
        setWeekly(num, count);
        totalsMap[num] = count;
      });

      patchAll();
    });
  } else {
    patchAll();
  }

  // Observe lazy-load & enqueue
  const observer = new MutationObserver(muts => {
    muts.forEach(m => m.addedNodes.forEach(n => {
      if (n.nodeType !== 1) return;
      const newTiles = n.matches('.taxon-grid-cell')
        ? [n]
        : Array.from(n.querySelectorAll('.taxon-grid-cell'));
      newTiles.forEach(tile => {
        //console.log('[iNat] observer saw new tile', tile);
        patchTile(tile);
      });
    }));
  });
  observer.observe(grid, { childList: true, subtree: true });
  console.log('[iNat] MutationObserver attached');

  // Retry loop
  (async () => {
    while (true) {
      if (retryQueue.length) {
        const batch = retryQueue.splice(0, 30);
        const ids = batch.map(e => e.tid);
        await throttle();
        //console.log('[iNat] processing retry batch:', ids);
        chrome.runtime.sendMessage({ type:'fetchTotalsFacet', ids }, resp => {
          //console.log('[iNat] retry raw response:', resp);
          const t = (resp && resp.totals) || {};
          //console.log('[iNat] retry parsed totals:', t);

          batch.forEach(({ tile, tid }) => {
            const total = t[tid];
            if (total != null) {
              // cache the newly fetched total
              sessionCache.set(tid, total);
              setWeekly(tid, total);
              //console.log(`[iNat] sessionCache set ${tid} = ${total}`);
              //console.log(`[iNat] setWeekly cache ${tid} = ${total}`);
              const link = tile.querySelector('.photometa a');
              const local = Number(link.textContent.replace(/[^0-9]/g, ''));
              const pct = ((local/total)*100).toFixed(2);
              //console.log(`[iNat] retry patch ${tid}: ${local}/${total} (${pct}%)`);
              link.textContent = fmtLine(local,total);
              tile.dataset.localRaw = local;
              tile.dataset.totalRaw = total;
              tile.dataset.pctRaw = parseFloat(pct);
              tile.dataset.patched = 'yes';
            } else {
              console.log(`[iNat] retry miss ${tid}, falling back`);
              patchTile(tile);
            }
          });
        });
      }
      await new Promise(r => setTimeout(r, INTERVAL_MS));
    }
  })();

  // UI Controls
  const ctrl = document.createElement('div');
  ctrl.style.margin = '8px';
  ctrl.style.display = 'flex';
  ctrl.style.gap = '6px';
  ['Percent','Total','Local'].forEach(label => {
    let asc = true;
    const btn = document.createElement('button');
    btn.textContent = `${label} ▼`;
    btn.onclick = () => {
      const key = label === 'Percent' ? 'pctRaw' : label.toLowerCase() + 'Raw';
      getTiles()
        .sort((a, b) => {
          const aVal = Number(a.dataset[key]);
          const bVal = Number(b.dataset[key]);
          return asc ? aVal - bVal : bVal - aVal;
        })
        .forEach((t, i) => { t.style.order = i; });
      asc = !asc;
      btn.textContent = `${label} ${asc ? '▼' : '▲'}`;
    };
    ctrl.appendChild(btn);
  });
  grid.parentNode.insertBefore(ctrl, grid);
})();
