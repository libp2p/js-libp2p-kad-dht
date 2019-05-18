'use strict'

const each = require('async/each')
const timeout = require('async/timeout')
const waterfall = require('async/waterfall')
const promisify = require('promisify-es6')
const promiseToCallback = require('promise-to-callback')
const PeerQueue = require('../peer-queue')

// TODO: Temporary until parallel dial in Switch have a proper
// timeout. Requires async/await refactor of transports and
// dial abort logic. This gives us 30s to complete the `queryFunc`.
// This should help reduce the high end call times of queries
const QUERY_FUNC_TIMEOUT = 30e3

/**
 * Manages a single Path through the DHT.
 */
class Path {
  /**
   * Creates a Path.
   *
   * @param {Run} run
   * @param {queryFunc} queryFunc
   */
  constructor (run, queryFunc) {
    this.run = run
    this.queryFunc = timeout(queryFunc, QUERY_FUNC_TIMEOUT)
    this.queryFuncAsync = promisify(this.queryFunc)

    /**
     * @type {Array<PeerId>}
     */
    this.initialPeers = []

    /**
     * @type {PeerQueue}
     */
    this.peersToQuery = null
  }

  /**
   * Add a peer to the set of peers that are used to intialize the path.
   *
   * @param {PeerId} peer
   */
  addInitialPeer (peer) {
    this.initialPeers.push(peer)
  }

  /**
   * Execute the path.
   *
   * @param {function(Error)} callback
   */
  execute (callback) {
    promiseToCallback(this._executeAsync())(callback)
  }

  async _executeAsync () {
    // Create a queue of peers ordered by distance from the key
    const queue = await promisify((cb) => PeerQueue.fromKey(this.run.query.key, cb))()
    // Add initial peers to the queue
    this.peersToQuery = queue
    await promisify(cb => each(this.initialPeers, this.addPeerToQuery.bind(this), cb))()
    await this.run._workerQueueAsync(this)
  }

  /**
   * Add a peer to the peers to be queried.
   *
   * @param {PeerId} peer
   * @param {function(Error)} callback
   * @returns {void}
   * @private
   */
  addPeerToQuery (peer, callback) {
    promiseToCallback(this._addPeerToQueryAsync(peer))(callback)
  }

  async _addPeerToQueryAsync (peer) {
    // Don't add self
    if (this.run.query.dht._isSelf(peer)) {
      return
    }

    // The paths must be disjoint, meaning that no two paths in the Query may
    // traverse the same peer
    if (this.run.peersSeen.has(peer)) {
      return
    }

    await promisify(cb => this.peersToQuery.enqueue(peer, cb))()
  }
}

module.exports = Path
