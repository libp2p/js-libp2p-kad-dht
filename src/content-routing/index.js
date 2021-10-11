'use strict'

const errcode = require('err-code')
const { Message } = require('../message')
const parallel = require('it-parallel')
const map = require('it-map')
const utils = require('../utils')
const { ALPHA } = require('../constants')

const log = utils.logger('libp2p:kad-dht:content-routing')

/**
 * @typedef {import('multiformats/cid').CID} CID
 * @typedef {import('peer-id')} PeerId
 * @typedef {import('multiaddr').Multiaddr} Multiaddr
 */

class ContentRouting {
  /**
   * @param {import('peer-id')} peerId
   * @param {import('../network').Network} network
   * @param {import('../peer-routing').PeerRouting} peerRouting
   * @param {import('../query-manager').QueryManager} queryManager
   * @param {import('../routing-table').RoutingTable} routingTable
   * @param {import('../providers').Providers} providers
   * @param {import('../types').PeerStore} peerStore
   */
  constructor (peerId, network, peerRouting, queryManager, routingTable, providers, peerStore) {
    this._peerId = peerId
    this._network = network
    this._peerRouting = peerRouting
    this._queryManager = queryManager
    this._routingTable = routingTable
    this._providers = providers
    this._peerStore = peerStore
  }

  /**
   * Announce to the network that we can provide the value for a given key and
   * are contactable on the given multiaddrs
   *
   * @param {CID} key
   * @param {Multiaddr[]} multiaddrs
   * @param {object} [options]
   * @param {AbortSignal} [options.signal]
   */
  async * provide (key, multiaddrs, options = {}) {
    log('provide %s', key)

    /** @type {Error[]} */
    const errors = []

    // Add peer as provider
    await this._providers.addProvider(key, this._peerId)

    const msg = new Message(Message.TYPES.ADD_PROVIDER, key.bytes, 0)
    msg.providerPeers = [{
      id: this._peerId,
      multiaddrs
    }]

    /**
     * @param {PeerId} peer
     */
    const mapPeer = (peer) => {
      return async () => {
        log('putProvider %s to %p', key, peer)

        try {
          log('sending provider record for %s to %p', key, peer)
          await this._network.sendMessage(peer, msg, options)
          log('sent provider record for %s to %p', key, peer)

          return peer
        } catch (/** @type {any} */ err) {
          log.error('error sending provide record to peer %p', peer, err)
          errors.push(err)
        }
      }
    }

    let sent = 0

    // Notify closest peers
    for await (const peer of parallel(map(this._peerRouting.getClosestPeers(key.multihash.bytes, options), mapPeer), {
      ordered: false,
      concurrency: ALPHA
    })) {
      if (peer) {
        yield peer
        sent++
      }
    }

    log('sent provider records to %d peers', sent)

    if (sent === 0) {
      if (errors.length) {
        // if all sends failed, throw an error to inform the caller
        throw errcode(new Error(`Failed to provide to ${errors.length} of ${this._routingTable._kBucketSize} peers`), 'ERR_PROVIDES_FAILED', { errors })
      }

      throw errcode(new Error('Failed to provide - no peers found'), 'ERR_PROVIDES_FAILED')
    }
  }

  /**
   * Search the dht for up to `K` providers of the given CID.
   *
   * @param {CID} key
   * @param {object} [options] - findProviders options
   * @param {number} [options.maxNumProviders=5] - maximum number of providers to find
   * @param {AbortSignal} [options.signal]
   */
  async * findProviders (key, options = { maxNumProviders: 5 }) {
    const toFind = options.maxNumProviders || this._routingTable._kBucketSize

    log(`findProviders ${key}`)

    const provs = await this._providers.getProviders(key)

    // yield values, also slice because maybe we got lucky and already have too many?
    yield * provs.slice(0, toFind)

    // All done
    if (provs.length >= toFind) {
      return
    }

    /**
     * The query function to use on this particular disjoint path
     *
     * @type {import('../types').QueryFunc<PeerId[]>}
     */
    const findProvidersQuery = async ({ peer, signal }) => {
      let response
      try {
        const request = new Message(Message.TYPES.GET_PROVIDERS, key.bytes, 0)
        response = await this._network.sendRequest(peer, request, options)
      } catch (/** @type {any} */ err) {
        return {
          done: false,
          closerPeers: [],
          err: err
        }
      }

      log(`Found ${response.providerPeers.length} provider entries for ${key} and ${response.closerPeers.length} closer peers`)

      return {
        closerPeers: response.closerPeers.map(peerData => peerData.id),
        value: response.providerPeers.map(peerData => peerData.id)
      }
    }

    const providers = new Set(provs.map(p => p.toB58String()))

    for await (const res of this._queryManager.run(key.multihash.bytes, this._routingTable.closestPeers(key.bytes), findProvidersQuery, options.signal)) {
      if (res.value) {
        for (const peer of res.value) {
          if (providers.has(peer.toB58String())) {
            continue
          }

          providers.add(peer.toB58String())
          yield peer

          if (providers.size === toFind) {
            return
          }
        }
      }
    }
  }
}

module.exports.ContentRouting = ContentRouting
