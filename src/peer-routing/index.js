'use strict'

const errcode = require('err-code')
const { Record, validator } = require('libp2p-record')
const PeerId = require('peer-id')
const { toString: uint8ArrayToString } = require('uint8arrays/to-string')
const { equals: uint8ArrayEquals } = require('uint8arrays/equals')
const { Message } = require('../message')
const utils = require('../utils')

const log = utils.logger('libp2p:kad-dht:peer-routing')

/**
 * @typedef {import('multiaddr').Multiaddr} Multiaddr
 */

/**
 * @param {import('../index')} dht
 */
class PeerRouting {
  /**
   * @param {import('peer-id')} peerId
   * @param {import('../routing-table').RoutingTable} routingTable
   * @param {import('../types').PeerStore} peerStore
   * @param {import('../network').Network} network
   * @param {import('libp2p-interfaces/src/types').DhtValidators} validators
   * @param {import('../query-manager').QueryManager} queryManager
   */
  constructor (peerId, routingTable, peerStore, network, validators, queryManager) {
    this._peerId = peerId
    this._routingTable = routingTable
    this._peerStore = peerStore
    this._network = network
    this._validators = validators
    this._queryManager = queryManager
  }

  /**
   * Look if we are connected to a peer with the given id.
   * Returns its id and addresses, if found, otherwise `undefined`.
   *
   * @param {PeerId} peer
   */
  async findPeerLocal (peer) {
    let peerData
    const p = await this._routingTable.find(peer)

    if (p) {
      log('findPeerLocal found %p in routing table', peer)
      peerData = this._peerStore.get(p)
    }

    if (!peerData) {
      peerData = this._peerStore.get(peer)
    }

    if (peerData) {
      log('findPeerLocal found %p in peer store', peer)

      return {
        id: peerData.id,
        multiaddrs: peerData.addresses.map((address) => address.multiaddr)
      }
    }
  }

  /**
   * Get a value via rpc call for the given parameters.
   *
   * @param {PeerId} peer
   * @param {Uint8Array} key
   * @param {object} [options]
   * @param {AbortSignal} [options.signal]
   */
  async _getValueSingle (peer, key, options = {}) { // eslint-disable-line require-await
    const msg = new Message(Message.TYPES.GET_VALUE, key, 0)
    return this._network.sendRequest(peer, msg, options)
  }

  /**
   * Find close peers for a given peer
   *
   * @param {Uint8Array} key
   * @param {PeerId} peer
   * @param {object} [options]
   * @param {AbortSignal} [options.signal]
   */
  async closerPeersSingle (key, peer, options = {}) {
    log('closerPeersSingle %s from %p', uint8ArrayToString(key, 'base32'), peer)
    const peers = await this.findPeerSingle(peer, key, options)

    return peers
      .filter((peer) => !this._peerId.equals(peer))
  }

  /**
   * Get the public key directly from a node.
   *
   * @param {PeerId} peer
   * @param {object} [options]
   * @param {AbortSignal} [options.signal]
   */
  async getPublicKeyFromNode (peer, options) {
    const pkKey = utils.keyForPublicKey(peer)
    const msg = await this._getValueSingle(peer, pkKey, options)

    if (!msg.record || !msg.record.value) {
      throw errcode(new Error(`Node not responding with its public key: ${peer.toB58String()}`), 'ERR_INVALID_RECORD')
    }

    const recPeer = await PeerId.createFromPubKey(msg.record.value)

    // compare hashes of the pub key
    if (!recPeer.equals(peer)) {
      throw errcode(new Error('public key does not match id'), 'ERR_PUBLIC_KEY_DOES_NOT_MATCH_ID')
    }

    return recPeer.pubKey
  }

  /**
   * Ask peer `peer` if they know where the peer with id `target` is
   *
   * @param {PeerId} peer
   * @param {Uint8Array} target
   * @param {object} [options]
   * @param {AbortSignal} [options.signal]
   */
  async findPeerSingle (peer, target, options = {}) { // eslint-disable-line require-await
    log('findPeerSingle asking %p if it knows %b', peer, target)
    const request = new Message(Message.TYPES.FIND_NODE, target, 0)
    const response = await this._network.sendRequest(peer, request, options)

    return response.closerPeers.map(peerData => peerData.id)
  }

