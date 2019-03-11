'use strict'

const { EventEmitter } = require('events')
const libp2pRecord = require('libp2p-record')
const MemoryStore = require('interface-datastore').MemoryDatastore
const PeerId = require('peer-id')
const PeerInfo = require('peer-info')
const crypto = require('libp2p-crypto')
const { collect } = require('streaming-iterables')

const errcode = require('err-code')

const ConnectionHelper = require('./connection-helper')
const RoutingTable = require('./routing')
const utils = require('./utils')
const c = require('./constants')
const Query = require('./query')
const Network = require('./network')
const privateApi = require('./private')
const Providers = require('./providers')
const Message = require('./message')
const RandomWalk = require('./random-walk')
const assert = require('assert')
const defaultsDeep = require('@nodeutils/defaults-deep')

/**
 * A DHT implementation modeled after Kademlia with S/Kademlia modifications.
 *
 * Original implementation in go: https://github.com/libp2p/go-libp2p-kad-dht.
 */
class KadDHT extends EventEmitter {
  /**
   * Random walk options
   *
   * @typedef {Object} randomWalkOptions
   * @property {boolean} enabled discovery enabled (default: true)
   * @property {number} queriesPerPeriod how many queries to run per period (default: 1)
   * @property {number} interval how often to run the the random-walk process, in milliseconds (default: 300000)
   * @property {number} timeout how long to wait for the the random-walk query to run, in milliseconds (default: 10000)
   */

  /**
   * Create a new KadDHT.
   *
   * @param {Switch} sw libp2p-switch instance
   * @param {object} options DHT options
   * @param {number} options.kBucketSize k-bucket size (default 20)
   * @param {Datastore} options.datastore datastore (default MemoryDatastore)
   * @param {object} options.validators validators object with namespace as keys and function(key, record)
   * @param {object} options.selectors selectors object with namespace as keys and function(key, records)
   * @param {randomWalkOptions} options.randomWalk randomWalk options
   */
  constructor (sw, options) {
    super()
    assert(sw, 'libp2p-kad-dht requires a instance of Switch')
    options = options || {}
    options.validators = options.validators || {}
    options.selectors = options.selectors || {}
    options.randomWalk = defaultsDeep(options.randomWalk, c.defaultRandomWalk)

    /**
     * Local reference to the libp2p-switch instance
     *
     * @type {Switch}
     */
    this.switch = sw

    /**
     * k-bucket size, defaults to 20
     *
     * @type {number}
     */
    this.kBucketSize = options.kBucketSize || 20

    /**
     * Number of closest peers to return on kBucket search, default 6
     *
     * @type {number}
     */
    this.ncp = options.ncp || 6

    /**
     * The routing table.
     *
     * @type {RoutingTable}
     */
    this.routingTable = new RoutingTable(this.peerInfo.id, this.kBucketSize)

    /**
     * Reference to the datastore, uses an in-memory store if none given.
     *
     * @type {Datastore}
     */
    this.datastore = options.datastore || new MemoryStore()

    /**
     * Provider management
     *
     * @type {Providers}
     */
    this.providers = new Providers(this.datastore, this.peerInfo.id)

    this.validators = {
      pk: libp2pRecord.validator.validators.pk,
      ...options.validators
    }

    this.selectors = {
      pk: libp2pRecord.selection.selectors.pk,
      ...options.selectors
    }

    this.network = new Network(this)
    this._connectionHelper = new ConnectionHelper(this.peerInfo.id)

    this._log = utils.logger(this.peerInfo.id)

    // Inject private apis so we don't clutter up this file
    const pa = privateApi(this)
    Object.keys(pa).forEach((name) => { this[name] = pa[name] })

    /**
     * Provider management
     *
     * @type {RandomWalk}
     */
    this.randomWalk = new RandomWalk(this)

    /**
     * Random walk state, default true
     */
    this.randomWalkEnabled = Boolean(options.randomWalk.enabled)
    this.randomWalkQueriesPerPeriod = parseInt(options.randomWalk.queriesPerPeriod)
    this.randomWalkInterval = parseInt(options.randomWalk.interval)
    this.randomWalkTimeout = parseInt(options.randomWalk.timeout)
  }

