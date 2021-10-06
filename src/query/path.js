'use strict'

const {
  ALPHA
} = require('../constants')
const { default: Queue } = require('p-queue')
const { xor } = require('uint8arrays/xor')
const defer = require('p-defer')

const MAX_UINT32 = 0xFFFFFFFF

/**
 * @typedef {import('peer-id')} PeerId
 * @typedef {import('../types').QueryResult<any>} QueryResult
 * @typedef {import('../types').QueryFunc<any>} QueryFunc
 */

/**
 * Walks a path through the DHT, calling the passed query function for
 * every peer encountered that we have not seen before.
 *
 * @param {Uint8Array} targetKey - what are we trying to find
 * @param {PeerId} startingPeer - where we start our query
 * @param {PeerId} ourPeerId - who we are
 * @param {Set<PeerId>} peersSeen - list of peers all paths have traversed
 * @param {AbortSignal} signal - when to stop querying
 * @param {QueryFunc} query - the query function to run with each peer
 */
module.exports.disjointPathQuery = async function * pathQuery (targetKey, startingPeer, ourPeerId, peersSeen, signal, query) {
  // Only ALPHA node/value lookups are allowed at any given time for each process
  // https://github.com/libp2p/specs/tree/master/kad-dht#alpha-concurrency-parameter-%CE%B1
  const queue = new Queue({
    concurrency: ALPHA
  })

  // clear the queue if the query is aborted
  signal.addEventListener('abort', () => {
    queue.clear()
    queue.emit('idle')
  })

  /**
   * Adds the passed peer to the query queue if it's not us and no
   * other path has passed through this peer
   *
   * @param {PeerId} peer
   */
  function queryPeer (peer) {
    if (peersSeen.has(peer) || ourPeerId.equals(peer)) {
      return
    }

    peersSeen.add(peer)

    queue.add(async () => {
      try {
        const result = await query(peer, signal)

        if (result.done) {
          return result
        }

        // if there are closer peers and the query has not been aborted, continue the query
        if (result.closerPeers && !signal.aborted) {
          result.closerPeers
            .map(peerData => peerData.id)
            .forEach(queryPeer)
        }

        // @ts-ignore simulate p-queue@7.x.x event
        queue.emit('completed', result)
      } catch (err) {
        // @ts-ignore simulate p-queue@7.x.x event
        queue.emit('error', err)
      }
    }, {
      // use the xor value as the queue priority - closer peers should execute first
      priority: MAX_UINT32 - new DataView(xor(peer.toBytes(), targetKey), 0).getUint32(0, true)
    })
  }

  // begin the query with the starting peer
  queryPeer(startingPeer)

  // yield results as they come in
  yield * toGenerator(queue)
}

/**
 * @param {Queue} queue
 */
function * toGenerator (queue) {
  /** @type {defer.DeferredPromise<QueryResult>} */
  let deferred = defer()
  let running = true

  // @ts-expect-error 'completed' event is in p-queue@7.x.x
  queue.on('completed', result => {
    deferred.resolve(result)
  })
  // @ts-expect-error 'error' event is in p-queue@7.x.x
  queue.on('error', err => {
    deferred.reject(err)
  })
  queue.on('idle', () => {
    running = false
  })

  while (running) { // eslint-disable-line no-unmodified-loop-condition
    yield deferred.promise
    deferred = defer()
  }
}
