
// === background.js ===
console.log('[iNat-bg] background.js loaded');
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'ping') {
    sendResponse({ reply: 'pong' });
    return true;
  }
  if (msg.type === 'fetchTotalsFacet') {
    const ids = msg.ids.slice(0, 30).map(Number);
    console.log(`[iNat-bg] taxa request for ${ids.length} IDs`);
    const url = `https://api.inaturalist.org/v1/taxa/${ids.join(',')}`;
    fetch(url)
      .then(r => r.ok ? r.json() : Promise.resolve({ results: [] }))
      .then(data => {
        const totals = {};
        (data.results || []).forEach(t => { totals[t.id] = t.observations_count; });
        console.log('[iNat-bg] taxa parsed totals:', totals);
        sendResponse({ totals });
      })
      .catch(err => { console.error('[iNat-bg] taxa fetch error:', err); sendResponse({ totals: {} }); });
    return true;
  }
});
