'use strict'

const EventEmitter = require('events')
const mh = require('multihashes')
const { parallelMerge } = require('streaming-iterables')
const PeerIdSet = require('./peer-id-set')

const c = require('./constants')
const PeerQueue = require('./peer-queue')
const utils = require('./utils')

/**
 * Divide peers up into disjoint paths (subqueries). Any peer can only be used
 * once over all paths. Within each path, query peers from closest to farthest
 * away.
 */
class Query {
  /**
   * User-supplied function to set up a query over an individual disjoint path.
   * Per-path query state should be held in this function's closure.
   * @typedef {makePathQuery} function
   * @param {number} pathNum - Numeric index from zero to numPaths - 1
   * @returns {queryFunc} - Function to call on each peer in the query
   */

  /**
   * Query function.
   *
   * The query function should return an object with
   *   value: any Object - it will be yielded by the Query.run() method.
   *   closerPeers: an array of PeerInfo objects - if supplied, Query.run()
   *     will queue up those peers to be queried next.
   *   pathComplete: if true, no more queries will be made on this path.
   *   queryComplete: if true, no more queries will be made and queries
   *     on all other paths will be stopped.
   *
   * @typedef {queryFunc} function
   * @param {PeerId} peer - Peer to query
   * @returns {closerPeers: Array<PeerInfo>, value: Object, pathComplete: bool, queryComplete: bool}
   */

  /**
   * Create a new query. The makePathQuery function is called once per disjoint path, so that per-path
   * variables can be created in that scope. makePathQuery then returns the actual query function (queryFunc) to
   * use when on that path.
   *
   * @param {DHT} dht - DHT instance
   * @param {Buffer} key
   * @param {makePathQuery} makePathQuery - Called to set up each disjoint path. Must return the query function.
   */
  constructor (dht, key, makePathQuery) {
    this.dht = dht
    this.key = key
    this.makePathQuery = makePathQuery
    this._log = utils.logger(this.dht.peerInfo.id, 'query:' + mh.toB58String(key))
    this.running = false
  }

  /**
   * Called when the Query starts.
   */
  _onStart () {
    this.running = true
    this.dht._queryManager.started(this)
    this._log('run:start')
  }

  /**
   * Stop the Query if it is running. This should be called after run() if the
   * Query hasn't completed (eg if the caller only needs a limited number of
   * results) so that the Query doesn't continue traversing the DHT
   * unnecessarily.
   */
  stop () {
    this.run && this.run.stop()

    if (this.running) {
      this.running = false
      this._log('run:complete')
      this.dht._queryManager.stopped(this)
    }
  }

  /**
   * Run result.
   * @typedef {Object} RunResult
   * @property {Array<PeerId>} peersSeen - peers that have been queried so far
   * @property {Object} [value] - a value returned in the value field of the queryFunc
   */

  /**
   * Run this query, start with the given list of peers first.
   *
   * @param {Array<PeerId>} peers
   * @param {number} [timeout] - timeout in ms. If undefined, runs forever.
   * @returns {AsyncIterator<RunResult>}
   */
  async * run (peers, timeout) {
    if (peers.length === 0) {
      this._log.error('Running query with no peers')
      return
    }

    const run = new Run(this.dht, this.key, this.makePathQuery, this._log)
    this.run = run

    const queryErrors = []
    run.on('query error', (err) => queryErrors.push(err))

    try {
      this._onStart()

      let iterator = run.execute(peers)
      if (timeout) {
        const msg = `Query timed out after ${timeout}ms`
        iterator = utils.iterableTimeout(iterator, timeout, msg)
      }

      let resCount = 0
      for await (const res of iterator) {
        resCount++
        yield res
      }

      // Every query failed - something is seriously wrong, so throw an error
      if (queryErrors.length === run.peersSeen.size) {
        throw queryErrors[0]
      }

      // We searched all paths without finding a value or getting a success
      // response, so just yield the peers we saw
      if (resCount === 0 && run.peersSeen.size) {
        yield {
          peersSeen: run.peersSeen.toArray()
        }
      }
    } catch (err) {
      this._log('run:error: %s', err.message)
      throw err
    } finally {
      this.stop()
    }
  }
}

/**
 * Manages a single run of the Query
 */
class Run extends EventEmitter {
  /**
   * Create a new run
   *
   * @param {DHT} dht - DHT instance
   * @param {Buffer} key
   * @param {makePathQuery} makePathQuery
   * @param {Logger} log
   */
  constructor (dht, key, makePathQuery, log) {
    super()

    this.dht = dht
    this.key = key
    this.makePathQuery = makePathQuery
    this._log = log
    this.peersSeen = new PeerIdSet()
    this.paths = []
  }

  /**
   * Stop this run and all running paths.
   */
  stop () {
    for (const path of this.paths) {
      path.stop()
    }
  }

