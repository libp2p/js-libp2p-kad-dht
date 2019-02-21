'use strict'

const crypto = require('libp2p-crypto')
const multihashing = require('multihashing-async')
const PeerId = require('peer-id')
const assert = require('assert')
const c = require('./constants')
const utils = require('./utils')

const errcode = require('err-code')

class RandomWalk {
  constructor (kadDHT) {
    assert(kadDHT, 'Random Walk needs an instance of the Kademlia DHT')
    this._runningHandle = null
    this._kadDHT = kadDHT
  }

  /**
   * Start the Random Walk process. This means running a number of queries
   * every interval requesting random data. This is done to keep the dht
   * healthy over time.
   *
   * @param {number} [queries=1] - how many queries to run per period
   * @param {number} [period=300000] - how often to run the the random-walk process, in milliseconds (5min)
   * @param {number} [timeout=10000] - how long to wait for the the random-walk query to run, in milliseconds (10s)
   * @returns {undefined}
   */
  start (queries = c.defaultRandomWalk.queriesPerPeriod, period = c.defaultRandomWalk.interval, timeout = c.defaultRandomWalk.timeout) {
    // Don't run twice
    if (this._runningHandle) { return }

    // Create running handle
    const runningHandle = {
      _onCancel: null,
      _timeoutId: null,
      runPeriodically: () => {
        runningHandle._timeoutId = setTimeout(async () => {
          runningHandle._timeoutId = null

          await this._walk(queries, timeout)

          // Was walk cancelled while fn was being called?
          if (runningHandle._onCancel) {
            return runningHandle._onCancel()
          }

          // Schedule next
          runningHandle.runPeriodically()
        }, period)
      },
      cancel: () => {
        // Not currently running, can return immediately
        if (runningHandle._timeoutId) {
          clearTimeout(runningHandle._timeoutId)
          return
        }
        // Wait to finish and then call callback
        return new Promise((resolve) => {
          runningHandle._onCancel = resolve
        })
      }
    }

    // Start runner
    runningHandle.runPeriodically()
    this._runningHandle = runningHandle
  }

  /**
   * Stop the random-walk process.
   *
   * @returns {Promise}
   */
  stop () {
    const runningHandle = this._runningHandle

    if (runningHandle) {
      this._runningHandle = null
      return runningHandle.cancel()
    }
  }

  /**
   * Do the random walk work.
   *
   * @param {number} queries
   * @param {number} walkTimeout
   * @returns {Promise}
   *
   * @private
   */
  async _walk (queries, walkTimeout) {
    this._kadDHT._log('random-walk:start')

    for (let i = 0; i < queries && this._runningHandle; i++) {
      try {
        const id = await this._randomPeerId()
        await utils.promiseTimeout(
          this._query(id),
          walkTimeout,
          `Random walk for id ${id} timed out in ${walkTimeout}ms`
        )
      } catch (err) {
        this._kadDHT._log.error('random-walk:error', err)
        throw err
      }
      this._kadDHT._log('random-walk:done')
    }
  }

  /**
   * The query run during a random walk request.
   *
   * @param {PeerId} id
   * @returns {Promise}
   *
   * @private
   */
  async _query (id) {
    this._kadDHT._log('random-walk:query:%s', id.toB58String())

    let peer
    try {
      peer = await this._kadDHT.findPeer(id)
    } catch (err) {
      // expected case, we asked for random stuff after all
      if (err.code === 'ERR_NOT_FOUND') {
        return
      }
      throw err
    }

    this._kadDHT._log('random-walk:query:found', null, peer)

    // wait what, there was something found? Lucky day!
    throw errcode(`random-walk: ACTUALLY FOUND PEER: ${peer}, ${id.toB58String()}`, 'ERR_FOUND_RANDOM_PEER')
  }

  /**
   * Generate a random peer id for random-walk purposes.
   *
   * @returns {Promise<PeerId>}
   *
   * @private
   */
  async _randomPeerId () {
    const digest = await multihashing(crypto.randomBytes(16), 'sha2-256')
    return new PeerId(digest)
  }
}

module.exports = RandomWalk
