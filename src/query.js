'use strict'

const mh = require('multihashes')

const c = require('./constants')
const PeerQueue = require('./peer-queue')
const WorkerQueue = require('./worker-queue')
const utils = require('./utils')

/**
 * Divide peers up into disjoint paths (subqueries). Any peer can only be used once over all paths.
 * Within each path, query peers from closest to farthest away.
 */
class Query {
  /**
   * User-supplied function to set up an individual disjoint path. Per-path
   * query state should be held in this function's closure.
   * @typedef {makePath} function
   * @param {number} pathNum - Numeric index from zero to numPaths - 1
   * @returns {queryFunc} - Function to call on each peer in the query
   */

  /**
   * Query function.
   * @typedef {queryFunc} function
   * @param {PeerId} next - Peer to query
   * @returns {Object}
   */

  /**
   * Create a new query. The makePath function is called once per disjoint path, so that per-path
   * variables can be created in that scope. makePath then returns the actual query function (queryFunc) to
   * use when on that path.
   *
   * @param {DHT} dht - DHT instance
   * @param {Buffer} key
   * @param {makePath} makePath - Called to set up each disjoint path. Must return the query function.
   */
  constructor (dht, key, makePath) {
    this.dht = dht
    this.key = key
    this.makePath = makePath
    this.concurrency = c.ALPHA
    this._log = utils.logger(this.dht.peerInfo.id, 'query:' + mh.toB58String(key))
  }

  /**
   * Run result.
   * @typedef {Object} RunResult
   * @property {Set<PeerId>} finalSet - peers that were queried
   * @property {Array<Object>} paths - array of states per disjoint path
   */

  /**
   * Run this query, start with the given list of peers first.
   *
   * @param {Array<PeerId>} peers
   * @param {number} [timeout] - timeout in ms. If undefined, runs forever.
   * @returns {Promise<RunResult>}
   */
  async run (peers, timeout) {
    const run = {
      peersSeen: new Set(),
      errors: [],
      paths: null // array of states per disjoint path
    }

    if (peers.length === 0) {
      this._log.error('Running query with no peers')
      return
    }

    // create correct number of paths
    const numPaths = Math.min(c.DISJOINT_PATHS, peers.length)
    const pathPeers = []
    for (let i = 0; i < numPaths; i++) {
      pathPeers.push([])
    }

    // assign peers to paths round-robin style
    peers.forEach((peer, i) => {
      pathPeers[i % numPaths].push(peer)
    })
    run.paths = pathPeers.map((peers, i) => {
      return {
        peers,
        run,
        query: this.makePath(i, numPaths),
        peersToQuery: null
      }
    })

    // Set up a worker queue for each path
    const workers = await Promise.all(run.paths.map(async (path) => {
      path.peersToQuery = await PeerQueue.fromKey(this.key)
      await Promise.all(path.peers.map((p) => addPeerToQuery(p, this.dht, path)))
      return workerQueue(this, path)
    }))

    // Run the workers with a timeout
    try {
      await utils.promiseTimeout(
        Promise.all(workers.map(w => w.onComplete())),
        timeout,
        `Query for key ${this.key} timed out in ${timeout}ms`
      )
    } catch (err) {
      // There was an error, so stop all the workers
      for (const worker of workers) {
        worker.stop()
      }
      this._log(err.message)
      throw err
    }

    this._log('query:done')

    if (run.errors.length === run.peersSeen.size) {
      throw run.errors[0]
    }

    run.res = {
      finalSet: run.peersSeen,
      paths: []
    }

    run.paths.forEach((path) => {
      if (path.res && path.res.success) {
        run.res.paths.push(path.res)
      }
    })

    return run.res
  }
}

/**
 * Use the queue to keep `concurrency` amount items running
 * per path.
 *
 * @param {Query} query
 * @param {Object} path
 * @returns {Promise}
 * @private
 */
function workerQueue (query, path) {
  const processPeer = async (queue, peer) => {
    query._log('queue:work')

    let done, err
    try {
      done = await execQuery(peer, query, path)
    } catch (e) {
      query._log.error('queue', e)
      err = e
    }

    // Ignore tasks that finish after we're already done
    if (!queue.running) {
      return true
    }

    query._log('queue:work:done', err, done)

    if (err) {
      throw err
    }

    return done
  }

  return new WorkerQueue(path.peersToQuery, processPeer, {
    concurrency: query.concurrency
  })
}

/**
 * Execute a query on the `next` peer.
 *
 * @param {PeerId} next
 * @param {Query} query
 * @param {Object} path
 * @returns {Promise}
 * @private
 */
async function execQuery (next, query, path) {
  let res
  try {
    res = await path.query(next)
  } catch (err) {
    path.run.errors.push(err)
    return
  }
  if (res.success) {
    path.res = res
    return true
  }
  if (res.closerPeers && res.closerPeers.length > 0) {
    await Promise.all(res.closerPeers.map((closer) => {
      // don't add ourselves
      if (query.dht._isSelf(closer.id)) {
        return
      }
      closer = query.dht.peerBook.put(closer)
      query.dht._peerDiscovered(closer)
      return addPeerToQuery(closer.id, query.dht, path)
    }))
  }
}

/**
 * Add a peer to the peers to be queried.
 *
 * @param {PeerId} next
 * @param {DHT} dht
 * @param {Object} path
 * @returns {Promise}
 * @private
 */
function addPeerToQuery (next, dht, path) {
  const run = path.run
  if (dht._isSelf(next)) {
    return
  }

  if (run.peersSeen.has(next)) {
    return
  }

  run.peersSeen.add(next)
  return path.peersToQuery.enqueue(next)
}

module.exports = Query
