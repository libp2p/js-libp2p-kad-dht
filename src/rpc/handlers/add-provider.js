'use strict'

const { CID } = require('multiformats/cid')
const errcode = require('err-code')
const utils = require('../../utils')
const log = utils.logger('libp2p:kad-dht:rpc:handlers:add-provider')

/**
 * @typedef {import('peer-id')} PeerId
 * @typedef {import('../../message').Message} Message
 * @typedef {import('../../types').DHTMessageHandler} DHTMessageHandler
 */

/**
 * @implements {DHTMessageHandler}
 */
class AddProviderHandler {
  /**
   * @param {PeerId} peerId
   * @param {import('../../providers').Providers} providers
   * @param {import('../../types').PeerStore} peerStore
   */
  constructor (peerId, providers, peerStore) {
    this._peerId = peerId
    this._providers = providers
    this._peerStore = peerStore
  }

  /**
   * @param {PeerId} peerId
   * @param {Message} msg
   */
  async handle (peerId, msg) {
    log('start')

    if (!msg.key || msg.key.length === 0) {
      throw errcode(new Error('Missing key'), 'ERR_MISSING_KEY')
    }

    /** @type {CID} */
    let cid
    try {
      cid = CID.decode(msg.key)
    } catch (/** @type {any} */ err) {
      const errMsg = `Invalid CID: ${err.message}`
      throw errcode(new Error(errMsg), 'ERR_INVALID_CID')
    }

    await Promise.all(
      msg.providerPeers.map(async (pi) => {
        // Ignore providers not from the originator
        if (!pi.id.equals(peerId)) {
          log('invalid provider peer %s from %s', pi.id.toB58String(), peerId.toB58String())
          return
        }

        if (pi.multiaddrs.length < 1) {
          log('no valid addresses for provider %s. Ignore', peerId.toB58String())
          return
        }

        log('received provider %s for %s (addrs %s)', peerId.toB58String(), cid.toString(), pi.multiaddrs.map((m) => m.toString()))

        if (!this._peerId.equals(pi.id)) {
          // Add known address to peer store
          this._peerStore.addressBook.add(pi.id, pi.multiaddrs)
          await this._providers.addProvider(cid, pi.id)
        }
      })
    )

    // TODO: Previous versions of the JS DHT sent erroneous providers in the
    // `providerPeers` field. In order to accommodate older clients that have
    // this bug, we fall back to assuming the originator is the provider if
    // we can't find any valid providers in the payload.
    // https://github.com/libp2p/js-libp2p-kad-dht/pull/127
    // https://github.com/libp2p/js-libp2p-kad-dht/issues/128
    await this._providers.addProvider(cid, peerId)

    return undefined
  }
}

module.exports.AddProviderHandler = AddProviderHandler
