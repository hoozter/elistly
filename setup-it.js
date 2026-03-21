/**
 * Elistly setup: IT assets. Devices, networks, people, locations.
 */
(function () {
  'use strict';
  window.ELISTLY_PRESETS = window.ELISTLY_PRESETS || {};
  window.ELISTLY_PRESETS.it = {
    id: 'it',
    label: 'IT assets',
    description: 'Devices, networks, people, locations. Track computers, phones, and who uses what.',
    categories: {
      devices: { id: 'devices', label: 'Devices', icon: 'devices', visibleInDashboard: true },
      networks: { id: 'networks', label: 'Networks', icon: 'router', visibleInDashboard: true },
      people: { id: 'people', label: 'People', icon: 'group', visibleInDashboard: true },
      teams: { id: 'teams', label: 'Teams', icon: 'group', visibleInDashboard: true },
      locations: { id: 'locations', label: 'Locations', icon: 'business', visibleInDashboard: true }
    },
    entityTypes: {
      computer: {
        id: 'computer', label: 'Computer', category: 'devices', icon: 'computer',
        enableNameGen: true,
        nameGen: {
          prefix: 'PC',
          prefixEnabled: true,
          partOfNamePrefix: true,
          suffixType: 'number',
          componentsOrder: [
            { type: 'field', name: 'indexYear' },
            { type: 'field', name: 'cpu' },
            { type: 'field', name: 'ram' }
          ]
        },
        fields: [
          { name: 'indexYear', label: 'Year', type: 'dropdown', required: true, visibleInCard: true, partOfName: true, options: [{ value: '2020', nameValue: 'Y0' }, { value: '2021', nameValue: 'Y1' }, { value: '2022', nameValue: 'Y2' }, { value: '2023', nameValue: 'Y3' }, { value: '2024', nameValue: 'Y4' }, { value: '2025', nameValue: 'Y5' }] },
          { name: 'cpu', label: 'CPU', type: 'dropdown', required: true, visibleInCard: true, partOfName: true, options: [{ value: 'Intel Core i5', nameValue: '5' }, { value: 'Intel Core i7', nameValue: '7' }, { value: 'Intel Core i9', nameValue: '9' }, { value: 'Intel Core 7 Ultra', nameValue: '7U' }, { value: 'Intel Core 9 Ultra', nameValue: '9U' }] },
          { name: 'ram', label: 'RAM', type: 'dropdown', required: true, visibleInCard: true, partOfName: true, options: [{ value: '8GB', nameValue: '8' }, { value: '16GB', nameValue: '16' }, { value: '32GB', nameValue: '32' }, { value: '64GB', nameValue: '64' }] },
          { name: 'notes', label: 'Notes', type: 'textarea', required: false, visibleInCard: false, partOfName: false }
        ],
        associations: [{ name: 'assignedTo', label: 'Assigned To', type: 'association', association: { kind: 'belongs_to', targetType: 'person' } }, { name: 'locatedAt', label: 'Located At', type: 'association', association: { kind: 'belongs_to', targetType: 'building' } }]
      },
      phone: {
        id: 'phone', label: 'Phone', category: 'devices', icon: 'phone_android',
        enableNameGen: true,
        nameGen: {
          prefix: '',
          prefixEnabled: false,
          partOfNamePrefix: false,
          suffixType: 'number',
          componentsOrder: [
            { type: 'field', name: 'model' },
            { type: 'separator', value: ' - ' },
            { type: 'association', name: 'assignedTo' }
          ]
        },
        fields: [
          { name: 'model', label: 'Model', type: 'text', required: true, visibleInCard: true, partOfName: true },
          { name: 'notes', label: 'Notes', type: 'textarea', required: false, visibleInCard: false, partOfName: false }
        ],
        associations: [
          { name: 'assignedTo', label: 'Assigned To', type: 'association', required: false, visibleInCard: true, partOfName: true, association: { kind: 'belongs_to', targetType: 'person' } },
          { name: 'locatedAt', label: 'Located At', type: 'association', required: false, visibleInCard: false, partOfName: false, association: { kind: 'belongs_to', targetType: 'building' } }
        ]
      },
      networkDevice: {
        id: 'networkDevice', label: 'Network Device', category: 'networks', icon: 'router',
        enableNameGen: false,
        nameGen: { prefix: '', prefixEnabled: false, partOfNamePrefix: false, suffixType: 'number', componentsOrder: [] },
        fields: [
          { name: 'name', label: 'Name', type: 'text', required: true, visibleInCard: false, partOfName: false },
          { name: 'modelName', label: 'Model Name', type: 'text', required: false, visibleInCard: true, partOfName: false },
          { name: 'serialNumber', label: 'S/N', type: 'text', required: false, visibleInCard: true, partOfName: false },
          { name: 'linkSpeed', label: 'Link Speed', type: 'text', required: false, visibleInCard: true, partOfName: false },
          { name: 'notes', label: 'Notes', type: 'textarea', required: false, visibleInCard: false, partOfName: false }
        ],
        associations: [{ name: 'connectedTo', label: 'Connected To', type: 'association', association: { kind: 'hierarchy', targetType: 'networkDevice' } }, { name: 'locatedAt', label: 'Located At', type: 'association', association: { kind: 'belongs_to', targetType: 'building' } }]
      },
      person: {
        id: 'person', label: 'Person', category: 'people', icon: 'account_circle',
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
          { name: 'phone', label: 'Phone Number', type: 'text', required: false, visibleInCard: true, partOfName: false },
          { name: 'email', label: 'Email Address', type: 'text', required: false, visibleInCard: true, partOfName: false },
          { name: 'workTitle', label: 'Work Title', type: 'text', required: false, visibleInCard: true, partOfName: false },
          { name: 'notes', label: 'Notes', type: 'textarea', required: false, visibleInCard: false, partOfName: false }
        ],
        associations: [{ name: 'memberOf', label: 'Member Of', type: 'association', association: { kind: 'belongs_to', targetType: 'team' } }, { name: 'locatedAt', label: 'Located At', type: 'association', association: { kind: 'belongs_to', targetType: 'building' } }]
      },
      team: { id: 'team', label: 'Team', category: 'teams', icon: 'group', enableNameGen: false, nameGen: { prefix: '', prefixEnabled: false, partOfNamePrefix: false, suffixType: 'number', componentsOrder: [] }, fields: [{ name: 'name', label: 'Team Name', type: 'text', required: true, visibleInCard: false, partOfName: false }, { name: 'notes', label: 'Notes', type: 'textarea', required: false, visibleInCard: false, partOfName: false }], associations: [] },
      building: { id: 'building', label: 'Building', category: 'locations', icon: 'business', enableNameGen: false, nameGen: { prefix: '', prefixEnabled: false, partOfNamePrefix: false, suffixType: 'number', componentsOrder: [] }, fields: [{ name: 'name', label: 'Name', type: 'text', required: true, visibleInCard: false, partOfName: false }, { name: 'address', label: 'Address', type: 'text', required: true, visibleInCard: true, partOfName: false }, { name: 'phone', label: 'Phone Number', type: 'text', required: false, visibleInCard: true, partOfName: false }, { name: 'notes', label: 'Notes', type: 'textarea', required: false, visibleInCard: false, partOfName: false }], associations: [] }
    },
    entities: {
      computer1: { id: 'computer1', type: 'computer', indexYear: '2023', cpu: 'Intel Core i5', ram: '8GB' },
      phone1: { id: 'phone1', type: 'phone', model: 'Galaxy S21' },
      netdev1: { id: 'netdev1', type: 'networkDevice', name: 'Core Router', modelName: 'Asus RT-BE86U', serialNumber: 'SN-RTBE86U-001', linkSpeed: '10 Gbps' },
      person1: { id: 'person1', type: 'person', firstName: 'John', lastName: 'Doe' },
      team1: { id: 'team1', type: 'team', name: 'Admins' },
      building1: { id: 'building1', type: 'building', name: 'Main Office', address: '123 Main St', phone: '555-1234', notes: 'Main office' }
    }
  };
})();
