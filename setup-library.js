/**
 * Elistly setup: Library. Books and borrowers; track what you lend and to whom.
 */
(function () {
  'use strict';
  window.ELISTLY_PRESETS = window.ELISTLY_PRESETS || {};
  window.ELISTLY_PRESETS.library = {
    id: 'library',
    label: 'Library',
    description: 'Books and borrowers. Track what you lend and to whom.',
    categories: {
      books: { id: 'books', label: 'Books', icon: 'folder', visibleInDashboard: true },
      borrowers: { id: 'borrowers', label: 'Borrowers', icon: 'account_circle', visibleInDashboard: true }
    },
    entityTypes: {
      book: {
        id: 'book', label: 'Book', category: 'books', icon: 'description',
        enableNameGen: false, nameGen: { prefix: '', prefixEnabled: false, partOfNamePrefix: false, suffixType: 'number', componentsOrder: [] },
        fields: [
          { name: 'title', label: 'Title', type: 'text', required: true, visibleInCard: false, partOfName: false },
          { name: 'author', label: 'Author', type: 'text', required: false, visibleInCard: true, partOfName: false },
          { name: 'isbn', label: 'ISBN', type: 'text', required: false, visibleInCard: false, partOfName: false },
          { name: 'lentDate', label: 'Lent date', type: 'date', required: false, visibleInCard: false, partOfName: false },
          { name: 'dueDate', label: 'Due date', type: 'date', required: false, visibleInCard: true, partOfName: false },
          { name: 'notes', label: 'Notes', type: 'textarea', required: false, visibleInCard: false, partOfName: false }
        ],
        associations: [{ name: 'lentTo', label: 'Lent to', type: 'association', required: false, visibleInCard: false, partOfName: false, association: { kind: 'belongs_to', targetType: 'borrower' } }]
      },
      borrower: {
        id: 'borrower', label: 'Borrower', category: 'borrowers', icon: 'account_circle',
        enableNameGen: false, nameGen: { prefix: '', prefixEnabled: false, partOfNamePrefix: false, suffixType: 'number', componentsOrder: [] },
        fields: [
          { name: 'name', label: 'Name', type: 'text', required: true, visibleInCard: false, partOfName: false },
          { name: 'contact', label: 'Contact', type: 'text', required: false, visibleInCard: true, partOfName: false },
          { name: 'notes', label: 'Notes', type: 'textarea', required: false, visibleInCard: false, partOfName: false }
        ],
        associations: []
      }
    },
    entities: {}
  };
})();
