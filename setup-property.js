/**
 * Elistly setup: Property. Buildings and units; locations and occupancy.
 */
(function () {
  'use strict';
  window.ELISTLY_PRESETS = window.ELISTLY_PRESETS || {};
  window.ELISTLY_PRESETS.property = {
    id: 'property',
    label: 'Property',
    description: 'Buildings and units. Locations and occupancy.',
    categories: {
      locations: { id: 'locations', label: 'Locations', icon: 'business', visibleInDashboard: true }
    },
    entityTypes: {
      building: { id: 'building', label: 'Building', category: 'locations', icon: 'business', enableNameGen: false, nameGen: { prefix: '', prefixEnabled: false, partOfNamePrefix: false, suffixType: 'number', componentsOrder: [] }, fields: [{ name: 'name', label: 'Name', type: 'text', required: true, visibleInCard: false, partOfName: false }, { name: 'address', label: 'Address', type: 'text', required: true, visibleInCard: true, partOfName: false }, { name: 'notes', label: 'Notes', type: 'textarea', required: false, visibleInCard: false, partOfName: false }], associations: [] },
      unit: { id: 'unit', label: 'Unit', category: 'locations', icon: 'folder', enableNameGen: false, nameGen: { prefix: '', prefixEnabled: false, partOfNamePrefix: false, suffixType: 'number', componentsOrder: [] }, fields: [{ name: 'name', label: 'Unit', type: 'text', required: true, visibleInCard: false, partOfName: false }, { name: 'notes', label: 'Notes', type: 'textarea', required: false, visibleInCard: false, partOfName: false }], associations: [{ name: 'locatedIn', label: 'In building', type: 'association', required: false, visibleInCard: false, partOfName: false, association: { kind: 'belongs_to', targetType: 'building' } }] }
    },
    entities: {}
  };
})();
