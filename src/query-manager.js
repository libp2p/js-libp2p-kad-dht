'use strict'

/**
 * Keeps track of all running queries.
 */
class QueryManager {
  /**
   * Creates a new QueryManager.
   */
  constructor () {
    this.queries = new Set()
    this.running = true
  }

  /**
   * Called when a query is started.
   *
   * @param {Query} query
   */
  queryStarted (query) {
    this.queries.add(query)
  }

  /**
   * Called when a query completes.
   *
   * @param {Query} query
   */
  queryCompleted (query) {
    this.queries.delete(query)
  }

  /**
   * Stops all queries.
   */
  stop () {
    this.running = false
    for (const query of this.queries) {
      query.stop()
    }
    this.queries.clear()
  }
}

module.exports = QueryManager
