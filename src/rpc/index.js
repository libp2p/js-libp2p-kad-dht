'use strict'

const { pipe } = require('it-pipe')
const lp = require('it-length-prefixed')

const { Message } = require('../message')
const handlers = require('./handlers')
const utils = require('../utils')

const log = utils.logger('libp2p:kad-dht:rpc')

/**
 * @typedef {import('peer-id')} PeerId
 * @typedef {import('libp2p-interfaces/src/stream-muxer/types').MuxedStream} MuxedStream
 */

/**
 * @param {import('../types').DHT} dht
 */
class RPC {
  /**
   *
   * @param {import('../routing-table').RoutingTable} routingTable
   * @param {import('peer-id')} peerId
   * @param {import('../providers').Providers} providers
   * @param {import('../types').PeerStore} peerStore
   * @param {import('../types').Addressable} addressable
   * @param {import('../peer-routing').PeerRouting} peerRouting
   * @param {import('interface-datastore').Datastore} datastore
   * @param {import('libp2p-interfaces/src/types').DhtValidators} validators
   */
  constructor (routingTable, peerId, providers, peerStore, addressable, peerRouting, datastore, validators) {
    this._messageHandler = handlers(peerId, providers, peerStore, addressable, peerRouting, datastore, validators)
    this._routingTable = routingTable
  }

  /**
   * Process incoming DHT messages.
   *
   * @param {PeerId} peerId
   * @param {Message} msg
   */
  async handleMessage (peerId, msg) {
    // get handler & execute it
    const handler = this._messageHandler(msg.type)

    try {
      await this._routingTable.add(peerId)
    } catch (/** @type {any} */ err) {
      log.error('Failed to update the kbucket store', err)
    }

    if (!handler) {
      log.error(`no handler found for message type: ${msg.type}`)
      return
    }

    return handler.handle(peerId, msg)
  }

  /**
   * Handle incoming streams on the dht protocol
   *
   * @param {object} props
   * @param {MuxedStream} props.stream
   * @param {import('libp2p-interfaces/src/connection').Connection} props.connection
   */
  async onIncomingStream ({ stream, connection }) {
    const peerId = connection.remotePeer

    try {
      await this._routingTable.add(peerId)
    } catch (/** @type {any} */ err) {
      log.error(err)
    }

    const idB58Str = peerId.toB58String()
    log('from: %s', idB58Str)
    const self = this

    await pipe(
      stream.source,
      lp.decode(),
      /**
       * @param {AsyncIterable<Uint8Array>} source
       */
      source => (async function * () {
        for await (const msg of source) {
          // handle the message
          const desMessage = Message.deserialize(msg.slice())
          const res = await self.handleMessage(peerId, desMessage)

          // Not all handlers will return a response
          if (res) {
            yield res.serialize()
          }
        }
      })(),
      lp.encode(),
      stream.sink
    )
  }
}

module.exports.RPC = RPC
