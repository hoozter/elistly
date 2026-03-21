/**
 * Elistly setup: Staff / people. People and teams; simple directory.
 */
(function () {
  'use strict';
  window.ELISTLY_PRESETS = window.ELISTLY_PRESETS || {};
  window.ELISTLY_PRESETS.staff = {
    id: 'staff',
    label: 'Staff / people',
    description: 'People and teams. Simple directory.',
    categories: {
      people: { id: 'people', label: 'People', icon: 'group', visibleInDashboard: true },
      teams: { id: 'teams', label: 'Teams', icon: 'group', visibleInDashboard: true }
    },
    entityTypes: {
      person: {
        id: 'person',
        label: 'Person',
        category: 'people',
        icon: 'account_circle',
        enableNameGen: true,
        nameGen: {
          prefix: '',
          prefixEnabled: false,
          partOfNamePrefix: false,
          suffixType: 'number',
          componentsOrder: [
            { type: 'field', name: 'firstName' },
            { type: 'separator', value: ' ' },
            { type: 'field', name: 'lastName' }
          ]
        },
        fields: [
          { name: 'firstName', label: 'First Name', type: 'text', required: true, visibleInCard: false, partOfName: true },
          { name: 'lastName', label: 'Last Name', type: 'text', required: true, visibleInCard: false, partOfName: true },
          { name: 'email', label: 'Email', type: 'text', required: false, visibleInCard: true, partOfName: false },
          { name: 'role', label: 'Role', type: 'text', required: false, visibleInCard: true, partOfName: false },
          { name: 'notes', label: 'Notes', type: 'textarea', required: false, visibleInCard: false, partOfName: false }
        ],
        associations: [{ name: 'memberOf', label: 'Team', type: 'association', required: false, visibleInCard: false, partOfName: false, association: { kind: 'belongs_to', targetType: 'team' } }]
      },
      team: { id: 'team', label: 'Team', category: 'teams', icon: 'group', enableNameGen: false, nameGen: { prefix: '', prefixEnabled: false, partOfNamePrefix: false, suffixType: 'number', componentsOrder: [] }, fields: [{ name: 'name', label: 'Team Name', type: 'text', required: true, visibleInCard: false, partOfName: false }, { name: 'notes', label: 'Notes', type: 'textarea', required: false, visibleInCard: false, partOfName: false }], associations: [] }
    },
    entities: {}
  };
})();
