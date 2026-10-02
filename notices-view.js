// Present the shipped, same-origin license document in the existing legal panel.
(function () {
  async function loadThirdPartyNotices(root = document) {
    const containers = root.querySelectorAll('[data-notices-src]');
    for (const container of containers) {
      if (container.dataset.loaded === 'true') continue;
      try {
        const response = await fetch(container.dataset.noticesSrc, { credentials: 'same-origin' });
        if (!response.ok) throw new Error('Notices unavailable');
        const documentContent = new DOMParser().parseFromString(await response.text(), 'text/html');
        if (!documentContent.body.querySelector('section')) throw new Error('Notices incomplete');
        // The source is a checked-in, same-origin static document; scripts and
        // embedded content are not part of a legal notice and are never imported.
        documentContent.body.querySelectorAll('script, iframe, object, embed').forEach(node => node.remove());
        container.replaceChildren(...Array.from(documentContent.body.children).map(node => document.importNode(node, true)));
        container.dataset.loaded = 'true';
      } catch (error) {
        container.textContent = 'The notices could not be loaded. Please try reloading the page.';
      }
    }
  }
  window.loadThirdPartyNotices = loadThirdPartyNotices;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => loadThirdPartyNotices());
  else loadThirdPartyNotices();
})();
