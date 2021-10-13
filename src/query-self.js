'use strict'

const { EventEmitter } = require('events')
const take = require('it-take')
const length = require('it-length')
const { QUERY_SELF_INTERVAL } = require('./constants')
const { logger } = require('./utils')
const log = logger('libp2p:kad-dht:query-self')

/**
 * Receives notifications of new peers joining the network that support the DHT protocol
 */
class QuerySelf extends EventEmitter {
  /**
   * Create a new network
   *
   * @param {import('peer-id')} peerId
   * @param {import('./peer-routing').PeerRouting} peerRouting
   * @param {number} count - how many peers to find
   * @param {number} interval - how often to find them
   */
  constructor (peerId, peerRouting, count, interval = QUERY_SELF_INTERVAL) {
    super()

    this._running = false
    this._peerId = peerId
    this._peerRouting = peerRouting
    this._count = count
    this._interval = interval
  }

  /**
   * Start the network
   */
  start () {
    if (this._running) {
      return
    }

    this._running = true
    this._querySelf()
  }

  /**
   * Stop all network activity
   */
  stop () {
    this._running = false

    if (this._timeoutId) {
      clearTimeout(this._timeoutId)
    }

    if (this._controller) {
      this._controller.abort()
    }
  }

  async _querySelf () {
    try {
      this._controller = new AbortController()

      const found = await length(await take(this._peerRouting.getClosestPeers(this._peerId.toBytes(), {
        signal: this._controller.signal
      }), this._count))

      log('query ran successfully - found %d peers', found)
    } catch (err) {
      log('query error', err)
    } finally {
      this._timeoutId = setTimeout(this._querySelf.bind(this), this._interval)
    }
  }
}

module.exports.QuerySelf = QuerySelf
