/**
 * Elistly setup: Start blank. Empty inventory; add your own categories and types.
 */
(function () {
  'use strict';
  window.ELISTLY_PRESETS = window.ELISTLY_PRESETS || {};
  window.ELISTLY_PRESETS.blank = {
    id: 'blank',
    label: 'Start blank',
    description: 'Empty inventory. Add your own categories and types.',
    categories: {},
    entityTypes: {},
    entities: {}
  };
})();