  /**
   * Search for a peer with the given ID.
   *
   * @param {PeerId} id
   * @param {object} [options]
   * @param {AbortSignal} [options.signal]
   */
  async findPeer (id, options = {}) {
    log('findPeer %p', id)

    // Try to find locally
    const pi = await this.findPeerLocal(id)

    // already got it
    if (pi != null) {
      log('found local')
      return pi
    }

    const key = await utils.convertPeerId(id)
    const peers = this._routingTable.closestPeers(key)

    if (peers.length === 0) {
      throw errcode(new Error('Peer lookup failed'), 'ERR_LOOKUP_FAILED')
    }

    // sanity check
    const match = peers.find((p) => p.equals(id))
    if (match) {
      const peer = this._peerStore.get(id)

      if (peer) {
        log('found in peerStore')

        return {
          id: peer.id,
          multiaddrs: peer.addresses.map((address) => address.multiaddr)
        }
      }
    }

    /**
     * @type {import('../types').QueryFunc<PeerId>}
     */
    const findPeerQuery = async ({ peer, signal }) => {
      const peers = await this.findPeerSingle(peer, id.toBytes(), { signal })
      const match = peers.find((p) => p.equals(id))

      // found it
      if (match) {
        return {
          done: true,
          value: match
        }
      }

      // query closer peers
      return {
        closerPeers: peers
      }
    }

    for await (const result of this._queryManager.run(id.id, peers, findPeerQuery, options.signal)) {
      if (result.done && result.value) {
        const peerData = this._peerStore.get(result.value)

        if (peerData) {
          return {
            id: peerData.id,
            multiaddrs: peerData.addresses.map(addr => addr.multiaddr)
          }
        }
      }
    }

    throw errcode(new Error('No peer found'), 'ERR_NOT_FOUND')
  }

  /**
   * Kademlia 'node lookup' operation
   *
   * @param {Uint8Array} key
   * @param {object} [options]
   * @param {boolean} [options.shallow=false] - shallow query
   * @param {AbortSignal} [options.signal]
   */
  async * getClosestPeers (key, options = { shallow: false }) {
    log('getClosestPeers to %b', key)
    const { shallow } = options
    const id = await utils.convertBuffer(key)
    const tablePeers = this._routingTable.closestPeers(id)

    /**
     * @type {import('../types').QueryFunc<PeerId[]>}
     */
    const getCloserPeersQuery = async ({ peer, signal }) => {
      const closer = await this.closerPeersSingle(key, peer, { signal })

      if (shallow) {
        return {
          value: [peer, ...closer],
          done: true
        }
      }

      return {
        closerPeers: closer,
        value: closer
      }
    }

    const peers = new Set()

    for await (const result of this._queryManager.run(key, tablePeers, getCloserPeersQuery, options.signal)) {
      if (result.value) {
        for (const peer of result.value) {
          if (!peers.has(peer.toB58String())) {
            peers.add(peer.toB58String())
            log('peer %p was closer to %b', peer, key)
            yield peer
          }
        }
      }
    }

    log('found %d peers close to %b', peers.size, key)
  }

  /**
   * Store the given key/value pair at the peer `target`.
   *
   * @param {Uint8Array} key
   * @param {Uint8Array} rec - encoded record
   * @param {PeerId} target
   * @param {object} [options]
   * @param {AbortSignal} [options.signal]
   */
  async putValueToPeer (key, rec, target, options = {}) {
    const msg = new Message(Message.TYPES.PUT_VALUE, key, 0)
    msg.record = Record.deserialize(rec)

    const resp = await this._network.sendRequest(target, msg, options)

    if (resp.record && !uint8ArrayEquals(resp.record.value, Record.deserialize(rec).value)) {
      throw errcode(new Error('value not put correctly'), 'ERR_PUT_VALUE_INVALID')
    }
  }

  /**
   * Query a particular peer for the value for the given key.
   * It will either return the value or a list of closer peers.
   *
   * Note: The peerStore is updated with new addresses found for the given peer.
   *
   * @param {PeerId} peer
   * @param {Uint8Array} key
   * @param {object} [options]
   * @param {AbortSignal} [options.signal]
   */
  async getValueOrPeers (peer, key, options = {}) {
    const msg = await this._getValueSingle(peer, key, options)

    const peers = msg.closerPeers
    const record = msg.record

    if (record) {
      // We have a record
      try {
        await this._verifyRecordOnline(record)
      } catch (/** @type {any} */ err) {
        const errMsg = 'invalid record received, discarded'
        log(errMsg)
        throw errcode(new Error(errMsg), 'ERR_INVALID_RECORD')
      }

      return { record, peers }
    }

    if (peers.length > 0) {
      return { peers }
    }

    throw errcode(new Error('Not found'), 'ERR_NOT_FOUND')
  }

  /**
   * Verify a record, fetching missing public keys from the network.
   * Calls back with an error if the record is invalid.
   *
   * @param {import('libp2p-record').Record} record
   * @returns {Promise<void>}
   */
  async _verifyRecordOnline (record) {
    await validator.verifyRecord(this._validators, record)
  }

  /**
   * Get the nearest peers to the given query, but if closer
   * than self
   *
   * @param {Uint8Array} key
   * @param {PeerId} closerThan
   */
  async getCloserPeersOffline (key, closerThan) {
    const id = await utils.convertBuffer(key)
    const ids = this._routingTable.closestPeers(id)
    const output = ids
      .map((p) => {
        const peer = this._peerStore.get(p)

        return {
          id: p,
          multiaddrs: peer ? peer.addresses.map((address) => address.multiaddr) : []
        }
      })
      .filter((closer) => !closer.id.equals(closerThan))

    if (output.length) {
      log('getCloserPeersOffline found %d peer(s) closer to %b than %p', output.length, key, closerThan)
    } else {
      log('getCloserPeersOffline could not find peer closer to %b than %p', key, closerThan)
    }

    return output
  }
}

module.exports.PeerRouting = PeerRouting
