import assert from 'node:assert/strict';
import { STATS_LIBRARY_PAGE } from './api.js';
import { statsPageHasMore } from './statsCache.js';

const page = STATS_LIBRARY_PAGE;

assert.equal(
  statsPageHasMore({
    scoped: false,
    scopedLen: 0,
    offset: 0,
    pageSize: page,
    chunk: { hasMore: true, total: 900, demos: new Array(page) },
    incomingLen: page
  }),
  true,
  'explicit hasMore wins'
);

assert.equal(
  statsPageHasMore({
    scoped: false,
    scopedLen: 0,
    offset: 0,
    pageSize: page,
    chunk: { hasMore: false, total: 900, demos: new Array(page) },
    incomingLen: page
  }),
  false,
  'explicit end of library'
);

assert.equal(
  statsPageHasMore({
    scoped: false,
    scopedLen: 0,
    offset: 0,
    pageSize: page,
    chunk: { demos: new Array(page) },
    incomingLen: page
  }),
  true,
  'a full page without hasMore is not the whole library'
);

assert.equal(
  statsPageHasMore({
    scoped: false,
    scopedLen: 0,
    offset: 0,
    pageSize: page,
    chunk: { demos: new Array(40) },
    incomingLen: 40
  }),
  false,
  'a short page without hasMore is the last page'
);

assert.equal(
  statsPageHasMore({
    scoped: false,
    scopedLen: 0,
    offset: 0,
    pageSize: page,
    chunk: { total: 850, demos: new Array(page) },
    incomingLen: page
  }),
  true,
  'library total outruns the first page'
);

assert.equal(
  statsPageHasMore({
    scoped: false,
    scopedLen: 0,
    offset: 600,
    pageSize: page,
    chunk: { total: 850, demos: new Array(250) },
    incomingLen: 250
  }),
  false,
  'offset plus page size reaches library total'
);

assert.equal(
  statsPageHasMore({
    scoped: true,
    scopedLen: 450,
    offset: 0,
    pageSize: page,
    chunk: { hasMore: false },
    incomingLen: page
  }),
  true,
  'scoped ids still page locally'
);

assert.equal(
  statsPageHasMore({
    scoped: true,
    scopedLen: 200,
    offset: 0,
    pageSize: page,
    chunk: { hasMore: true },
    incomingLen: 200
  }),
  false,
  'scoped list shorter than one page is done'
);

console.log('statsCache.test.js: ok');
