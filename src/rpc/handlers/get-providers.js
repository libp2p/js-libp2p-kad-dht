'use strict'

const CID = require('cids')
const PeerInfo = require('peer-info')

const errcode = require('err-code')

const Message = require('../../message')
const utils = require('../../utils')

module.exports = (dht) => {
  const log = utils.logger(dht.peerInfo.id, 'rpc:get-providers')

  /**
   * Process `GetProviders` DHT messages.
   *
   * @param {PeerInfo} peer
   * @param {Message} msg
   * @returns {Promise<Message>}
   */
  return async function getProviders (peer, msg) {
    let cid
    try {
      cid = new CID(msg.key)
    } catch (err) {
      throw errcode(`Invalid CID: ${err.message}`, 'ERR_INVALID_CID')
    }

    log('%s', cid.toBaseEncodedString())

    const dsKey = utils.bufferToKey(cid.buffer)

    const res = await Promise.all([
      dht.datastore.has(dsKey).catch((err) => {
        log.error('Failed to check datastore existence', err)
        return false
      }),
      dht.providers.getProviders(cid),
      dht._betterPeersToQuery(msg, peer)
    ])

    const has = res[0]
    const closer = res[2]
    const providers = res[1].map((p) => {
      if (dht.peerBook.has(p)) {
        return dht.peerBook.get(p)
      }

      return dht.peerBook.put(new PeerInfo(p))
    })

    if (has) {
      providers.push(dht.peerInfo)
    }

    const response = new Message(msg.type, msg.key, msg.clusterLevel)

    if (providers.length > 0) {
      response.providerPeers = providers
    }

    if (closer.length > 0) {
      response.closerPeers = closer
    }

    log('got %s providers %s closerPeers', providers.length, closer.length)

    return response
  }
}