  /**
   * Execute the run with the given initial set of peers.
   *
   * @param {Array<PeerId>} peers
   * @returns {AsyncIterator<RunResult>}
   */
  async * execute (peers) {
    // Create correct number of paths
    const numPaths = Math.min(c.DISJOINT_PATHS, peers.length)
    const pathPeers = []
    for (let i = 0; i < numPaths; i++) {
      pathPeers.push([])
    }

    // Assign peers to paths round-robin style
    peers.forEach((peer, i) => {
      pathPeers[i % numPaths].push(peer)
    })

    // Set up a worker queue for each path
    const workers = await Promise.all(pathPeers.map((peers, i) => {
      const query = this.makePathQuery(i, numPaths)
      const path = new Path(this.dht, this.key, this.peersSeen, peers, query, this._log)
      path.on('query error', (err) => this.emit('query error', err))
      this.paths.push(path)
      return path.workerQueue()
    }))

    // Merge all the worker queues into one Iterator that runs the worker
    // queues in parallel
    let iterator = parallelMerge(...workers)

    for await (const res of iterator) {
      yield {
        peersSeen: this.peersSeen.toArray(),
        value: res.value
      }

      // The result indicates that the Query has completed so stop all paths
      if (res.queryComplete) {
        this.stop()
        return
      }
    }
  }
}

/**
 * Manages a single disjoint path through the DHT.
 */
class Path extends EventEmitter {
  /**
   * Create a new disjoint path through the DHT.
   *
   * @param {DHT} dht - DHT instance
   * @param {Buffer} key
   * @param {PeerIdSet<PeerId>} peersSeen
   * @param {Array<PeerId>} peers
   * @param {queryFunc} query
   * @param {Logger} log
   */
  constructor (dht, key, peersSeen, peers, query, log) {
    super()

    this.key = key
    this.dht = dht
    this.runPeersSeen = peersSeen
    this.peers = peers
    this.query = query
    this.concurrency = c.ALPHA
    this._log = log

    // PeerQueue - queue of peers that will be queried
    this.peersToQuery = null
    this.running = true
  }

  /**
   * Stop traversing the DHT on this disjoint path.
   */
  stop () {
    this.running = false
  }

  /**
   * Create a worker queue for peers on this path.
   *
   * @returns {AsyncIterator<Object>}
   */
  async workerQueue () {
    // Create a queue of peers and fill it up
    this.peersToQuery = await PeerQueue.fromKey(this.key)
    await Promise.all(this.peers.map((p) => this.addPeerToQuery(p)))

    // Create an iterator to process the queue
    return this.createWorkerQueue()
  }

  /**
   * Use the queue to keep `concurrency` amount items running per path.
   * Returns an asynchronous iterator of values returned by the queryFunc.
   *
   * @returns {AsyncIterator<Object>}
   */
  async * createWorkerQueue () {
    const iterator = this.peersToQuery.transform(this.processPeer.bind(this), this.concurrency)

    // Process each peer in the queue
    // Note: During processing we may add more peers to the queue
    for await (const res of iterator) {
      // Make sure we're still running
      if (!this.running) {
        iterator.stop()
        return
      }

      if (res) {
        if (res.value || res.pathComplete || res.queryComplete) {
          // Yield the result. (Note: even if we didn't get a value, we still
          // want to indicate to the caller that something happened)
          yield res
        }

        // If the query function indicates that we're done, stop iterating
        if (res.pathComplete || res.queryComplete) {
          iterator.stop()
          return
        }

        // If there are more peers to query, queue them up
        if ((res.closerPeers || []).length) {
          await this.processCloserPeers(res.closerPeers)

          // Make sure we're still running
          if (!this.running) {
            iterator.stop()
            return
          }
        }
      }
    }
  }

  /**
   * Process the next peer.
   *
   * @param {PeerId} peer
   * @returns {Promise<{value: Object, success: bool}>}
   */
  async processPeer (peer) {
    const peerId = peer.toB58String()
    this._log('path:query to %s', peerId)

    try {
      const start = Date.now()
      const res = await this.query(peer)

      let msg = 'path:query to %s complete in %sms'
      if ((res || {}).success) {
        msg += ' (path query complete)'
      }
      this._log(msg, peerId, Date.now() - start)

      return res
    } catch (err) {
      this._log('path:query to %s error: %s', peerId, err)
      this.emit('query error', err)
    }
  }

  /**
   * Add closer peers to the peers to be queried.
   *
   * @param {Array<PeerId>} closerPeers
   * @returns {Promise}
   */
  async processCloserPeers (closerPeers) {
    const addPeers = closerPeers.map((closer) => {
      // don't add ourselves
      if (this.dht._isSelf(closer.id)) {
        return
      }

      closer = this.dht.peerBook.put(closer)
      this.dht._peerDiscovered(closer)

      return this.addPeerToQuery(closer.id)
    }).filter(Boolean)

    await Promise.all(addPeers)

    this._log('path:added (%d unseen / %d discovered) peers to queue (queue size %d)',
      addPeers.length, closerPeers.length, this.peersToQuery.length)
  }

  /**
   * Add a peer to the peers to be queried.
   *
   * @param {PeerId} peer
   * @returns {Promise}
   */
  addPeerToQuery (peer) {
    if (this.dht._isSelf(peer)) {
      return
    }

    if (this.runPeersSeen.has(peer)) {
      return
    }

    this.runPeersSeen.add(peer)
    return this.peersToQuery.enqueue(peer)
  }
}

module.exports = Query
