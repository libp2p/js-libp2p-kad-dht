'use strict'

const times = require('async/times')
const crypto = require('libp2p-crypto')
const waterfall = require('async/waterfall')
const multihashing = require('multihashing-async')
const PeerId = require('peer-id')
const assert = require('assert')
const c = require('./constants')
const { logger } = require('./utils')
const AbortController = require('abort-controller')

const errcode = require('err-code')

class RandomWalk {
  /**
   * @constructor
   * @param {DHT} dht
   * @param {object} options
   * @param {randomWalkOptions.enabled} options.enabled
   * @param {randomWalkOptions.queriesPerPeriod} options.queriesPerPeriod
   * @param {randomWalkOptions.interval} options.interval
   * @param {randomWalkOptions.timeout} options.timeout
   * @param {randomWalkOptions.delay} options.delay
   * @param {DHT} options.dht
   */
  constructor (dht, options) {
    this._options = { ...c.defaultRandomWalk, ...options }
    assert(dht, 'Random Walk needs an instance of the Kademlia DHT')
    this._runningHandle = null
    this._kadDHT = dht
    this.log = logger(dht.peerInfo.id, 'random-walk')
  }

  /**
   * Start the Random Walk process. This means running a number of queries
   * every interval requesting random data. This is done to keep the dht
   * healthy over time.
   *
   * @returns {void}
   */
  start () {
    // Don't run twice
    if (this._running || !this._options.enabled) { return }

    // Create running handle
    const runningHandle = {
      _onCancel: null,
      _timeoutId: null,
      runPeriodically: (walk, period) => {
        runningHandle._timeoutId = setTimeout(() => {
          runningHandle._timeoutId = null

          walk((nextPeriod) => {
            // Schedule next
            runningHandle.runPeriodically(walk, nextPeriod)
          })
        }, period)
      },
      cancel: () => {
        // Not currently running, can callback immediately
        if (runningHandle._timeoutId) {
          clearTimeout(runningHandle._timeoutId)
          return
        }
        this._controller.abort()
      }
    }

    // Start doing random walks after `this._options.delay`
    runningHandle._timeoutId = setTimeout(() => {
      // Start runner immediately
      runningHandle.runPeriodically((done) => {
        // Each subsequent walk should run on a `this._options.interval` interval
        this._walk(this._options.queriesPerPeriod, this._options.timeout, () => done(this._options.interval))
      }, 0)
    }, this._options.delay)

    this._runningHandle = runningHandle
  }

  /**
   * Stop the random-walk process. Any active
   * queries will be aborted.
   *
   * @returns {void}
   */
  stop () {
    const runningHandle = this._runningHandle

    if (!runningHandle) {
      return
    }

    this._runningHandle = null
    runningHandle.cancel()
  }

  /**
   * Do the random walk work.
   *
   * @param {number} queries
   * @param {number} walkTimeout
   * @param {function(Error)} callback
   * @returns {void}
   *
   * @private
   */
  _walk (queries, walkTimeout, callback) {
    this.log('start')
    this._controller = new AbortController()

    times(queries, (i, next) => {
      this.log('running query %s', i)

      // Perform the walk
      waterfall([
        (cb) => this._randomPeerId(cb),
        (id, cb) => this._query(id, {
          timeout: walkTimeout,
          signal: this._controller.signal
        }, cb)
      ], (err) => {
        if (err && err.code !== 'ETIMEDOUT') {
          this.log.error('query finished with error', err)
          return next(err)
        }

        this.log('finished query')
        next(null)
      })
    }, (err) => {
      if (err) {
        this.log.error(err)
      }

      this.log('finished queries')
      callback(err)
    })
  }

  /**
   * The query run during a random walk request.
   *
   * @param {PeerId} id
   * @param {object} options
   * @param {number} options.timeout
   * @param {function(Error)} callback
   * @returns {void}
   *
   * @private
   */
  _query (id, options, callback) {
    this.log('query:%s', id.toB58String())

    this._kadDHT.findPeer(id, options, (err, peer) => {
      if (err && err.code === 'ERR_NOT_FOUND') {
        // expected case, we asked for random stuff after all
        return callback()
      }
      if (err) {
        return callback(err)
      }
      this.log('query:found', peer)

      // wait what, there was something found? Lucky day!
      callback(errcode(new Error(`random-walk: ACTUALLY FOUND PEER: ${peer}, ${id.toB58String()}`), 'ERR_FOUND_RANDOM_PEER'))
    })
  }

  /**
   * Generate a random peer id for random-walk purposes.
   *
   * @param {function(Error, PeerId)} callback
   * @returns {void}
   *
   * @private
   */
  _randomPeerId (callback) {
    multihashing(crypto.randomBytes(16), 'sha2-256', (err, digest) => {
      if (err) {
        return callback(err)
      }
      callback(null, new PeerId(digest))
    })
  }
}

module.exports = RandomWalk
