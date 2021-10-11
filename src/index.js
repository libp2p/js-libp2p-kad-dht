'use strict'

const { EventEmitter } = require('events')
const PeerId = require('peer-id')
const crypto = require('libp2p-crypto')
const libp2pRecord = require('libp2p-record')
const { MemoryDatastore } = require('datastore-core/memory')
const { toString: uint8ArrayToString } = require('uint8arrays/to-string')
const { RoutingTable } = require('./routing-table')
const { RoutingTableRefresh } = require('./routing-table/refresh')
const utils = require('./utils')
const {
  K,
  PROTOCOL_DHT
} = require('./constants')
const { Network } = require('./network')
const { ContentFetching } = require('./content-fetching')
const { ContentRouting } = require('./content-routing')
const { PeerRouting } = require('./peer-routing')
const { Providers } = require('./providers')
const { QueryManager } = require('./query-manager')
const { RPC } = require('./rpc')

const log = utils.logger('libp2p:kad-dht')

/**
 * @typedef {import('libp2p')} Libp2p
 * @typedef {import('libp2p/src/peer-store')} PeerStore
 * @typedef {import('interface-datastore').Datastore} Datastore
 * @typedef {import('libp2p/src/dialer')} Dialer
 * @typedef {import('libp2p/src/registrar')} Registrar
 * @typedef {import('multiformats/cid').CID} CID
 * @typedef {import('multiaddr').Multiaddr} Multiaddr
 * @typedef {object} PeerData
 * @property {PeerId} id
 * @property {Multiaddr[]} multiaddrs
 *
 * @typedef {import('./types').DHT} DHT
 */

/**
 * A DHT implementation modelled after Kademlia with S/Kademlia modifications.
 * Original implementation in go: https://github.com/libp2p/go-libp2p-kad-dht.
 */
class KadDHT extends EventEmitter {
  /**
   * Create a new KadDHT.
   *
   * @param {object} props
   * @param {Libp2p} props.libp2p - the libp2p instance
   * @param {string} [props.protocolPrefix = '/ipfs'] - libp2p registrar handle protocol
   * @param {boolean} [props.forceProtocolLegacy = false] - WARNING: this is not recommended and should only be used for legacy purposes
   * @param {number} props.kBucketSize - k-bucket size (default 20)
   * @param {boolean} props.clientMode - If true, the DHT will not respond to queries. This should be true if your node will not be dialable. (default: false)
   * @param {import('libp2p-interfaces/src/types').DhtValidators} props.validators - validators object with namespace as keys and function(key, record, callback)
   * @param {object} props.selectors - selectors object with namespace as keys and function(key, records)
   */
  constructor ({
    libp2p,
    protocolPrefix = '/ipfs',
    forceProtocolLegacy = false,
    kBucketSize = K,
    clientMode = true,
    validators = {},
    selectors = {}
  }) {
    super()

    this._running = false

    /**
     * Local reference to the libp2p instance
     *
     * @type {Libp2p}
     */
    this._libp2p = libp2p

    /**
     * Registrar protocol
     *
     * @type {string}
     */
    this._protocol = protocolPrefix + (forceProtocolLegacy ? '' : PROTOCOL_DHT)

    /**
     * k-bucket size
     *
     * @type {number}
     */
    this._kBucketSize = kBucketSize

    /**
     * Whether we are in client or server mode
     */
    this._clientMode = clientMode

    /**
     * The routing table.
     *
     * @type {RoutingTable}
     */
    this._routingTable = new RoutingTable(libp2p.peerId, libp2p, { kBucketSize })

    /**
     * Reference to the datastore, uses an in-memory store if none given.
     *
     * @type {Datastore}
     */
    this._datastore = libp2p.datastore || new MemoryDatastore()

    /**
     * Provider management
     *
     * @type {Providers}
     */
    this._providers = new Providers(this._datastore)

    this._validators = {
      pk: libp2pRecord.validator.validators.pk,
      ...validators
    }

    this._selectors = {
      pk: libp2pRecord.selection.selectors.pk,
      ...selectors
    }

    this._network = new Network(
      libp2p,
      libp2p.registrar,
      this._routingTable,
      libp2p.peerStore.addressBook,
      this._protocol
    )

    /**
     * Keeps track of running queries
     *
     * @type {QueryManager}
     */
    this._queryManager = new QueryManager(
      libp2p.peerId,
      // Number of disjoint query paths to use - This is set to `kBucketSize/2` per the S/Kademlia paper
      Math.ceil(kBucketSize / 2)
    )
    // DHT components
    this._peerRouting = new PeerRouting(
      libp2p.peerId,
      this._routingTable,
      libp2p.peerStore,
      this._network,
      this._validators,
      this._queryManager
    )
    this._contentFetching = new ContentFetching(
      libp2p.peerId,
      this._datastore,
      this._validators,
      this._selectors,
      this._peerRouting,
      this._queryManager,
      this._routingTable
    )
    this._contentRouting = new ContentRouting(
      libp2p.peerId,
      this._network,
      this._peerRouting,
      this._queryManager,
      this._routingTable,
      this._providers,
      libp2p.peerStore
    )
    this._routingTableRefresh = new RoutingTableRefresh(
      this._peerRouting,
      this._routingTable
    )
    this._rpc = new RPC(
      this._routingTable,
      libp2p.peerId,
      this._providers,
      libp2p.peerStore,
      libp2p,
      this._peerRouting,
      this._datastore,
      this._validators
    )
  }

  /**
   * Is this DHT running.
   */
  get isStarted () {
    return this._running
  }

  /**
   * Whether we are in client or server mode
   */
  enableServerMode () {
    this._clientMode = false
    this._libp2p.handle(this._protocol, this._rpc.onIncomingStream.bind(this._rpc))
  }

