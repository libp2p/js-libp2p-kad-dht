'use strict'

const each = require('async/each')
const waterfall = require('async/waterfall')
const PeerQueue = require('../peer-queue')

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
    this.queryFunc = queryFunc
    this.initialPeers = []
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
    waterfall([
      // Create a queue of peers ordered by distance from the key
      (cb) => PeerQueue.fromKey(this.run.query.key, cb),
      // Add initial peers to the queue
      (q, cb) => {
        this.peersToQuery = q
        each(this.initialPeers, this.addPeerToQuery.bind(this), cb)
      },
      // Start processing the queue
      (cb) => {
        this.run.workerQueue(this, cb)
      }
    ], callback)
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
    // Don't add self
    if (this.run.query.dht._isSelf(peer)) {
      return callback()
    }

    // The paths must be disjoint, meaning that no two paths in the Query may
    // traverse the same peer
    if (this.run.peersSeen.has(peer)) {
      return callback()
    }

    this.peersToQuery.enqueue(peer, callback)
  }
}

module.exports = Path
