'use strict'

const { AbortController } = require('native-abort-controller')
const { anySignal } = require('any-signal')
const {
  ALPHA
} = require('../constants')
const { toString: uint8ArrayToString } = require('uint8arrays/to-string')
const { convertBuffer, logger } = require('../utils')
const { disjointPathQuery } = require('./disjoint-path')
const merge = require('it-merge')
const { EventEmitter } = require('events')

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
   * @param {import('../types').QueryFunc<T>} queryFunc
   * @param {AbortSignal} [signal]
   *
   * @returns {AsyncIterable<import('../types').QueryResult<T>>}
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

    const log = logger('libp2p:kad-dht:query:' + uint8ArrayToString(key, 'base58btc'))

    // query a subset of peers up to `kBucketSize / 2` in length
    const peersToQuery = peers.slice(0, Math.min(this._disjointPaths, peers.length))
    const startTime = Date.now()
    const cleanUp = new EventEmitter()

    try {
      log('query:start')

      if (peers.length === 0) {
        log.error('Running query with no peers')
        return
      }

      // The paths must be disjoint, meaning that no two paths in the query may
      // traverse the same peer
      const peersSeen = new Set()

      // perform lookups on kadId, not the actual value
      const keyKadId = await convertBuffer(key)

      // Create disjoint paths
      const paths = peersToQuery.map((peer, index) => {
        return disjointPathQuery(
          key,
          keyKadId,
          peer,
          this._peerId,
          peersSeen,
          anySignal(signals),
          queryFunc,
          index,
          peersToQuery.length,
          this._alpha,
          cleanUp
        )
      })

      /** @type {Error[]} */
      const errors = []

      // Execute the query along each disjoint path and yield their results as they become available
      for await (const res of merge(...paths)) {
        if (!res) {
          continue
        }

        yield res

        if (res.err) {
          errors.push(res.err)
        }
      }

      log(`${errors.length} of ${peersSeen.size} peers errored (${errors.length / peersSeen.size * 100}% fail rate)`)

      // If all queries errored out, something is seriously wrong, so throw an error
      if (errors.length === peersSeen.size) {
        throw errors[0]
      }
    } catch (/** @type {any} */ err) {
      if (!this._running && err.code === 'ERR_QUERY_ABORTED') {
        // ignore query aborted errors that were thrown during query manager shutdown
      } else {
        throw err
      }
    } finally {
      this._controllers.delete(abortController)
      cleanUp.emit('cleanup')
      log(`query:done in ${Date.now() - (startTime || 0)}ms`)
    }
  }
}

module.exports.QueryManager = QueryManager
