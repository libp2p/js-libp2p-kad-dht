'use strict'

const { base58btc } = require('multiformats/bases/base58')
const utils = require('../utils')
const merge = require('it-merge')
const { disjointPathQuery } = require('./path')

/**
 * @typedef {import('peer-id')} PeerId
 */

/**
 * Divide peers up into disjoint paths (subqueries). Any peer can only be used once over all paths.
 *
 * Within each path, query peers from closest to farthest away.
 *
 * @template T
 * @param {PeerId} peerId
 * @param {Uint8Array} key
 * @param {PeerId[]} peers
 * @param {import('../types').MakeQueryFunc<T>} makeQuery
 * @param {AbortSignal} signal
 *
 * @returns {AsyncIterable<import('../types').QueryResult<T>>}
 */
async function * query (peerId, key, peers, makeQuery, signal) { // eslint-disable-line require-await
  this._startTime = Date.now()

  const log = utils.logger('libp2p:kad-dht:query:' + base58btc.baseEncode(key))
  log('query:start')

  try {
    if (peers.length === 0) {
      log.error('Running query with no peers')
      return
    }

    // The paths must be disjoint, meaning that no two paths in the Query may
    // traverse the same peer
    const peersSeen = new Set()

    // Create disjoint paths
    const paths = peers.map((peer, index) => {
      return disjointPathQuery(key, peer, peerId, peersSeen, signal, makeQuery(index, peers.length))
    })

    /** @type {Error[]} */
    const errors = []

    // Execute the query along each disjoint path and yield their results as they become available
    for await (const res of merge(...paths)) {
      yield res

      if (res.err) {
        errors.push(res.err)
      }
    }

    log(`${errors.length} of ${peersSeen.size} peers errored (${errors.length / peersSeen.size * 100}% fail rate)`)

    // If all queries errored out, something is seriously wrong, so callback
    // with an error
    if (errors.length === peersSeen.size) {
      throw errors[0]
    }
  } finally {
    log(`query:done in ${Date.now() - (this._startTime || 0)}ms`)
  }
}

module.exports.query = query
