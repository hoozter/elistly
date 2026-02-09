/**
 * Sample data for Elistly "Load sample data?" prompt.
 *
 * Each preset (library, it, staff, property) can have sample entities.
 * - "order": array of entity type IDs in creation order (create ref targets first;
 *   e.g. create "borrower" before "book" so books can use lentToIndex).
 * - For each type ID, an array of objects: one per sample item. Field names must
 *   match the entity type's field names (e.g. book has title, author; borrower has name, contact).
 * - lentToIndex: special key for Library books; value = index into the "borrower" array (0-based)
 *   so the book is linked to that borrower. Omit lentToIndex if the book is not lent.
 *
 * To add more samples: add objects to the right array. To add a new type to a preset,
 * add its id to "order" (after any types it references) and add a new array.
 */
(function () {
  'use strict';

  window.SAMPLE_ENTITIES = {
    library: {
      order: ['borrower', 'book'],
      borrower: [
        { name: 'Alice', contact: 'alice@example.com' },
        { name: 'Bob', contact: '' }
      ],
      book: [
        { title: 'The Great Gatsby', author: 'F. Scott Fitzgerald', lentToIndex: 0 },
        { title: '1984', author: 'George Orwell', lentToIndex: 1 },
        { title: 'A Short History of Nearly Everything', author: 'Bill Bryson' }
      ]
    },

    it: {
      order: ['person', 'computer'],
      person: [
        { firstName: 'Jamie', lastName: 'Smith', email: 'jamie@example.com', role: 'Developer' },
        { firstName: 'Sam', lastName: 'Jones', email: 'sam@example.com', role: 'Designer' }
      ],
      computer: [
        { indexYear: '2024', cpu: 'Intel Core i7', ram: '16GB' },
        { indexYear: '2023', cpu: 'Intel Core i5', ram: '8GB' }
      ]
    },

    staff: {
      order: ['team', 'person'],
      team: [
        { name: 'Operations' },
        { name: 'Design' }
      ],
      person: [
        { firstName: 'Avery', lastName: 'Coleman', email: 'avery@example.com', role: 'Ops Manager' },
        { firstName: 'Riley', lastName: 'Nguyen', email: 'riley@example.com', role: 'Designer' }
      ]
    },

    property: {
      order: ['building', 'unit'],
      building: [
        { name: 'Riverside Apartments', address: '12 Lakeview Rd' },
        { name: 'Hillcrest Offices', address: '88 Market St' }
      ],
      unit: [
        { name: 'Unit 1A', locatedInIndex: 0 },
        { name: 'Suite 204', locatedInIndex: 1 }
      ]
    },

    blank: {}
  };
})();