  /**
   * Is this DHT running.
   *
   * @type {bool}
   */
  get isStarted () {
    return this._running
  }

  /**
   * Start listening to incoming connections.
   *
   * @returns {Promise}
   */
  async start () {
    this._running = true
    await this.network.start()

    // Start random walk if enabled
    this.randomWalkEnabled && this.randomWalk.start(this.randomWalkQueriesPerPeriod, this.randomWalkInterval, this.randomWalkTimeout)
  }

  /**
   * Stop accepting incoming connections and sending outgoing
   * messages.
   *
   * @returns {Promise}
   */
  async stop () {
    this._running = false
    await this.randomWalk.stop() // guarantee that random walk is stopped if it was started
    this.providers.stop()
    return this.network.stop()
  }

  /**
   * Local peer (yourself)
   *
   * @type {PeerInfo}
   */
  get peerInfo () {
    return this.switch._peerInfo
  }

  get peerBook () {
    return this.switch._peerBook
  }

  /**
   * Store the given key/value pair in the DHT.
   *
   * @param {Buffer} key
   * @param {Buffer} value
   * @param {Object} options - get options
   * @param {number} options.minPeers - minimum peers that must be put to to consider this a successful operation
   * (default: closestPeers.length)
   * @returns {Promise}
   */
  put (key, value, options = {}) {
    this._log('PutValue %b', key)

    const rec = utils.createPutRecord(key, value)
    return Promise.all([
      this._putLocal(key, rec),
      (async () => {
        const peers = await this.getClosestPeers(key, { shallow: true })

        // Ensure we have a default `minPeers`
        options.minPeers = options.minPeers || peers.length

        let successful = 0
        await Promise.all(peers.map(async (peer) => {
          try {
            await this._putValueToPeer(key, rec, peer)
            successful++
          } catch (err) {
            this._log.error('Failed to put to peer (%b): %s', peer.id, err)
          }
        }))

        // Did we put to enough peers?
        if (successful < options.minPeers) {
          const error = errcode('Failed to put value to enough peers', 'ERR_NOT_ENOUGH_PUT_PEERS')
          this._log.error(error)
          throw error
        }
      })()
    ])
  }

  /**
   * Get the value to the given key.
   * Times out after 1 minute.
   *
   * @param {Buffer} key
   * @param {Object} options - get options
   * @param {number} options.timeout - optional timeout in ms (default: 60000)
   * @returns {Promise<Buffer>}
   */
  get (key, options = {}) {
    if (!options.maxTimeout && !options.timeout) {
      options.timeout = c.minute // default
    } else if (options.maxTimeout && !options.timeout) { // TODO this will be deprecated in a next release
      options.timeout = options.maxTimeout
    }

    return this._get(key, options)
  }

