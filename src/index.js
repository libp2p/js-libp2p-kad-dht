'use strict'

const errcode = require('err-code')
const { EventEmitter } = require('events')

const libp2pRecord = require('libp2p-record')
const { MemoryDatastore } = require('interface-datastore')
const PeerId = require('peer-id')
const PeerInfo = require('peer-info')
const crypto = require('libp2p-crypto')

const promisify = require('promisify-es6')
const pFilter = require('p-filter')
const pTimeout = require('p-timeout')

const RoutingTable = require('./routing')
const utils = require('./utils')
const c = require('./constants')
const Query = require('./query')
const Network = require('./network')
const privateApi = require('./private')
const Providers = require('./providers')
const Message = require('./message')
const RandomWalk = require('./random-walk')
const QueryManager = require('./query-manager')
const assert = require('assert')

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
   * @property {number} timeout how long to wait for the the random-walk query to run, in milliseconds (default: 30000)
   * @property {number} delay how long to wait before starting the first random walk, in milliseconds (default: 10000)
   */

  /**
   * Create a new KadDHT.
   *
   * @param {Switch} sw libp2p-switch instance
   * @param {object} options DHT options
   * @param {number} options.kBucketSize k-bucket size (default 20)
   * @param {number} options.concurrency alpha concurrency of queries (default 3)
   * @param {Datastore} options.datastore datastore (default MemoryDatastore)
   * @param {object} options.validators validators object with namespace as keys and function(key, record, callback)
   * @param {object} options.selectors selectors object with namespace as keys and function(key, records)
   * @param {randomWalkOptions} options.randomWalk randomWalk options
   */
  constructor (sw, options) {
    super()
    assert(sw, 'libp2p-kad-dht requires a instance of Switch')
    options = options || {}
    options.validators = options.validators || {}
    options.selectors = options.selectors || {}

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
    this.kBucketSize = options.kBucketSize || c.K

    /**
     * ALPHA concurrency at which each query path with run, defaults to 3
     * @type {number}
     */
    this.concurrency = options.concurrency || c.ALPHA

    /**
     * Number of disjoint query paths to use
     * This is set to `kBucketSize`/2 per the S/Kademlia paper
     * @type {number}
     */
    this.disjointPaths = Math.ceil(this.kBucketSize / 2)

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
    this.datastore = options.datastore || new MemoryDatastore()

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

    this._log = utils.logger(this.peerInfo.id)

    // Inject private apis so we don't clutter up this file
    const pa = privateApi(this)
    Object.keys(pa).forEach((name) => { this[name] = pa[name] })

    /**
     * Random walk management
     *
     * @type {RandomWalk}
     */
    this.randomWalk = new RandomWalk(this, options.randomWalk)

    /**
     * Keeps track of running queries
     *
     * @type {QueryManager}
     */
    this._queryManager = new QueryManager()
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
   * @param {function(Error)} callback
   * @returns {Promise<void>}
   */
  async start () {
    this._running = true
    this._queryManager.start()
    await this.network.start()

    // Start random walk, it will not run if it's disabled
    this.randomWalk.start()
  }

  /**
   * Stop accepting incoming connections and sending outgoing
   * messages.
   *
   * @param {function(Error)} callback
   * @returns {Promise<void>}
   */
  stop () {
    this._running = false
    this.randomWalk.stop()
    this.providers.stop()
    this._queryManager.stop()
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
   * Store the given key/value  pair in the DHT.
   *
   * @param {Buffer} key
   * @param {Buffer} value
   * @param {Object} [options] - put options
   * @param {number} [options.minPeers] - minimum number of peers required to successfully put (default: closestPeers.length)
   * @returns {Promise<void>}
   */
  async put (key, value, options = {}) {
    this._log('PutValue %b', key)

    // create record in the dht format
    const record = await utils.createPutRecord(key, value)

    // store the record locally
    await this._putLocal(key, record)

    // put record to the closest peers
    const peers = await this.getClosestPeers(key, { shallow: true })
    const results = await pFilter(peers, async (peer) => {
      try {
        await this._putValueToPeer(key, record, peer)
        return true
      } catch (err) {
        this._log.error('Failed to put to peer (%b): %s', peer.id, err)
        return false
      }
    })

    // verify if we were able to put to enough peers
    const minPeers = options.minPeers || peers.length // Ensure we have a default `minPeers`

    if (minPeers > results.length) {
      const error = errcode(new Error('Failed to put value to enough peers'), 'ERR_NOT_ENOUGH_PUT_PEERS')
      this._log.error(error)
      throw error
    }
  }

  /**
   * Get the value to the given key.
   * Times out after 1 minute by default.
   *
   * @param {Buffer} key
   * @param {Object} [options] - get options
   * @param {number} [options.timeout] - optional timeout (default: 60000)
   * @returns {Promise<void>}
   */
  get (key, options = {}) {
    options.timeout = options.timeout || c.minute

    return this._get(key, options)
  }

  /**
   * Get the `n` values to the given key without sorting.
   *
   * @param {Buffer} key
   * @param {number} nvals
   * @param {Object} [options] - get options
   * @param {number} [options.timeout] - optional timeout (default: 60000)
   * @returns {Promise<Array<{from: PeerId, val: Buffer}>>} // TODO structure docs
   */
  async getMany (key, nvals, options = {}) {
    options.timeout = options.timeout || c.minute

    this._log('getMany %b (%s)', key, nvals)

    let vals = []
    let localRec

    // TODO: should we remove this logic?
    try {
      localRec = await this._getLocal(key)
    } catch (err) {
      if (nvals === 0) {
        throw err
      }
    }

    // TODO: should we remove this logic?
    if (localRec) {
      vals.push({
        val: localRec.value,
        from: this.peerInfo.id
      })
    }

    if (vals.length >= nvals) {
      return vals
    }

    const paths = []
    const id = await utils.convertBuffer(key)
    const rtp = this.routingTable.closestPeers(id, this.kBucketSize)

    this._log('peers in rt: %d', rtp.length)

    if (rtp.length === 0) {
      const errMsg = 'Failed to lookup key! No peers from routing table!'

      this._log.error(errMsg)
      throw errcode(new Error(errMsg), 'ERR_NO_PEERS_IN_ROUTING_TABLE')
    }

    // we have peers, lets do the actual query to them
    const query = new Query(this, key, (pathIndex, numPaths) => {
      // This function body runs once per disjoint path
      const pathSize = utils.pathSize(nvals - vals.length, numPaths)
      const pathVals = []
      paths.push(pathVals)

      // Here we return the query function to use on this particular disjoint path
      return async (peer) => {
        let rec, peers, lookupErr
        try {
          const results = await this._getValueOrPeers(peer, key)
          rec = results.record
          peers = results.peers
        } catch (err) {
          // If we have an invalid record we just want to continue and fetch a new one.
          if (err.code !== 'ERR_INVALID_RECORD') {
            throw err
          }
          lookupErr = err
        }

        const res = { closerPeers: peers }

        if ((rec && rec.value) || lookupErr) {
          pathVals.push({
            val: rec && rec.value,
            from: peer
          })
        }

        // enough is enough
        if (pathVals.length >= pathSize) {
          res.pathComplete = true
        }

        return res
      }
    })

    let error
    try {
      await pTimeout(query.run(rtp), options.timeout)
    } catch (err) {
      error = err
    }
    query.stop()

    // combine vals from each path
    vals = [].concat.apply(vals, paths).slice(0, nvals)

    if (error && vals.length === 0) {
      throw error
    }

    return vals
  }

  /**
   * Kademlia 'node lookup' operation.
   *
   * @param {Buffer} key
   * @param {Object} [options]
   * @param {boolean} [options.shallow] shallow query (default: false)
   * @returns {Promise<Array<PeerId>>}
   */
  async getClosestPeers (key, options = { shallow: false }) {
    this._log('getClosestPeers to %b', key)

    const id = await utils.convertBuffer(key)
    const tablePeers = this.routingTable.closestPeers(id, this.kBucketSize)

    const q = new Query(this, key, () => {
      // There is no distinction between the disjoint paths,
      // so there are no per-path variables in this scope.
      // Just return the actual query function.
      return async (peer) => {
        const closer = await this._closerPeersSingle(key, peer)

        return {
          closerPeers: closer,
          pathComplete: options.shallow ? true : undefined
        }
      }
    })

    const res = await q.run(tablePeers)
    if (!res || !res.finalSet) {
      return []
    }

    const sorted = await utils.sortClosestPeers(Array.from(res.finalSet), id)
    return sorted.slice(0, this.kBucketSize)
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
    let pk
    try {
      pk = await this._getPublicKeyFromNode(peer)
    } catch (err) {
      // try dht directly
      const pkKey = utils.keyForPublicKey(peer)
      const value = await this.get(pkKey)
      pk = crypto.unmarshalPublicKey(value)
    }

    info.id = new PeerId(peer.id, null, pk)
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
   * @returns {Promise<void>}
   */
  async provide (key) {
    this._log('provide: %s', key.toBaseEncodedString())

    const errors = []

    // Add peer as provider
    await this.providers.addProvider(key, this.peerInfo.id)

    // Notice closest peers
    const peers = await this.getClosestPeers(key.buffer)
    const msg = new Message(Message.TYPES.ADD_PROVIDER, key.buffer, 0)
    msg.providerPeers = [this.peerInfo]

    await Promise.all(peers.map(async (peer) => {
      this._log('putProvider %s to %s', key.toBaseEncodedString(), peer.toB58String())
      try {
        await promisify(cb => this.network.sendMessage(peer, msg, cb))()
      } catch (err) {
        errors.push(err)
      }
    }))

    if (errors.length) {
      // TODO:
      // This should be infrequent. This means a peer we previously connected
      // to failed to exchange the provide message. If getClosestPeers was an
      // iterator, we could continue to pull until we announce to kBucketSize peers.
      throw errcode(`Failed to provide to ${errors.length} of ${this.kBucketSize} peers`, 'ERR_SOME_PROVIDES_FAILED', { errors })
    }
  }

  /**
   * Search the dht for up to `K` providers of the given CID.
   *
   * @param {CID} key
   * @param {Object} options - findProviders options
   * @param {number} options.timeout - how long the query should maximally run, in milliseconds (default: 60000)
   * @param {number} options.maxNumProviders - maximum number of providers to find
   * @returns {Promise<PeerInfo>}
   */
  findProviders (key, options = {}) {
    options.timeout = options.timeout || c.minute
    options.maxNumProviders = options.maxNumProviders || c.K

    this._log('findProviders %s', key.toBaseEncodedString())
    return this._findNProviders(key, options.timeout, options.maxNumProviders)
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
    options.timeout = options.timeout || c.minute
    this._log('findPeer %s', id.toB58String())

    // Try to find locally
    const pi = await this.findPeerLocal(id)

    // already got it
    if (pi != null) {
      this._log('found local')
      return pi
    }

    const key = await utils.convertPeerId(id)
    const peers = this.routingTable.closestPeers(key, this.kBucketSize)

    if (peers.length === 0) {
      throw errcode(new Error('Peer lookup failed'), 'ERR_LOOKUP_FAILED')
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
        const msg = await this._findPeerSingle(peer, id) // TODO: change
        const match = msg.closerPeers.find((p) => p.id.isEqual(id))

        // found it
        if (match) {
          return {
            peer: match,
            queryComplete: true
          }
        }

        return {
          closerPeers: msg.closerPeers
        }
      }
    })

    let error, result
    try {
      result = await pTimeout(query.run(peers), options.timeout)
    } catch (err) {
      error = err
    }
    query.stop()
    if (error) throw error

    let success = false
    result.paths.forEach((result) => {
      if (result.success) {
        success = true
        this.peerBook.put(result.peer)
      }
    })
    this._log('findPeer %s: %s', id.toB58String(), success)

    if (!success) {
      throw errcode(new Error('No peer found'), 'ERR_NOT_FOUND')
    }
    return this.peerBook.get(id)
  }

  _peerDiscovered (peerInfo) {
    this.emit('peer', peerInfo)
  }
}

module.exports = KadDHT
