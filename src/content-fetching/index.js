'use strict'

const errcode = require('err-code')
const { equals: uint8ArrayEquals } = require('uint8arrays/equals')
const { toString: uint8ArrayToString } = require('uint8arrays/to-string')
const Libp2pRecord = require('libp2p-record')
const all = require('it-all')
const {
  GET_MANY_RECORD_COUNT
} = require('../constants')
const utils = require('../utils')
const Record = Libp2pRecord.Record
const drain = require('it-drain')
const parallel = require('it-parallel')
const map = require('it-map')

const log = utils.logger('libp2p:kad-dht:content-fetching')

/**
 * @typedef {import('peer-id')} PeerId
 * @typedef {import('../types').PeerData} PeerData
 *
 * @typedef {object} ContentFetchValue
 * @property {PeerData} peer
 * @property {Uint8Array} value
 */

class ContentFetching {
  /**
   * @param {import('peer-id')} peerId
   * @param {import('interface-datastore').Datastore} datastore
   * @param {import('libp2p-interfaces/src/types').DhtValidators} validators
   * @param {import('libp2p-interfaces/src/types').DhtSelectors} selectors
   * @param {import('../peer-routing').PeerRouting} peerRouting
   * @param {import('../query-manager').QueryManager} queryManager
   * @param {import('../routing-table').RoutingTable} routingTable
   */
  constructor (peerId, datastore, validators, selectors, peerRouting, queryManager, routingTable) {
    this._peerId = peerId
    this._datastore = datastore
    this._validators = validators
    this._selectors = selectors
    this._peerRouting = peerRouting
    this._queryManager = queryManager
    this._routingTable = routingTable
  }

  /**
   * @param {Uint8Array} key
   * @param {Uint8Array} rec
   */
  async putLocal (key, rec) { // eslint-disable-line require-await
    return this._datastore.put(utils.bufferToKey(key), rec)
  }

  /**
   * Attempt to retrieve the value for the given key from
   * the local datastore.
   *
   * @param {Uint8Array} key
   */
  async getLocal (key) {
    log(`getLocal ${uint8ArrayToString(key, 'base32')}`)

    const raw = await this._datastore.get(utils.bufferToKey(key))
    log(`found ${uint8ArrayToString(key, 'base32')} in local datastore`)

    const rec = Record.deserialize(raw)

    await Libp2pRecord.validator.verifyRecord(this._validators, rec)

    return rec
  }

  /**
   * Send the best record found to any peers that have an out of date record.
   *
   * @param {Uint8Array} key
   * @param {import('../types').DHTValue[]} vals - values retrieved from the DHT
   * @param {Uint8Array} best - the best record that was found
   * @param {AbortSignal} signal
   */
  async sendCorrectionRecord (key, vals, best, signal) {
    const fixupRec = await utils.createPutRecord(key, best)

    return Promise.all(
      vals.map(async (v) => {
        // no need to do anything
        if (uint8ArrayEquals(v.val, best)) {
          return
        }

        // correct ourself
        if (this._peerId.equals(v.from)) {
          try {
            const dsKey = utils.bufferToKey(key)
            log(`Storing corrected record for key ${dsKey}`)
            await this._datastore.put(dsKey, fixupRec)
          } catch (/** @type {any} */ err) {
            log.error('Failed error correcting self', err)
          }

          return
        }

        // send correction
        try {
          await this._peerRouting.putValueToPeer(key, fixupRec, v.from, signal)
        } catch (/** @type {any} */ err) {
          log.error('Failed error correcting entry', err)
        }
      })
    )
  }

  /**
   * Store the given key/value  pair in the DHT.
   *
   * @param {Uint8Array} key
   * @param {Uint8Array} value
   * @param {AbortSignal} signal
   * @param {object} [options] - put options
   * @param {number} [options.minPeers] - minimum number of peers required to successfully put (default: closestPeers.length)
   */
  async put (key, value, signal, options = {}) {
    log('PutValue %b', key)

    // create record in the dht format
    const record = await utils.createPutRecord(key, value)

    // store the record locally
    const dsKey = utils.bufferToKey(key)
    log(`Storing record for key ${dsKey}`)
    await this._datastore.put(dsKey, record)

    // put record to the closest peers
    let counterAll = 0
    let counterSuccess = 0

    await drain(parallel(map(this._peerRouting.getClosestPeers(key, signal, { shallow: true }), (peer) => {
      return async () => {
        try {
          counterAll += 1
          await this._peerRouting.putValueToPeer(key, record, peer, signal)
          counterSuccess += 1
        } catch (/** @type {any} */ err) {
          log.error('Failed to put to peer (%b): %s', peer.id, err)
        }
      }
    })))

    // verify if we were able to put to enough peers
    const minPeers = options.minPeers || counterAll // Ensure we have a default `minPeers`

    if (minPeers > counterSuccess) {
      const error = errcode(new Error(`Failed to put value to enough peers: ${counterSuccess}/${minPeers}`), 'ERR_NOT_ENOUGH_PUT_PEERS')
      log.error(error)
      throw error
    }
  }