  /**
   * Whether we are in client or server mode
   */
  enableClientMode () {
    this._clientMode = true
    this._libp2p.unhandle(this._protocol)
  }

  /**
   * Start listening to incoming connections.
   */
  start () {
    this._running = true

    // Only respond to queries when not in client mode
    if (!this._clientMode) {
      // Incoming streams
      this.enableServerMode()
    }

    return Promise.all([
      this._providers.start(),
      this._queryManager.start(),
      this._network.start(),
      this._routingTable.start(),
      this._routingTableRefresh.start()
    ])
  }

  /**
   * Stop accepting incoming connections and sending outgoing
   * messages.
   */
  stop () {
    this._running = false

    return Promise.all([
      this._providers.stop(),
      this._queryManager.stop(),
      this._network.stop(),
      this._routingTable.stop(),
      this._routingTableRefresh.stop()
    ])
  }

  /**
   * Store the given key/value  pair in the DHT.
   *
   * @param {Uint8Array} key
   * @param {Uint8Array} value
   * @param {object} [options] - put options
   * @param {AbortSignal} [options.signal]
   * @param {number} [options.minPeers] - minimum number of peers required to successfully put (default: closestPeers.length)
   */
  async put (key, value, options = {}) { // eslint-disable-line require-await
    return this._contentFetching.put(key, value, options)
  }

  /**
   * Get the value to the given key.
   * Times out after 1 minute by default.
   *
   * @param {Uint8Array} key
   * @param {object} [options]
   * @param {AbortSignal} [options.signal]
   * @param {number} [options.queryFuncTimeout]
   */
  async get (key, options = {}) { // eslint-disable-line require-await
    return this._contentFetching.get(key, options)
  }

  /**
   * Get the `n` values to the given key without sorting.
   *
   * @param {Uint8Array} key
   * @param {number} nvals
   * @param {object} [options]
   * @param {AbortSignal} [options.signal]
   * @param {number} [options.queryFuncTimeout]
   */
  async * getMany (key, nvals, options = {}) { // eslint-disable-line require-await
    yield * this._contentFetching.getMany(key, nvals, options)
  }

  /**
   * Remove the given key from the local datastore.
   *
   * @param {Uint8Array} key
   */
  async removeLocal (key) {
    log(`removeLocal: ${uint8ArrayToString(key, 'base32')}`)
    const dsKey = utils.bufferToKey(key)

    try {
      await this._datastore.delete(dsKey)
    } catch (/** @type {any} */ err) {
      if (err.code === 'ERR_NOT_FOUND') {
        return undefined
      }
      throw err
    }
  }

  // ----------- Content Routing

  /**
   * Announce to the network that we can provide given key's value.
   *
   * @param {CID} key
   * @param {object} [options]
   * @param {AbortSignal} [options.signal]
   */
  async * provide (key, options = {}) { // eslint-disable-line require-await
    yield * this._contentRouting.provide(key, this._libp2p.multiaddrs, options)
  }

  /**
   * Search the dht for up to `K` providers of the given CID.
   *
   * @param {CID} key
   * @param {object} [options] - findProviders options
   * @param {number} [options.timeout=60000] - how long the query should maximally run, in milliseconds (default: 60000)
   * @param {number} [options.maxNumProviders=5] - maximum number of providers to find
   * @param {AbortSignal} [options.signal]
   * @param {number} [options.queryFuncTimeout]
   */
  async * findProviders (key, options = { timeout: 6000, maxNumProviders: 5 }) {
    yield * this._contentRouting.findProviders(key, options)
  }

  // ----------- Peer Routing -----------

  /**
   * Search for a peer with the given ID.
   *
   * @param {PeerId} id
   * @param {object} [options]
   * @param {AbortSignal} [options.signal]
   * @param {number} [options.queryFuncTimeout]
   */
  async findPeer (id, options = {}) { // eslint-disable-line require-await
    return this._peerRouting.findPeer(id, options)
  }

  /**
   * Kademlia 'node lookup' operation.
   *
   * @param {Uint8Array} key
   * @param {object} [options]
   * @param {boolean} [options.shallow = false] - shallow query
   * @param {AbortSignal} [options.signal]
   * @param {number} [options.queryFuncTimeout]
   */
  async * getClosestPeers (key, options = { shallow: false }) {
    yield * this._peerRouting.getClosestPeers(key, options)
  }

  /**
   * Get the public key for the given peer id.
   *
   * @param {PeerId} peer
   */
  /**
   * Get the public key for the given peer id.
   *
   * @param {PeerId} peer
   * @param {object} [options]
   * @param {AbortSignal} [options.signal]
   */
  async getPublicKey (peer, options = {}) {
    log('getPublicKey %p', peer)

    // local check
    const peerData = this._libp2p.peerStore.get(peer)

    if (peerData && peerData.id.pubKey) {
      log('getPublicKey: found local copy')
      return peerData.id.pubKey
    }

    // try the node directly
    let pk

    try {
      pk = await this._peerRouting.getPublicKeyFromNode(peer, options)
    } catch (/** @type {any} */ err) {
      // try dht directly
      const pkKey = utils.keyForPublicKey(peer)
      const value = await this.get(pkKey, options)
      pk = crypto.keys.unmarshalPublicKey(value)
    }

    const peerId = new PeerId(peer.id, undefined, pk)
    const addrs = ((peerData && peerData.addresses) || []).map((address) => address.multiaddr)
    this._libp2p.peerStore.addressBook.add(peerId, addrs)
    this._libp2p.peerStore.keyBook.set(peerId, pk)

    return pk
  }
}

module.exports = {
  /**
   * @param {*} opts
   * @returns {DHT}
   */
  create: (opts) => {
    return new KadDHT(opts)
  }
}
