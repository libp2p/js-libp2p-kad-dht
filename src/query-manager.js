'use strict'

/**
 * Keeps track of running Queries.
 */
class QueryManager {
  /**
   * Creates a new QueryManager.
   */
  constructor () {
    this.queries = new Set()
  }

  /**
   * Called when a Query is started.
   *
   * @param {Query} query
   */
  started (query) {
    this.queries.add(query)
  }

  /**
   * Called when a Query is stopped.
   *
   * @param {Query} query
   */
  stopped (query) {
    this.queries.delete(query)
  }

  /**
   * Stop all running queries.
   */
  stopQueries () {
    for (const query of this.queries) {
      query.stop()
    }
    this.queries.clear()
  }
}

module.exports = QueryManager
