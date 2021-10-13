'use strict'

const { CID } = require('multiformats/cid')
const errcode = require('err-code')
const { Message } = require('../../message')
const utils = require('../../utils')
const log = utils.logger('libp2p:kad-dht:rpc:handlers:get-providers')

/**
 * @typedef {import('peer-id')} PeerId
 * @typedef {import('../../types').DHTMessageHandler} DHTMessageHandler
 */

/**
 * @implements {DHTMessageHandler}
 */
class GetProvidersHandler {
  /**
   * @param {PeerId} peerId
   * @param {import('../../peer-routing').PeerRouting} peerRouting
   * @param {import('../../providers').Providers} providers
   * @param {import('interface-datastore').Datastore} datastore
   * @param {import('../../types').PeerStore} peerStore
   */
  constructor (peerId, peerRouting, providers, datastore, peerStore) {
    this._peerId = peerId
    this._peerRouting = peerRouting
    this._providers = providers
    this._datastore = datastore
    this._peerStore = peerStore
  }

  /**
   * Process `GetProviders` DHT messages.
   *
   * @param {PeerId} peerId
   * @param {Message} msg
   */
  async handle (peerId, msg) {
    let cid
    try {
      cid = CID.decode(msg.key)
    } catch (/** @type {any} */ err) {
      throw errcode(new Error(`Invalid CID: ${err.message}`), 'ERR_INVALID_CID')
    }

    log('%p asking for providers for %s', peerId, cid.toString())
    const dsKey = utils.bufferToKey(cid.bytes)

    const [has, peers, closer] = await Promise.all([
      this._datastore.has(dsKey),
      this._providers.getProviders(cid),
      this._peerRouting.getCloserPeersOffline(msg.key, peerId)
    ])

    const providerPeers = peers.map((peerId) => ({
      id: peerId,
      multiaddrs: []
    }))
    const closerPeers = closer.map((c) => ({
      id: c.id,
      multiaddrs: []
    }))

    if (has) {
      providerPeers.push({
        id: this._peerId,
        multiaddrs: []
      })
    }

    const response = new Message(msg.type, msg.key, msg.clusterLevel)

    if (providerPeers.length > 0) {
      response.providerPeers = providerPeers
    }

    if (closerPeers.length > 0) {
      response.closerPeers = closerPeers
    }

    log('got %s providers %s closerPeers', providerPeers.length, closerPeers.length)
    return response
  }
}

module.exports.GetProvidersHandler = GetProvidersHandler