  /**
   * Get the value to the given key.
   * Times out after 1 minute by default.
   *
   * @param {Uint8Array} key
   * @param {AbortSignal} signal
   */
  async get (key, signal) {
    log('_get %b', key)

    const vals = await all(this.getMany(key, GET_MANY_RECORD_COUNT, signal))
    const recs = vals.map((v) => v.val)
    let i = 0

    try {
      i = Libp2pRecord.selection.bestRecord(this._selectors, key, recs)
    } catch (/** @type {any} */ err) {
      // Assume the first record if no selector available
      if (err.code !== 'ERR_NO_SELECTOR_FUNCTION_FOR_RECORD_KEY') {
        throw err
      }
    }

    const best = recs[i]
    log('GetValue %b %s', key, best)

    if (!best) {
      throw errcode(new Error('best value was not found'), 'ERR_NOT_FOUND')
    }

    await this.sendCorrectionRecord(key, vals, best, signal)

    return best
  }

  /**
   * Get the `n` values to the given key without sorting.
   *
   * @param {Uint8Array} key
   * @param {number} nvals
   * @param {AbortSignal} signal
   */
  async * getMany (key, nvals, signal) {
    log('getMany %b (%s)', key, nvals)

    const vals = []
    let localRec

    try {
      localRec = await this.getLocal(key)
    } catch (/** @type {any} */ err) {
      if (nvals === 0) {
        throw err
      }
    }

    if (localRec) {
      vals.push({
        val: localRec.value,
        from: this._peerId
      })
    }

    if (vals.length >= nvals) {
      yield * vals
      return
    }

    const id = await utils.convertBuffer(key)
    const rtp = this._routingTable.closestPeers(id)

    log('peers in rt: %d', rtp.length)

    if (rtp.length === 0) {
      const errMsg = 'Failed to lookup key! No peers from routing table!'

      log.error(errMsg)
      if (vals.length === 0) {
        throw errcode(new Error(errMsg), 'ERR_NO_PEERS_IN_ROUTING_TABLE')
      }

      yield * vals
      return
    }

    const valsLength = vals.length

    /**
     * @type {import('../types').MakeQueryFunc<ContentFetchValue>}
     */
    const createQuery = (pathIndex, numPaths) => {
      // This function body runs once per disjoint path
      const pathSize = utils.pathSize(nvals - valsLength, numPaths)
      let queryResults = 0

      /**
       * Here we return the query function to use on this particular disjoint path
       *
       * @type {import('../types').QueryFunc<ContentFetchValue>}
       */
      const query = async (peer, signal) => {
        let rec, peers, lookupErr
        try {
          const results = await this._peerRouting.getValueOrPeers(peer, key, signal)
          rec = results.record
          peers = results.peers
        } catch (/** @type {any} */ err) {
          // If we have an invalid record we just want to continue and fetch a new one.
          if (err.code !== 'ERR_INVALID_RECORD') {
            throw err
          }

          lookupErr = err
        }

        // there was an error getting the value or peers
        if (lookupErr) {
          queryResults++

          return {
            done: false,
            err: lookupErr
          }
        }

        // didn't get a value, continue looking
        if (!rec) {
          return {
            done: false,
            closerPeers: peers
          }
        }

        queryResults++

        // got enough values, all done
        if (queryResults >= pathSize) {
          return {
            done: true,
            value: {
              peer: { id: peer, multiaddrs: [] },
              value: rec.value
            }
          }
        }

        // not got enough values, continue looking
        return {
          done: false,
          closerPeers: peers,
          value: {
            peer: { id: peer, multiaddrs: [] },
            value: rec.value
          }
        }
      }

      return query
    }

    // we have peers, lets send the actual query to them
    let yielded = false

    try {
      let err

      for await (const res of this._queryManager.run(key, rtp, createQuery, signal)) {
        if (res.done && res.value) {
          yield {
            val: res.value.value,
            from: res.value.peer.id
          }
          yielded = true
        }

        if (res.err) {
          log.error(err)
          err = res.err
        }
      }

      // if we didn't find any values but had errors, propagate the last error
      if (!yielded && err) {
        throw err
      }
    } catch (/** @type {any} */ err) {
      if (!yielded) {
        throw err
      }
    }
  }
}

module.exports.ContentFetching = ContentFetching
