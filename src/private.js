'use strict'

const PeerId = require('peer-id')
const libp2pRecord = require('libp2p-record')
const PeerInfo = require('peer-info')
const { collect } = require('streaming-iterables')

const errcode = require('err-code')

const utils = require('./utils')
const Message = require('./message')
const c = require('./constants')
const Query = require('./query')
const LimitedPeerSet = require('./limited-peer-set')

const Record = libp2pRecord.Record

module.exports = (dht) => ({
  /**
   * Returns the routing tables closest peers, for the key of
   * the message.
   *
   * @param {Message} msg
   * @returns {Promise<Array<PeerInfo>>}
   * @private
   */
  async _nearestPeersToQuery (msg) {
    const key = await utils.convertBuffer(msg.key)

    const ids = dht.routingTable.closestPeers(key, dht.ncp)
    return ids.map((p) => {
      if (dht.peerBook.has(p)) {
        return dht.peerBook.get(p)
      }
      return dht.peerBook.put(new PeerInfo(p))
    })
  },

  /**
   * Get the nearest peers to the given query, but iff closer
   * than self.
   *
   * @param {Message} msg
   * @param {PeerInfo} peer
   * @returns {Promise<Array<PeerInfo>>}
   * @private
   */
  async _betterPeersToQuery (msg, peer) {
    dht._log('betterPeersToQuery')
    const closer = await dht._nearestPeersToQuery(msg)

    return closer.filter((closer) => {
      if (dht._isSelf(closer.id)) {
        // Should bail, not sure
        dht._log.error('trying to return self as closer')
        return false
      }

      return !closer.id.isEqual(peer.id)
    })
  },

  /**
   * Try to fetch a given record from the local datastore.
   * Returns the record iff it is still valid, meaning
   * - it was either authored by this node, or
   * - it was receceived less than `MAX_RECORD_AGE` ago.
   *
   * @param {Buffer} key
   * @returns {Promise<Record>}
   *
   * @private
   */
  async _checkLocalDatastore (key) {
    dht._log('checkLocalDatastore: %b', key)
    const dsKey = utils.bufferToKey(key)

    // Fetch value from ds
    let rawRecord
    try {
      rawRecord = await dht.datastore.get(dsKey)
    } catch (err) {
      if (err.code === 'ERR_NOT_FOUND') {
        return undefined
      }
      throw err
    }

    // Create record from the returned bytes
    const record = Record.deserialize(rawRecord)

    if (!record) {
      throw errcode('Invalid record', 'ERR_INVALID_RECORD')
    }

    // Check validity: compare time received with max record age
    if (record.timeReceived == null ||
        utils.now() - record.timeReceived > c.MAX_RECORD_AGE) {
      // If record is bad delete it and return
      await dht.datastore.delete(dsKey)
      return undefined
    }

    // Record is valid
    return record
  },

  /**
   * Add the peer to the routing table and update it in the peerbook.
   *
   * @param {PeerInfo} peer
   * @returns {Promise}
   *
   * @private
   */
  _add (peer) {
    peer = dht.peerBook.put(peer)
    return dht.routingTable.add(peer.id)
  },

  /**
   * Verify a record without searching the DHT.
   * Returns a Promise that will reject if the record is invalid.
   *
   * @param {Record} record
   * @returns {Promise}
   *
   * @private
   */
  _verifyRecordLocally (record) {
    dht._log('verifyRecordLocally')
    return libp2pRecord.validator.verifyRecord(
      dht.validators,
      record
    )
  },

  /**
   * Find close peers for a given peer
   *
   * @param {Buffer} key
   * @param {PeerId} peer
   * @returns {Promise}
   *
   * @private
   */
  async _closerPeersSingle (key, peer) {
    dht._log('_closerPeersSingle %b from %s', key, peer.toB58String())
    const msg = await dht._findPeerSingle(peer, new PeerId(key))
    return msg.closerPeers
      .filter((pInfo) => !dht._isSelf(pInfo.id))
      .map((pInfo) => dht.peerBook.put(pInfo))
  },

  /**
   * Is the given peer id the peer id?
   *
   * @param {PeerId} other
   * @returns {bool}
   *
   * @private
   */
  _isSelf (other) {
    return other && dht.peerInfo.id.id.equals(other.id)
  },

  /**
   * Ask peer `peer` if they know where the peer with id `target` is.
   *
   * @param {PeerId} peer
   * @param {PeerId} target
   * @returns {Promise}
   *
   * @private
   */
  _findPeerSingle (peer, target) {
    dht._log('_findPeerSingle %s', peer.toB58String())
    const msg = new Message(Message.TYPES.FIND_NODE, target.id, 0)
    return dht.network.sendRequest(peer, msg)
  },

  /**
   * Store the given key/value pair at the peer `target`.
   *
   * @param {Buffer} key
   * @param {Buffer} rec - encoded record
   * @param {PeerId} target
   * @returns {Promise}
   *
   * @private
   */
  async _putValueToPeer (key, rec, target) {
    const msg = new Message(Message.TYPES.PUT_VALUE, key, 0)
    msg.record = rec

    const resp = await dht.network.sendRequest(target, msg)

    if (!resp.record.value.equals(Record.deserialize(rec).value)) {
      throw errcode('value not put correctly', 'ERR_PUT_VALUE_INVALID')
    }
  },

  /**
   * Store the given key/value pair locally, in the datastore.
   * @param {Buffer} key
   * @param {Buffer} rec - encoded record
   * @returns {Promise}
   *
   * @private
   */
  _putLocal (key, rec) {
    return dht.datastore.put(utils.bufferToKey(key), rec)
  },

  /**
   * Get the value for the given key.
   *
   * @param {Buffer} key
   * @param {Object} options - get options
   * @param {number} options.timeout - optional timeout (default: 60000)
   * @returns {Promise<Record>}
   *
   * @private
   */
  async _get (key, options) {
    dht._log('_get %b', key)
    const vals = await collect(dht.getMany(key, c.GET_MANY_RECORD_COUNT, options))

    const recs = vals.map((v) => v.val)
    let i = 0

    try {
      i = libp2pRecord.selection.bestRecord(dht.selectors, key, recs)
    } catch (err) {
      // Assume the first record if no selector available
      if (err.code !== 'ERR_NO_SELECTOR_FUNCTION_FOR_RECORD_KEY') {
        throw err
      }
    }

    const best = recs[i]
    dht._log('GetValue %b %s', key, best)

    if (!best) {
      throw errcode('best value was not found', 'ERR_NOT_FOUND')
    }

    await this._sendCorrectionRecord(key, vals, best)

    return best
  },

  /**
   * Send the best record found to any peers that have an out of date record.
   *
   * @param {Buffer} key
   * @param {Array<Object>} vals - values retrieved from the DHT
   * @param {Object} best - the best record that was found
   * @returns {Promise}
   *
   * @private
   */
  async _sendCorrectionRecord (key, vals, best) {
    const fixupRec = utils.createPutRecord(key, best)

    return Promise.all(vals.map((v) => {
      // no need to do anything
      if (v.val.equals(best)) {
        return
      }

      // correct ourself
      if (dht._isSelf(v.from)) {
        try {
          return dht._putLocal(key, fixupRec)
        } catch (err) {
          dht._log.error('Failed error correcting self', err)
          return
        }
      }

      // send correction
      try {
        return dht._putValueToPeer(key, fixupRec, v.from)
      } catch (err) {
        dht._log.error('Failed error correcting entry', err)
      }
    }))
  },

  /**
   * Attempt to retrieve the value for the given key from
   * the local datastore.
   *
   * @param {Buffer} key
   * @returns {Promise<Record>}
   *
   * @private
   */
  async _getLocal (key) {
    dht._log('getLocal %b', key)

    const raw = await dht.datastore.get(utils.bufferToKey(key))

    dht._log('found %b in local datastore', key)
    const rec = Record.deserialize(raw)

    await dht._verifyRecordLocally(rec)
    return rec
  },

  /**
   * Object containing a value or a list of closer peers.
   * @typedef {Object} ValueOrPeers
   * @property {Record} record - the record at the key
   * @property {Array<PeerInfo>} peers - list of closer peers
   */

  /**
   * Query a particular peer for the value for the given key.
   * It will either return the value or a list of closer peers.
   *
   * Note: The peerbook is updated with new addresses found for the given peer.
   *
   * @param {PeerId} peer
   * @param {Buffer} key
   * @returns {Promise<ValueOrPeers>}
   *
   * @private
   */
  async _getValueOrPeers (peer, key) {
    const msg = await dht._getValueSingle(peer, key)

    const peers = msg.closerPeers
    const record = msg.record

    if (record) {
      // We have a record
      try {
        await dht._verifyRecordOnline(record)
      } catch (err) {
        const errMsg = 'invalid record received, discarded'

        dht._log(errMsg)
        throw errcode(errMsg, 'ERR_INVALID_RECORD')
      }

      return { record, peers }
    }

    if (peers.length > 0) {
      return { peers }
    }

    throw errcode('Not found', 'ERR_NOT_FOUND')
  },

  /**
   * Get a value via rpc call for the given parameters.
   *
   * @param {PeerId} peer
   * @param {Buffer} key
   * @returns {Promise<Message>}
   *
   * @private
   */
  _getValueSingle (peer, key) {
    const msg = new Message(Message.TYPES.GET_VALUE, key, 0)
    return dht.network.sendRequest(peer, msg)
  },

  /**
   * Verify a record, fetching missing public keys from the network.
   * Calls back with an error if the record is invalid.
   *
   * @param {Record} record
   * @returns {Promise}
   *
   * @private
   */
  _verifyRecordOnline (record) {
    return libp2pRecord.validator.verifyRecord(dht.validators, record)
  },

  /**
   * Get the public key directly from a node.
   *
   * @param {PeerId} peer
   * @returns {Promise<PublicKey>}
   *
   * @private
   */
  async _getPublicKeyFromNode (peer) {
    const pkKey = utils.keyForPublicKey(peer)

    const msg = await dht._getValueSingle(peer, pkKey)

    if (!msg.record || !msg.record.value) {
      throw errcode(`Node not responding with its public key: ${peer.toB58String()}`, 'ERR_INVALID_RECORD')
    }

    const recPeer = await PeerId.createFromPubKey(msg.record.value)

    // compare hashes of the pub key
    if (!recPeer.isEqual(peer)) {
      throw errcode('public key does not match id', 'ERR_PUBLIC_KEY_DOES_NOT_MATCH_ID')
    }

    return recPeer.pubKey
  },

  /**
   * Search the dht for up to `n` providers of the given CID.
   *
   * @param {CID} key
   * @param {number} providerTimeout - How long the query should maximally run in milliseconds.
   * @param {number} n
   * @returns {AsyncIterator<PeerInfo>}
   *
   * @private
   */
  async * _findNProviders (key, providerTimeout, n) {
    if (n === 0) {
      return
    }

    let out = new LimitedPeerSet(n)

    const provs = await dht.providers.getProviders(key)

    for (const id of provs) {
      let info
      if (dht.peerBook.has(id)) {
        info = dht.peerBook.get(id)
      } else {
        info = dht.peerBook.put(new PeerInfo(id))
      }
      if (!out.has(info)) {
        out.add(info)
        yield info
        if (out.size >= n) {
          return
        }
      }
    }

    // need more, query the network
    const query = new Query(dht, key.buffer, (pathIndex, numPaths) => {
      // This function body runs once per disjoint path.
      // Note: For S/Kademlia, We need to get peers from nvals disjoint paths
      // (not just nvals different peers)
      // eg 20 values from 8 paths = Math.ceiling(20 / 8) = 3 peers per path
      const pathSize = utils.pathSize(out.size - n, numPaths)
      const pathProviders = new LimitedPeerSet(pathSize)

      // Here we return the query function to use on this particular disjoint path
      return async (peer) => {
        const msg = await dht._findProvidersSingle(peer, key)

        const provs = msg.providerPeers
        dht._log('(%s) found %s provider entries', dht.peerInfo.id.toB58String(), provs.length)

        for (const prov of provs) {
          pathProviders.add(dht.peerBook.put(prov))
        }

        const res = {}
        if (provs.length) {
          res.value = provs
        }

        // We have enough values for this path so we're done
        if (pathProviders.size >= pathSize) {
          res.success = true
          return res
        }

        // We still need more
        res.closerPeers = msg.closerPeers
        return res
      }
    })

    const peers = dht.routingTable.closestPeers(key.buffer, c.ALPHA)

    try {
      for await (const res of query.run(peers, providerTimeout)) {
        for (const provider of res.value || []) {
          if (!out.has(provider)) {
            out.add(provider)
            yield provider
          }
          if (out.size >= n) {
            query.stop()
            return
          }
        }
      }
    } catch (err) {
      // Ignore timeout error if we have collected some records
      if (err && (err.code !== 'ETIMEDOUT' || out.size === 0)) {
        throw err
      }
    } finally {
      query.stop()
    }
  },

  /**
   * Check for providers from a single node.
   *
   * @param {PeerId} peer
   * @param {CID} key
   * @returns {Promise<Message>}
   *
   * @private
   */
  _findProvidersSingle (peer, key) {
    const msg = new Message(Message.TYPES.GET_PROVIDERS, key.buffer, 0)
    return dht.network.sendRequest(peer, msg)
  }
})
