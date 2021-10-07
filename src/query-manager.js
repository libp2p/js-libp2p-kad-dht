'use strict'

const { AbortController } = require('native-abort-controller')
const { anySignal } = require('any-signal')
const { query } = require('./query')
const {
  ALPHA
} = require('./constants')

/**
 * @typedef {import('peer-id')} PeerId
 */

/**
 * Keeps track of all running queries
 */
class QueryManager {
  /**
   * Creates a new QueryManager
   *
   * @param {PeerId} peerId
   * @param {number} disjointPaths
   * @param {number} alpha
   */
  constructor (peerId, disjointPaths, alpha = ALPHA) {
    this._peerId = peerId
    this._disjointPaths = disjointPaths
    this._controllers = new Set()
    this._running = false
    this._alpha = alpha
  }

  /**
   * Starts the query manager
   */
  start () {
    this._running = true
  }

  /**
   * Stops all queries
   */
  stop () {
    this._running = false

    for (const controller of this._controllers) {
      controller.abort()
    }

    this._controllers.clear()
  }

  /**
   * @template T
   *
   * @param {Uint8Array} key
   * @param {PeerId[]} peers
   * @param {import('./types').QueryFunc<T>} queryFunc
   * @param {AbortSignal} [signal]
   *
   * @returns {AsyncIterable<import('./types').QueryResult<T>>}
   */
  async * run (key, peers, queryFunc, signal) {
    if (!this._running) {
      throw new Error('QueryManager not started')
    }

    // allow us to stop queries on shut down
    const abortController = new AbortController()
    this._controllers.add(abortController)
    const signals = [abortController.signal]

    if (signal) {
      signals.push(signal)
    }

    // query a subset of peers up to `kBucketSize / 2` in length
    const peersToQuery = peers.slice(0, Math.min(this._disjointPaths, peers.length))

    try {
      yield * query(this._peerId, key, peersToQuery, queryFunc, anySignal(signals), this._alpha)
    } catch (/** @type {any} */ err) {
      if (!this._running && err.code === 'ERR_QUERY_ABORTED') {
        // ignore query aborted errors that were thrown during query manager shutdown
      } else {
        throw err
      }
    }

    this._controllers.delete(abortController)
  }
}

module.exports.QueryManager = QueryManager
