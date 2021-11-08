'use strict'

const errcode = require('err-code')
const { equals: uint8ArrayEquals } = require('uint8arrays/equals')
const { toString: uint8ArrayToString } = require('uint8arrays/to-string')
const Libp2pRecord = require('libp2p-record')
const {
  ALPHA
} = require('../constants')
const utils = require('../utils')
const Record = Libp2pRecord.Record
const parallel = require('it-parallel')
const map = require('it-map')
const {
  valueEvent,
  queryErrorEvent
} = require('../query/events')
const { Message } = require('../message')
const { pipe } = require('it-pipe')

const log = utils.logger('libp2p:kad-dht:content-fetching')

/**
 * @typedef {import('peer-id')} PeerId
 * @typedef {import('../types').ValueEvent} ValueEvent
 */

class ContentFetching {
  /**
   * @param {import('peer-id')} peerId
   * @param {import('interface-datastore').Datastore} datastore
   * @param {import('libp2p-interfaces/src/types').DhtValidators} validators
   * @param {import('libp2p-interfaces/src/types').DhtSelectors} selectors
   * @param {import('../peer-routing').PeerRouting} peerRouting
   * @param {import('../query/manager').QueryManager} queryManager
   * @param {import('../routing-table').RoutingTable} routingTable
   * @param {import('../network').Network} network
   */
  constructor (peerId, datastore, validators, selectors, peerRouting, queryManager, routingTable, network) {
    this._peerId = peerId
    this._datastore = datastore
    this._validators = validators
    this._selectors = selectors
    this._peerRouting = peerRouting
    this._queryManager = queryManager
    this._routingTable = routingTable
    this._network = network
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
   * @param {ValueEvent[]} vals - values retrieved from the DHT
   * @param {Uint8Array} best - the best record that was found
   * @param {object} [options]
   * @param {AbortSignal} [options.signal]
   */
  async * sendCorrectionRecord (key, vals, best, options = {}) {
    log('sendCorrection for %b', key)
    const fixupRec = await utils.createPutRecord(key, best)

    for (const { value, from } of vals) {
      // no need to do anything
      if (uint8ArrayEquals(value, best)) {
        log('record was ok')
        continue
      }

      // correct ourself
      if (this._peerId.equals(from)) {
        try {
          const dsKey = utils.bufferToKey(key)
          log(`Storing corrected record for key ${dsKey}`)
          await this._datastore.put(dsKey, fixupRec)
        } catch (/** @type {any} */ err) {
          log.error('Failed error correcting self', err)
        }

        continue
      }

      // send correction
      let sentCorrection = false
      const request = new Message(Message.TYPES.PUT_VALUE, key, 0)
      request.record = Record.deserialize(fixupRec)

      for await (const event of this._network.sendRequest(from, request, options)) {
        if (event.name === 'peerResponse' && event.record && uint8ArrayEquals(event.record.value, Record.deserialize(fixupRec).value)) {
          sentCorrection = true
        }

        yield event
      }

      if (!sentCorrection) {
        yield queryErrorEvent({ from, error: errcode(new Error('value not put correctly'), 'ERR_PUT_VALUE_INVALID') })
      }

      log.error('Failed error correcting entry')
    }
  }

  /**
   * Store the given key/value  pair in the DHT.
   *
   * @param {Uint8Array} key
   * @param {Uint8Array} value
   * @param {object} [options] - put options
   * @param {number} [options.minPeers] - minimum number of peers required to successfully put (default: closestPeers.length)
   * @param {AbortSignal} [options.signal]
   */
  async * put (key, value, options = {}) {
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

    yield * pipe(
      this._peerRouting.getClosestPeers(key, { signal: options.signal }),
      (source) => map(source, (event) => {
        return async () => {
          if (event.name !== 'finalPeer') {
            return [event]
          }

          counterAll += 1
          const events = []

          const msg = new Message(Message.TYPES.PUT_VALUE, key, 0)
          msg.record = Record.deserialize(record)

          for await (const putEvent of this._network.sendRequest(event.peer.id, msg, options)) {
            events.push(putEvent)

            if (putEvent.name === 'peerResponse' && putEvent.record && uint8ArrayEquals(putEvent.record.value, Record.deserialize(record).value)) {
              counterSuccess += 1
              events.push(putEvent)
            } else {
              events.push(queryErrorEvent({ from: event.peer.id, error: errcode(new Error('value not put correctly'), 'ERR_PUT_VALUE_INVALID') }))
            }
          }

          return events
        }
      }),
      (source) => parallel(source, {
        ordered: false,
        concurrency: ALPHA
      }),
      async function * (source) {
        for await (const events of source) {
          yield * events
        }
      }
    )

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
  async * get (key, options = {}) {
    log('get %b', key)

    /** @type {ValueEvent[]} */
    const vals = []

    for await (const event of this.getMany(key, options)) {
      if (event.name === 'value') {
        vals.push(event)
      }

      yield event
    }

    const records = vals.map((v) => v.value)
    let i = 0

    try {
      i = Libp2pRecord.selection.bestRecord(this._selectors, key, records)
    } catch (/** @type {any} */ err) {
      // Assume the first record if no selector available
      if (err.code !== 'ERR_NO_SELECTOR_FUNCTION_FOR_RECORD_KEY') {
        throw err
      }
    }

    const best = records[i]
    log('GetValue %b %s', key, best)

    if (!best) {
      throw errcode(new Error('best value was not found'), 'ERR_NOT_FOUND')
    }

    yield * this.sendCorrectionRecord(key, vals, best, options)

    yield vals[i]
  }

  /**
   * Get the `n` values to the given key without sorting.
   *
   * @param {Uint8Array} key
   * @param {object} [options]
   * @param {AbortSignal} [options.signal]
   * @param {number} [options.queryFuncTimeout]
   */
  async * getMany (key, options = {}) {
    log('getMany values for %b', key)

    let foundValue = false
    let localRec

    try {
      localRec = await this.getLocal(key)

      foundValue = true

      yield valueEvent({
        value: localRec.value,
        from: this._peerId
      })
    } catch (/** @type {any} */ err) {
      log('error getting local value for %b', key)
    }

    const id = await utils.convertBuffer(key)
    const rtp = this._routingTable.closestPeers(id)

    log('found %d peers in routing table', rtp.length)

    if (rtp.length === 0) {
      const errMsg = 'Failed to lookup key! No peers from routing table!'
      log.error(errMsg)

      if (!foundValue) {
        throw errcode(new Error(errMsg), 'ERR_NO_PEERS_IN_ROUTING_TABLE')
      }

      return
    }

    const self = this

    /**
     * @type {import('../query/types').QueryFunc}
     */
    const getValueQuery = async function * ({ peer, signal }) {
      for await (const event of self._peerRouting.getValueOrPeers(peer, key, { signal })) {
        yield event

        if (event.name === 'peerResponse' && event.record) {
          yield valueEvent({ from: peer, value: event.record.value })
        }
      }
    }

    // we have peers, lets send the actual query to them
    let err

    for await (const event of this._queryManager.run(key, rtp, getValueQuery, options)) {
      yield event

      if (event.name === 'value') {
        foundValue = true
      }

      if (event.name === 'queryError') {
        err = event.error
      }
    }

    // if we didn't find any values but had errors, propagate the last error
    if (!foundValue && err) {
      throw err
    }
  }
}

module.exports.ContentFetching = ContentFetching
