'use strict'

const PeerDistanceList = require('../peer-distance-list')
const EventEmitter = require('events')
const each = require('async/each')
const promisify = require('promisify-es6')
const promiseToCallback = require('promise-to-callback')

const Path = require('./path')
const WorkerQueue = require('./workerQueue')
const utils = require('../utils')

/**
 * Manages a single run of the query.
 */
class Run extends EventEmitter {
  /**
   * Creates a Run.
   *
   * @param {Query} query
   */
  constructor (query) {
    super()

    this.query = query

    this.running = false
    this.workers = []

    // The peers that have been queried (including error responses)
    this.peersSeen = new Set()
    // The errors received when querying peers
    this.errors = []
    // The closest K peers that have been queried successfully
    // (this member is initialized when the worker queues start)
    this.peersQueried = null
  }

  /**
   * Stop all the workers
   */
  stop () {
    if (!this.running) {
      return
    }

    this.running = false
    for (const worker of this.workers) {
      worker.stop()
    }
  }

  /**
   * Execute the run with the given initial set of peers.
   *
   * @param {Array<PeerId>} peers
   * @param {function(Error, Object)} callback
   */
  execute (peers, callback) {
    promiseToCallback(this._executeAsync(peers))(callback)
  }

  async _executeAsync (peers) {
    const paths = [] // array of states per disjoint path

    // Create disjoint paths
    const numPaths = Math.min(this.query.dht.disjointPaths, peers.length)
    for (let i = 0; i < numPaths; i++) {
      paths.push(new Path(this, this.query.makePath(i, numPaths)))
    }

    // Assign peers to paths round-robin style
    peers.forEach((peer, i) => {
      paths[i % numPaths].addInitialPeer(peer)
    })

    // Execute the query along each disjoint path
    await this._executePathsAsync(paths)

    const res = {
      // The closest K peers we were able to query successfully
      finalSet: new Set(this.peersQueried.peers),
      paths: []
    }

    // Collect the results from each completed path
    for (const path of paths) {
      if (path.res && (path.res.pathComplete || path.res.queryComplete)) {
        path.res.success = true
        res.paths.push(path.res)
      }
    }

    return res
  }

  /**
   * Execute all paths through the DHT.
   *
   * @param {Array<Path>} paths
   * @param {function(Error)} callback
   */
  executePaths (paths, callback) {
    promiseToCallback(this._executePathsAsync(paths))(callback)
  }

  async _executePathsAsync (paths) {
    this.running = true

    this.emit('start')
    try {
      await promisify(callback => each(paths, (path, cb) => path.execute(cb), callback))()
    } finally {
      // Ensure all workers are stopped
      this.stop()
      // Completed the Run
      this.emit('complete')
    }

    // If all queries errored out, something is seriously wrong, so callback
    // with an error
    if (this.errors.length === this.peersSeen.size) {
      throw this.errors[0]
    }
  }

  /**
   * Initialize the list of queried peers, then start a worker queue for the
   * given path.
   *
   * @param {Path} path
   * @param {function(Error)} callback
   */
  workerQueue (path, callback) {
    promiseToCallback(this._workerQueueAsync(path))(callback)
  }

  async _workerQueueAsync (path) {
    await this._initAsync()
    await this._startWorkerAsync(path)
  }

  /**
   * Create and start a worker queue for a particular path.
   *
   * @param {Path} path
   * @param {function(Error)} callback
   */
  startWorker (path, callback) {
    promiseToCallback(this._startWorkerAsync(path))(callback)
  }

  async _startWorkerAsync (path) {
    const worker = new WorkerQueue(this.query.dht, this, path, this.query._log)
    this.workers.push(worker)
    return promisify(cb => worker.execute(cb))()
  }

  /**
   * Initialize the list of closest peers we've queried - this is shared by all
   * paths in the run.
   *
   * @param {function(Error)} callback
   * @returns {void}
   */
  init (callback) {
    promiseToCallback(this._initAsync())(callback)
  }

  async _initAsync () {
    if (this.peersQueried) {
      return
    }

    // We only want to initialize the PeerDistanceList once for the run
    if (this.peersQueriedPromise) {
      await this.peersQueriedPromise
      return
    }

    // This promise is temporarily stored so that others may await its completion
    this.peersQueriedPromise = (async () => {
      const dhtKey = await promisify(cb => utils.convertBuffer(this.query.key, cb))()
      this.peersQueried = new PeerDistanceList(dhtKey, this.query.dht.kBucketSize)
    })()

    // After PeerDistanceList is initialized, clean up
    await this.peersQueriedPromise
    delete this.peersQueriedPromise
  }

  /**
   * If we've queried K peers, and the remaining peers in the given `worker`'s queue
   * are all further from the key than the peers we've already queried, then we should
   * stop querying on that `worker`.
   *
   * @param {WorkerQueue} worker
   * @param {function(Error, boolean)} callback
   * @returns {void}
   */
  continueQuerying (worker, callback) {
    promiseToCallback(this._continueQueryingAsync(worker))(callback)
  }

  async _continueQueryingAsync (worker) {
    // If we haven't queried K peers yet, keep going
    if (this.peersQueried.length < this.peersQueried.capacity) {
      return true
    }

    // Get all the peers that are currently being queried.
    // Note that this function gets called right after a peer has been popped
    // off the head of the closest peers queue so it will include that peer.
    const running = worker.queue.workersList().map(i => i.data)

    // Check if any of the peers that are currently being queried are closer
    // to the key than the peers we've already queried
    const someCloser = await promisify(cb => this.peersQueried.anyCloser(running, cb))()

    // Some are closer, the worker should keep going
    if (someCloser) {
      return true
    }

    // None are closer, the worker can stop
    return false
  }
}

module.exports = Run
