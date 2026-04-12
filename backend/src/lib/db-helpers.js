// @ts-check
// Typed wrappers around better-sqlite3 queries. The raw db.prepare().get()
// returns `unknown` under checkJs, which forces `/** @type {any} */` casts
// on every query call site. These helpers centralise the cast so route
// handlers can be type-clean without annotation noise.

const db = require('../db');

/**
 * Run a SELECT that returns a single row (or undefined).
 * @param {string} sql
 * @param  {...any} params
 * @returns {any}
 */
function getOne(sql, ...params) {
  return db.prepare(sql).get(...params);
}

/**
 * Run a SELECT that returns an array of rows.
 * @param {string} sql
 * @param  {...any} params
 * @returns {any[]}
 */
function getAll(sql, ...params) {
  return db.prepare(sql).all(...params);
}

/**
 * Run a mutating statement (INSERT/UPDATE/DELETE).
 * @param {string} sql
 * @param  {...any} params
 * @returns {import('better-sqlite3').RunResult}
 */
function run(sql, ...params) {
  return db.prepare(sql).run(...params);
}

/**
 * Return an iterator for streaming rows (e.g. CSV export).
 * @param {string} sql
 * @param  {...any} params
 * @returns {IterableIterator<any>}
 */
function iterate(sql, ...params) {
  return db.prepare(sql).iterate(...params);
}

module.exports = { getOne, getAll, run, iterate };
