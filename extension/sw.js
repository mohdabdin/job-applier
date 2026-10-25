// Opens the side panel from the toolbar icon, and keeps track of which job a tab belongs to.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove(`tab:${tabId}`));

// A tab opened from a job's tab (LinkedIn's Apply button, a "continue application" link) is the same job.
chrome.tabs.onCreated.addListener(async (tab) => {
  if (!tab.openerTabId) return;
  const from = `tab:${tab.openerTabId}`;
  const job = (await chrome.storage.session.get(from))[from];
  if (job) await chrome.storage.session.set({ [`tab:${tab.id}`]: job });
});