  /**
   * Get the `n` values to the given key without sorting.
   *
   * @param {Buffer} key
   * @param {number} nvals
   * @param {Object} options - get options
   * @param {number} options.timeout - optional timeout (default: 60000)
   * @returns {AsyncIterator<{from: PeerId, val: Buffer}>}
   */
  async * getMany (key, nvals, options = {}) {
    if (!options.maxTimeout && !options.timeout) {
      options.timeout = c.minute // default
    } else if (options.maxTimeout && !options.timeout) { // TODO this will be deprecated in a next release
      options.timeout = options.maxTimeout
    }

    this._log('getMany %b (%s)', key, nvals)
    let valCount = 0

    // First check the local store
    let localRec, err
    try {
      localRec = await this._getLocal(key)
    } catch (e) {
      err = e
    }

    if (err && nvals === 0) {
      throw err
    }

    if (!err) {
      valCount++
      yield {
        val: localRec.value,
        from: this.peerInfo.id
      }
    }

    // Already have enough values
    if (valCount >= nvals) {
      return
    }

    // Not enough values yet, let's go out to the swarm
    const id = await utils.convertBuffer(key)

    // As a starting list of peers, get the closest ALPHA peers to the key that
    // we know about from the routing table
    const rtp = this.routingTable.closestPeers(id, c.ALPHA)

    this._log('peers in rt: %d', rtp.length)
    if (rtp.length === 0) {
      const errMsg = 'Failed to lookup key! No peers from routing table!'

      this._log.error(errMsg)
      throw errcode(errMsg, 'ERR_NO_PEERS_IN_ROUTING_TABLE')
    }

    // We have peers, lets do the actual query to them
    const startingValCount = valCount
    const query = new Query(this, key, (pathIndex, numPaths) => {
      // This function body runs once per disjoint path.
      // Note: For S/Kademlia, We need to get peers from nvals disjoint paths
      // (not just nvals different peers)
      // eg 20 values from 8 paths = Math.ceiling(20 / 8) = 3 peers per path
      const pathSize = utils.pathSize(nvals - startingValCount, numPaths)
      let pathVals = 0

      // Here we return the query function to use on this particular disjoint path
      return async (peer) => {
        let valueOrPeers, err
        try {
          valueOrPeers = await this._getValueOrPeers(peer, key)
        } catch (e) {
          err = e
          // If we have an invalid record we just want to continue and fetch a new one.
          if (err.code !== 'ERR_INVALID_RECORD') {
            throw err
          }
        }
        let { record, peers } = valueOrPeers || {}

        const res = { closerPeers: peers }

        // Note: An invalid record still counts as a retrieved record
        if ((record && record.value) || (err && err.code === 'ERR_INVALID_RECORD')) {
          pathVals++
          res.value = {
            val: record && record.value,
            from: peer
          }
        }

        // We have enough values for this path so we're done
        if (pathVals >= pathSize) {
          res.success = true
        }

        return res
      }
    })

    for await (const res of query.run(rtp, options.timeout)) {
      if ((res || {}).value) {
        valCount++
        yield res.value
      }
      if (valCount >= nvals) {
        query.stop()
        return
      }
    }
    query.stop()
  }

  /**
   * Kademlia 'node lookup' operation.
   *
   * @param {Buffer} key
   * @param {Object} options
   * @param {boolean} options.shallow shallow query
   * @returns {Promise<Array<PeerId>>}
   */
  async getClosestPeers (key, options = {}) {
    this._log('getClosestPeers to %b', key)
    const id = await utils.convertBuffer(key)

    const tablePeers = this.routingTable.closestPeers(id, c.ALPHA)

    const q = new Query(this, key, () => {
      // There is no distinction between the disjoint paths,
      // so there are no per-path variables in this scope.
      // Just return the actual query function.
      return async (peer) => {
        const closer = await this._closerPeersSingle(key, peer)

        return {
          closerPeers: closer,
          success: options.shallow ? true : undefined
        }
      }
    })

    const results = await collect(q.run(tablePeers))
    const peers = (results[0] || {}).peersSeen

    if (!(peers || {}).length) {
      return []
    }

    const sorted = await utils.sortClosestPeers(peers, id)
    return sorted.slice(0, c.K)
  }

  /**
   * Get the public key for the given peer id.
   *
   * @param {PeerId} peer
   * @returns {Promise<PubKey>}
   */
  async getPublicKey (peer) {
    this._log('getPublicKey %s', peer.toB58String())
    // local check
    let info
    if (this.peerBook.has(peer)) {
      info = this.peerBook.get(peer)

      if (info && info.id.pubKey) {
        this._log('getPublicKey: found local copy')
        return info.id.pubKey
      }
    } else {
      info = this.peerBook.put(new PeerInfo(peer))
    }

    // try the node directly
    try {
      const pk = await this._getPublicKeyFromNode(peer)
      info.id = new PeerId(peer.id, null, pk)
      this.peerBook.put(info)

      return pk
    } catch (err) {
      this._log('getPublicKey: could not get public key from node: %s', err)
    }

    // dht directly
    const pkKey = utils.keyForPublicKey(peer)
    const value = await this.get(pkKey)

    const pk = crypto.unmarshalPublicKey(value)
    info.id = new PeerId(peer, null, pk)
    this.peerBook.put(info)

    return pk
  }

