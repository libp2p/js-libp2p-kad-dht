'use strict'

const { Message } = require('../../message')
const utils = require('../../utils')
const log = utils.logger('libp2p:kad-dht:rpc:handlers:find-node')

/**
 * @typedef {import('peer-id')} PeerId
 * @typedef {import('../../types').DHTMessageHandler} DHTMessageHandler
 */

/**
 * @implements {DHTMessageHandler}
 */
class FindNodeHandler {
  /**
   * @param {PeerId} peerId
   * @param {import('../../types').Addressable} addressable
   * @param {import('../../peer-routing').PeerRouting} peerRouting
   */
  constructor (peerId, addressable, peerRouting) {
    this._peerId = peerId
    this._addressable = addressable
    this._peerRouting = peerRouting
  }

  /**
   * Process `FindNode` DHT messages.
   *
   * @param {PeerId} peerId
   * @param {Message} msg
   */
  async handle (peerId, msg) {
    log('start')

    let closer
    if (this._peerId.equals(msg.key)) {
      closer = [{
        id: this._peerId,
        multiaddrs: this._addressable.multiaddrs
      }]
    } else {
      closer = await this._peerRouting.getCloserPeersOffline(msg.key, peerId)
    }

    const response = new Message(msg.type, new Uint8Array(0), msg.clusterLevel)

    if (closer.length > 0) {
      response.closerPeers = closer
    } else {
      log('handle FindNode %s: could not find anything', peerId.toB58String())
    }

    return response
  }
}

module.exports.FindNodeHandler = FindNodeHandler
