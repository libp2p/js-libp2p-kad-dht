'use strict'

const errcode = require('err-code')
const { equals: uint8ArrayEquals } = require('uint8arrays/equals')
const { toString: uint8ArrayToString } = require('uint8arrays/to-string')
const Libp2pRecord = require('libp2p-record')
const all = require('it-all')
const {
  GET_MANY_RECORD_COUNT,
  ALPHA
} = require('../constants')
const utils = require('../utils')
const Record = Libp2pRecord.Record
const drain = require('it-drain')
const parallel = require('it-parallel')
const map = require('it-map')

const log = utils.logger('libp2p:kad-dht:content-fetching')

/**
 * @typedef {import('peer-id')} PeerId
 * @typedef {import('../types').QueryEventHandler} QueryEventHandler
 * @typedef {object} ContentFetchValue
 * @property {PeerId} from
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
   * @param {object} [options]
   * @param {AbortSignal} [options.signal]
   * @param {QueryEventHandler} [options.onQueryEvent]
   */
  async sendCorrectionRecord (key, vals, best, options = {}) {
    log('sendCorrection for %b', key)
    const fixupRec = await utils.createPutRecord(key, best)

    return Promise.all(
      vals.map(async (v) => {
        // no need to do anything
        if (uint8ArrayEquals(v.value, best)) {
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
          await this._peerRouting.putValueToPeer(key, fixupRec, v.from, options)
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
   * @param {object} [options] - put options
   * @param {number} [options.minPeers] - minimum number of peers required to successfully put (default: closestPeers.length)
   * @param {AbortSignal} [options.signal]
   * @param {QueryEventHandler} [options.onQueryEvent]
   */
  async put (key, value, options = {}) {
    log('put value %b', key)

    // create record in the dht format
    const record = await utils.createPutRecord(key, value)

    // store the record locally
    const dsKey = utils.bufferToKey(key)
    log(`storing record for key ${dsKey}`)
    await this._datastore.put(dsKey, record)

    // put record to the closest peers
    let counterAll = 0
    let counterSuccess = 0

    await drain(parallel(map(this._peerRouting.getClosestPeers(key, { signal: options.signal, shallow: true }), (peer) => {
      return async () => {
        try {
          counterAll += 1
          await this._peerRouting.putValueToPeer(key, record, peer, options)
          counterSuccess += 1
        } catch (/** @type {any} */ err) {
          log.error('failed to put to peer (%b): %s', peer.id, err)
        }
      }
    }), {
      ordered: false,
      concurrency: ALPHA
    }))

    // verify if we were able to put to enough peers
    const minPeers = options.minPeers || counterAll // Ensure we have a default `minPeers`

    if (minPeers > counterSuccess) {
      const error = errcode(new Error(`Failed to put value to enough peers: ${counterSuccess}/${minPeers}`), 'ERR_NOT_ENOUGH_PUT_PEERS')
      log.error(error)
      throw error
    }
  }

  /**
   * Get the value to the given key
   *
   * @param {Uint8Array} key
   * @param {object} [options]
   * @param {AbortSignal} [options.signal]
   * @param {number} [options.queryFuncTimeout]
   */
  async get (key, options = {}) {
    log('get %b', key)

    const vals = await all(this.getMany(key, GET_MANY_RECORD_COUNT, options))
    const recs = vals.map((v) => v.value)
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

    await this.sendCorrectionRecord(key, vals, best, options)

    return best
  }

  /**
   * Get the `n` values to the given key without sorting.
   *
   * @param {Uint8Array} key
   * @param {number} nvals
   * @param {object} [options]
   * @param {AbortSignal} [options.signal]
   * @param {number} [options.queryFuncTimeout]
   */
  async * getMany (key, nvals, options = {}) {
    log('getMany want %s values for %b', nvals, key)

    let yielded = 0
    let localRec

    try {
      localRec = await this.getLocal(key)
    } catch (/** @type {any} */ err) {
      if (nvals === 0) {
        throw err
      }
    }

    if (localRec) {
      yielded++

      yield {
        value: localRec.value,
        from: this._peerId
      }

      if (nvals === 1) {
        return
      }
    }

    const id = await utils.convertBuffer(key)
    const rtp = this._routingTable.closestPeers(id)

    log('found %d peers in routing table', rtp.length)

    if (rtp.length === 0) {
      const errMsg = 'Failed to lookup key! No peers from routing table!'
      log.error(errMsg)

      if (yielded === 0) {
        throw errcode(new Error(errMsg), 'ERR_NO_PEERS_IN_ROUTING_TABLE')
      }

      return
    }

    const valsLength = yielded
    let queryResults = 0

    /**
     * @type {import('../types').QueryFunc<ContentFetchValue>}
     */
    const getValueQuery = async ({ peer, signal, numPaths }) => {
      const resultsWanted = utils.pathSize(nvals - valsLength, numPaths)

      let rec, peers, lookupErr
      try {
        const results = await this._peerRouting.getValueOrPeers(peer, key, { signal })
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
          closerPeers: [],
          err: lookupErr
        }
      }

      // didn't get a value, continue looking
      if (!rec) {
        return {
          closerPeers: (peers || []).map(peerData => peerData.id)
        }
      }

      queryResults++

      // got enough values, all done
      if (queryResults >= resultsWanted) {
        return {
          done: true,
          value: {
            from: peer,
            value: rec.value
          }
        }
      }

      // not got enough values, continue looking
      return {
        closerPeers: (peers || []).map(peerData => peerData.id),
        value: {
          from: peer,
          value: rec.value
        }
      }
    }

    // we have peers, lets send the actual query to them
    try {
      let err

      for await (const res of this._queryManager.run(key, rtp, getValueQuery, options)) {
        if (res.value) {
          yield res.value
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