  /**
   * Look if we are connected to a peer with the given id.
   * Returns the `PeerInfo` for it, if found, otherwise `undefined`.
   *
   * @param {PeerId} peer
   * @returns {Promise<PeerInfo>}
   */
  async findPeerLocal (peer) {
    this._log('findPeerLocal %s', peer.toB58String())
    const p = await this.routingTable.find(peer)

    if (!p || !this.peerBook.has(p)) {
      return
    }

    return this.peerBook.get(p)
  }

  // ----------- Content Routing

  /**
   * Announce to the network that we can provide given key's value.
   *
   * @param {CID} key
   * @returns {Promise}
   */
  async provide (key) {
    this._log('provide: %s', key.toBaseEncodedString())

    const [, peers] = await Promise.all([
      this.providers.addProvider(key, this.peerInfo.id),
      this.getClosestPeers(key.buffer)
    ])

    const msg = new Message(Message.TYPES.ADD_PROVIDER, key.buffer, 0)
    msg.providerPeers = peers.map((p) => new PeerInfo(p))

    return Promise.all(peers.map((peer) => {
      this._log('putProvider %s to %s', key.toBaseEncodedString(), peer.toB58String())
      return this.network.sendMessage(peer, msg)
    }))
  }

  /**
   * Search the dht for up to `K` providers of the given CID.
   *
   * @param {CID} key
   * @param {Object} options - findProviders options
   * @param {number} options.timeout - how long the query should maximally run, in milliseconds (default: 60000)
   * @param {number} options.maxNumProviders - maximum number of providers to find
   * @returns {AsyncIterator<PeerInfo>}
   */
  async * findProviders (key, options = {}) {
    if (!options.maxTimeout && !options.timeout) {
      options.timeout = c.minute // default
    } else if (options.maxTimeout && !options.timeout) { // TODO this will be deprecated in a next release
      options.timeout = options.maxTimeout
    }

    options.maxNumProviders = options.maxNumProviders || c.K

    this._log('findProviders %s', key.toBaseEncodedString())
    return yield * this._findNProviders(key, options.timeout, options.maxNumProviders)
  }

  // ----------- Peer Routing

  /**
   * Search for a peer with the given ID.
   *
   * @param {PeerId} id
   * @param {Object} options - findPeer options
   * @param {number} options.timeout - how long the query should maximally run, in milliseconds (default: 60000)
   * @returns {Promise<PeerInfo>}
   */
  async findPeer (id, options = {}) {
    if (!options.maxTimeout && !options.timeout) {
      options.timeout = c.minute // default
    } else if (options.maxTimeout && !options.timeout) { // TODO this will be deprecated in a next release
      options.timeout = options.maxTimeout
    }

    this._log('findPeer %s', id.toB58String())

    const peerId = await this.findPeerLocal(id)

    // already got it
    if (peerId != null) {
      this._log('found local')
      return peerId
    }

    const key = await utils.convertPeerId(id)

    const peers = this.routingTable.closestPeers(key, c.ALPHA)

    if (peers.length === 0) {
      throw errcode('Peer lookup failed', 'ERR_LOOKUP_FAILED')
    }

    // sanity check
    const match = peers.find((p) => p.isEqual(id))
    if (match && this.peerBook.has(id)) {
      this._log('found in peerbook')
      return this.peerBook.get(id)
    }

    // query the network
    const query = new Query(this, id.id, () => {
      // There is no distinction between the disjoint paths,
      // so there are no per-path variables in this scope.
      // Just return the actual query function.
      return async (peer) => {
        const msg = await this._findPeerSingle(peer, id)

        const match = msg.closerPeers.find((p) => p.id.isEqual(id))

        // found it
        if (match) {
          return {
            value: match,
            success: true
          }
        }

        return {
          closerPeers: msg.closerPeers
        }
      }
    })

    const results = await collect(query.run(peers, options.timeout))

    const success = Boolean(results.length && results[0].value)
    if (success) {
      this.peerBook.put(results[0].value)
    }

    this._log('findPeer %s: %s', id.toB58String(), success)
    if (!success) {
      throw errcode('No peer found', 'ERR_NOT_FOUND')
    }

    return this.peerBook.get(id)
  }

  _peerDiscovered (peerInfo) {
    this.emit('peer', peerInfo)
  }
}

module.exports = KadDHT
