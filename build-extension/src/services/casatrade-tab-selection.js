import { detectPlatform } from '../platforms/registry.js';

function platformFromUrl(url = '') {
  try {
    return detectPlatform(new URL(url).hostname);
  } catch {
    return null;
  }
}

function lastAccessed(tab = {}) {
  const value = Number(tab.lastAccessed);
  return Number.isFinite(value) ? value : 0;
}

export function selectCasaTradeTab(tabs = []) {
  const candidates = (Array.isArray(tabs) ? tabs : [])
    .map((tab, index) => ({ tab, platform: platformFromUrl(tab?.url), index }))
    .filter(({ tab, platform }) => tab?.id != null && !!platform)
    .sort((left, right) => {
      const recencyDiff = lastAccessed(right.tab) - lastAccessed(left.tab);
      if (recencyDiff) return recencyDiff;

      const activeDiff = Number(Boolean(right.tab?.active)) - Number(Boolean(left.tab?.active));
      if (activeDiff) return activeDiff;

      return left.index - right.index;
    });

  return candidates[0] || { tab: null, platform: null };
}

export async function findCasaTradeTab(queryTabs = query => chrome.tabs.query(query)) {
  const tabs = await queryTabs({});
  return selectCasaTradeTab(tabs);
}
