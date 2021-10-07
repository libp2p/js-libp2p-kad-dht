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
    log(`findPeerLocal ${peer.toB58String()}`)
    const p = await this._routingTable.find(peer)
    const peerData = p && this._peerStore.get(p)

    if (peerData) {
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
   * @param {AbortSignal} signal
   */
  async _getValueSingle (peer, key, signal) { // eslint-disable-line require-await
    const msg = new Message(Message.TYPES.GET_VALUE, key, 0)
    return this._network.sendRequest(peer, msg, signal)
  }

  /**
   * Find close peers for a given peer
   *
   * @param {Uint8Array} key
   * @param {PeerId} peer
   * @param {AbortSignal} signal
   */
  async closerPeersSingle (key, peer, signal) {
    log(`closerPeersSingle ${uint8ArrayToString(key, 'base32')} from ${peer.toB58String()}`)
    const msg = await this.findPeerSingle(peer, new PeerId(key), signal)

    return msg.closerPeers
      .filter((peerData) => !this._peerId.equals(peerData.id))
      .map((peerData) => {
        this._peerStore.addressBook.add(peerData.id, peerData.multiaddrs)

        return peerData.id
      })
  }

  /**
   * Get the public key directly from a node.
   *
   * @param {PeerId} peer
   * @param {AbortSignal} signal
   */
  async getPublicKeyFromNode (peer, signal) {
    const pkKey = utils.keyForPublicKey(peer)
    const msg = await this._getValueSingle(peer, pkKey, signal)

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
   * Ask peer `peer` if they know where the peer with id `target` is.
   *
   * @param {PeerId} peer
   * @param {PeerId} target
   * @param {AbortSignal} signal
   */
  async findPeerSingle (peer, target, signal) { // eslint-disable-line require-await
    log('findPeerSingle %s', peer.toB58String())
    const msg = new Message(Message.TYPES.FIND_NODE, target.id, 0)

    return this._network.sendRequest(peer, msg, signal)
  }

  /**
   * Search for a peer with the given ID.
   *
   * @param {PeerId} id
   * @param {AbortSignal} signal
   * @returns {Promise<{ id: PeerId, multiaddrs: Multiaddr[] } | undefined>}
   */
  async findPeer (id, signal) {
    log('findPeer %s', id.toB58String())

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
     * There is no distinction between the disjoint paths, so there are no per-path
     * variables in dht scope. Just return the actual query function.
     *
     * @type {import('../types').QueryFunc<{ id: PeerId, multiaddrs: Multiaddr[] }>}
     */
    const findPeerQuery = async ({ peer, signal }) => {
      const msg = await this.findPeerSingle(peer, id, signal)
      const match = msg.closerPeers.find((p) => p.id.equals(id))

      // found it
      if (match) {
        return {
          done: true,
          value: match
        }
      }

      // query closer peers
      return {
        closerPeers: msg.closerPeers.map(peerData => peerData.id)
      }
    }

    for await (const result of this._queryManager.run(id.id, peers, findPeerQuery, signal)) {
      if (result.done && result.value) {
        return result.value
      }
    }

    throw errcode(new Error('No peer found'), 'ERR_NOT_FOUND')
  }

  /**
   * Kademlia 'node lookup' operation
   *
   * @param {Uint8Array} key
   * @param {AbortSignal} signal
   * @param {object} [options]
   * @param {boolean} [options.shallow=false] - shallow query
   */
  async * getClosestPeers (key, signal, options = { shallow: false }) {
    log('getClosestPeers to %b', key)
    const { shallow } = options
    const id = await utils.convertBuffer(key)
    const tablePeers = this._routingTable.closestPeers(id)

    /**
     * There is no distinction between the disjoint paths,
     * so there are no per-path variables in dht scope.
     * Just return the actual query function.
     *
     * @type {import('../types').QueryFunc<PeerId[]>}
     */
    const getCloserPeersQuery = async ({ peer, signal }) => {
      const closer = await this.closerPeersSingle(key, peer, signal)

      return {
        closerPeers: closer,
        value: closer,
        done: (shallow || !closer.length) ? true : undefined
      }
    }

    for await (const result of this._queryManager.run(key, tablePeers, getCloserPeersQuery, signal)) {
      if (result.value) {
        yield * result.value
      }
    }
  }

  /**
   * Store the given key/value pair at the peer `target`.
   *
   * @param {Uint8Array} key
   * @param {Uint8Array} rec - encoded record
   * @param {PeerId} target
   * @param {AbortSignal} signal
   */
  async putValueToPeer (key, rec, target, signal) {
    const msg = new Message(Message.TYPES.PUT_VALUE, key, 0)
    msg.record = Record.deserialize(rec)

    const resp = await this._network.sendRequest(target, msg, signal)

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
   * @param {AbortSignal} signal
   */
  async getValueOrPeers (peer, key, signal) {
    const msg = await this._getValueSingle(peer, key, signal)

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
    log('betterPeersToQuery')
    const ids = this._routingTable.closestPeers(await utils.convertBuffer(key))

    return ids
      .map((p) => {
        const peer = this._peerStore.get(p)

        return {
          id: p,
          multiaddrs: peer ? peer.addresses.map((address) => address.multiaddr) : []
        }
      })
      .filter((closer) => !closer.id.equals(closerThan))
  }
}

module.exports.PeerRouting = PeerRouting
