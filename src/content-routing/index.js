'use strict'

const errcode = require('err-code')
const { Message } = require('../message')
const drain = require('it-drain')
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
   * @param {AbortSignal} signal
   */
  async provide (key, multiaddrs, signal) {
    log(`provide: ${key}`)

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
          await this._network.sendMessage(peer, msg, signal)
        } catch (/** @type {any} */ err) {
          errors.push(err)
        }
      }
    }

    // Notify closest peers
    // TODO: this uses the CID bytes, should it be multihash instead?
    await drain(parallel(map(this._peerRouting.getClosestPeers(key.bytes, signal), mapPeer), {
      ordered: false,
      concurrency: ALPHA
    }))

    if (errors.length) {
      // TODO:
      // This should be infrequent. This means a peer we previously connected
      // to failed to exchange the provide message. If getClosestPeers was an
      // iterator, we could continue to pull until we announce to kBucketSize peers.
      throw errcode(new Error(`Failed to provide to ${errors.length} of ${this._routingTable._kBucketSize} peers`), 'ERR_SOME_PROVIDES_FAILED', { errors })
    }
  }

  /**
   * Search the dht for up to `K` providers of the given CID.
   *
   * @param {CID} key
   * @param {AbortSignal} signal
   * @param {object} [options] - findProviders options
   * @param {number} [options.maxNumProviders=5] - maximum number of providers to find
   */
  async * findProviders (key, signal, options = { maxNumProviders: 5 }) {
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
        response = await this._network.sendRequest(peer, request, signal)
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

    // TODO: this finds peers by CID bytes, should it be by multihash bytes instead?
    for await (const res of this._queryManager.run(key.bytes, this._routingTable.closestPeers(key.bytes), findProvidersQuery, signal)) {
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
