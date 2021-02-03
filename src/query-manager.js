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
    this.running = false
  }

  /**
   * Called when a query is started.
   *
   * @param {import('./query')} query
   */
  queryStarted (query) {
    this.queries.add(query)
  }

  /**
   * Called when a query completes.
   *
   * @param {import('./query')} query
   */
  queryCompleted (query) {
    this.queries.delete(query)
  }

  /**
   * Starts the query manager.
   */
  start () {
    this.running = true
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
