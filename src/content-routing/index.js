'use strict'

const errcode = require('err-code')
const c = require('../constants')
const LimitedPeerList = require('../peer-list/limited-peer-list')
const { Message } = require('../message')
const drain = require('it-drain')
const parallel = require('it-parallel')
const map = require('it-map')
const utils = require('../utils')

const log = utils.logger('libp2p:kad-dht:content-routing')

/**
 * @typedef {import('multiformats/cid').CID} CID
 * @typedef {import('peer-id')} PeerId
 * @typedef {import('multiaddr').Multiaddr} Multiaddr
 * @typedef {import('../types').PeerData} PeerData
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
   * Check for providers from a single node.
   *
   * @param {PeerId} peer
   * @param {CID} key
   * @param {AbortSignal} signal
   */
  async _findProvidersSingle (peer, key, signal) { // eslint-disable-line require-await
    const msg = new Message(Message.TYPES.GET_PROVIDERS, key.bytes, 0)
    return this._network.sendRequest(peer, msg, signal)
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
        log(`putProvider ${key} to ${peer.toB58String()}`)
        try {
          await this._network.sendMessage(peer, msg, signal)
        } catch (/** @type {any} */ err) {
          errors.push(err)
        }
      }
    }

    // Notify closest peers
    // TODO: this uses the CID bytes, should it be multihash instead?
    await drain(parallel(map(this._peerRouting.getClosestPeers(key.bytes, signal), mapPeer)))

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
    const n = options.maxNumProviders || c.K

    log(`findProviders ${key}`)

    const out = new LimitedPeerList(n)
    const provs = await this._providers.getProviders(key)

    provs
      .forEach(id => {
        const peerData = this._peerStore.get(id)

        if (peerData) {
          out.push({
            id: peerData.id,
            multiaddrs: peerData.addresses
              .map((address) => address.multiaddr)
          })
        } else {
          out.push({
            id,
            multiaddrs: []
          })
        }
      })

    // yield values
    yield * out.toArray()

    // All done
    if (out.length >= n) {
      return
    }

    // need more, query the network
    /** @type {LimitedPeerList[]} */
    const paths = []

    /**
     * @type {import('../types').MakeQueryFunc<PeerData[]>}
     */
    const makeQuery = (pathIndex, numPaths) => {
      // This function body runs once per disjoint path
      const pathSize = utils.pathSize(n - out.length, numPaths)
      const pathProviders = new LimitedPeerList(pathSize)
      paths.push(pathProviders)

      /**
       * The query function to use on this particular disjoint path
       *
       * @type {import('../types').QueryFunc<PeerData[]>}
       */
      const findProvidersQuery = async (peer, signal) => {
        const msg = await this._findProvidersSingle(peer, key, signal)
        const provs = msg.providerPeers
        log(`Found ${provs.length} provider entries for ${key}`)

        provs.forEach((prov) => {
          pathProviders.push({
            ...prov
          })
        })

        // hooray we have all that we want
        if (pathProviders.length >= pathSize) {
          return {
            done: true,
            value: provs
          }
        }

        // it looks like we want some more
        return {
          done: false,
          closerPeers: msg.closerPeers,
          value: provs
        }
      }

      return findProvidersQuery
    }

    const peers = this._routingTable.closestPeers(key.bytes)

    // TODO: this finds peers by CID bytes, should it be by multihash bytes instead?
    for await (const res of this._queryManager.run(key.bytes, peers, makeQuery, signal)) {
      if (res.done && res.value) {
        yield * res.value
      }
    }
  }
}

module.exports.ContentRouting = ContentRouting
