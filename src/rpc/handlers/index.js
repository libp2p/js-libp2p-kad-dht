'use strict'

const T = require('../../message').TYPES
const { AddProviderHandler } = require('./add-provider')
const { FindNodeHandler } = require('./find-node')
const { GetProvidersHandler } = require('./get-providers')
const { GetValueHandler } = require('./get-value')
const { PingHandler } = require('./ping')
const { PutValueHandler } = require('./put-value')

/**
 * @param {import('peer-id')} peerId
 * @param {import('../../providers').Providers} providers
 * @param {import('../../types').PeerStore} peerStore
 * @param {import('../../types').Addressable} addressable
 * @param {import('../../peer-routing').PeerRouting} peerRouting
 * @param {import('interface-datastore').Datastore} datastore
 * @param {import('libp2p-interfaces/src/types').DhtValidators} validators
 */
module.exports = (peerId, providers, peerStore, addressable, peerRouting, datastore, validators) => {
  const handlers = {
    [T.GET_VALUE]: new GetValueHandler(peerId, peerStore, peerRouting, datastore),
    [T.PUT_VALUE]: new PutValueHandler(validators, datastore),
    [T.FIND_NODE]: new FindNodeHandler(peerId, addressable, peerRouting),
    [T.ADD_PROVIDER]: new AddProviderHandler(peerId, providers, peerStore),
    [T.GET_PROVIDERS]: new GetProvidersHandler(peerId, peerRouting, providers, datastore, peerStore),
    [T.PING]: new PingHandler()
  }

  /**
   * Get the message handler matching the passed in type.
   *
   * @param {number} type
   */
  function getMessageHandler (type) {
    return handlers[type]
  }

  return getMessageHandler
}
