'use strict'

const { default: Queue } = require('p-queue')
const { xor } = require('uint8arrays/xor')
const { toString } = require('uint8arrays/to-string')
const defer = require('p-defer')
const errCode = require('err-code')
const { convertPeerId } = require('../utils')

const MAX_XOR = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF')

/**
 * @typedef {import('peer-id')} PeerId
 * @typedef {import('../types').QueryResult<any>} QueryResult
 * @typedef {import('../types').QueryFunc<any>} QueryFunc
 */

/**
 * Walks a path through the DHT, calling the passed query function for
 * every peer encountered that we have not seen before.
 *
 * @param {Uint8Array} key - what are we trying to find
 * @param {Uint8Array} kadId - sha256(key)
 * @param {PeerId} startingPeer - where we start our query
 * @param {PeerId} ourPeerId - who we are
 * @param {Set<string>} peersSeen - list of peers all paths have traversed
 * @param {AbortSignal} signal - when to stop querying
 * @param {QueryFunc} query - the query function to run with each peer
 * @param {number} pathIndex - which disjoint path we are following
 * @param {number} numPaths - the total number of disjoint paths being executed
 * @param {number} alpha - how many concurrent node/value lookups to run
 */
module.exports.disjointPathQuery = async function * disjointPathQuery (key, kadId, startingPeer, ourPeerId, peersSeen, signal, query, pathIndex, numPaths, alpha) {
  // Only ALPHA node/value lookups are allowed at any given time for each process
  // https://github.com/libp2p/specs/tree/master/kad-dht#alpha-concurrency-parameter-%CE%B1
  const queue = new Queue({
    concurrency: alpha
  })

  /**
   * Adds the passed peer to the query queue if it's not us and no
   * other path has passed through this peer
   *
   * @param {PeerId} peer
   * @param {Uint8Array} peerKadId
   */
  function queryPeer (peer, peerKadId) {
    if (!peer || peersSeen.has(peer.toB58String()) || ourPeerId.equals(peer)) {
      return
    }

    peersSeen.add(peer.toB58String())

    const peerXor = BigInt('0x' + toString(xor(peerKadId, kadId), 'base16'))

    queue.add(async () => {
      try {
        const result = await query({
          key,
          peer,
          signal,
          pathIndex,
          numPaths
        })

        if (signal.aborted) {
          return
        }

        // if there are closer peers and the query has not completed, continue the query
        if (result && !result.done && result.closerPeers) {
          for (const closerPeer of result.closerPeers) {
            const closerPeerKadId = await convertPeerId(closerPeer)
            const closerPeerXor = BigInt('0x' + toString(xor(closerPeerKadId, kadId), 'base16'))

            // only continue query if "closer" peer is actually closer
            if (closerPeerXor < peerXor) {
              queryPeer(closerPeer, closerPeerKadId)
            }
          }
        }

        // @ts-ignore simulate p-queue@7.x.x event
        queue.emit('completed', {
          peer,
          ...(result || {})
        })

        // the query is done, skip any waiting peer queries in the queue
        if (result && result.done) {
          queue.clear()
        }
      } catch (err) {
        // @ts-ignore simulate p-queue@7.x.x event
        queue.emit('error', err)
      }
    }, {
      // use xor value as the queue priority - closer peers should execute first
      // subtract it from MAX_XOR because higher priority values execute sooner

      // @ts-expect-error this is supposed to be a Number but it's ok to use BigInts
      // as long as all priorities are BigInts since we won't mix BigInts and Number
      // values in arithmetic operations
      priority: MAX_XOR - peerXor
    })
  }

  // begin the query with the starting peer
  queryPeer(startingPeer, await convertPeerId(startingPeer))

  // yield results as they come in
  yield * toGenerator(queue, signal)
}

/**
 * @param {Queue} queue
 * @param {AbortSignal} signal
 */
async function * toGenerator (queue, signal) {
  let deferred = defer()
  let running = true
  /** @type {QueryResult[]} */
  const results = []

  // @ts-expect-error 'completed' event is in p-queue@7.x.x
  queue.on('completed', result => {
    results.push(result)
    deferred.resolve()
  })
  // @ts-expect-error 'error' event is in p-queue@7.x.x
  queue.on('error', err => {
    deferred.reject(err)
  })
  queue.on('idle', () => {
    running = false
    deferred.resolve()
  })

  // clear the queue and throw if the query is aborted
  signal.addEventListener('abort', () => {
    queue.clear()
    deferred.reject(errCode(new Error('Query aborted'), 'ERR_QUERY_ABORTED'))
  })

  while (running) { // eslint-disable-line no-unmodified-loop-condition
    // TODO: ensure we can break out of this loop early - this promise needs to
    // be resolved manually and will leak memory otherwise
    await deferred.promise
    deferred = defer()

    // yield all available results
    while (results.length) {
      const result = results.shift()

      yield result
    }
  }

  // yield any remaining results
  yield * results
}
