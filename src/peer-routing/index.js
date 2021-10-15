'use strict'

const errcode = require('err-code')
const { validator } = require('libp2p-record')
const PeerId = require('peer-id')
const { toString: uint8ArrayToString } = require('uint8arrays/to-string')
const { Message } = require('../message')
const utils = require('../utils')
const {
  queryErrorEvent,
  finalPeerEvent,
  valueEvent
} = require('../query/events')
const PeerDistanceList = require('../peer-list/peer-distance-list')

const log = utils.logger('libp2p:kad-dht:peer-routing')

/**
 * @typedef {import('multiaddr').Multiaddr} Multiaddr
 * @typedef {import('../types').PeerData} PeerData
 */

class PeerRouting {
  /**
   * @param {import('peer-id')} peerId
   * @param {import('../routing-table').RoutingTable} routingTable
   * @param {import('../types').PeerStore} peerStore
   * @param {import('../network').Network} network
   * @param {import('libp2p-interfaces/src/types').DhtValidators} validators
   * @param {import('../query/manager').QueryManager} queryManager
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
  async * _getValueSingle (peer, key, options = {}) { // eslint-disable-line require-await
    const msg = new Message(Message.TYPES.GET_VALUE, key, 0)
    yield * this._network.sendRequest(peer, msg, options)
  }

  /**
   * Get the public key directly from a node.
   *
   * @param {PeerId} peer
   * @param {object} [options]
   * @param {AbortSignal} [options.signal]
   */
  async * getPublicKeyFromNode (peer, options) {
    const pkKey = utils.keyForPublicKey(peer)

    for await (const event of this._getValueSingle(peer, pkKey, options)) {
      yield event

      if (event.name === 'peerResponse' && event.response && event.response.record) {
        const recPeer = await PeerId.createFromPubKey(event.response.record.value)

        // compare hashes of the pub key
        if (!recPeer.equals(peer)) {
          throw errcode(new Error('public key does not match id'), 'ERR_PUBLIC_KEY_DOES_NOT_MATCH_ID')
        }

        yield valueEvent({ peer, value: recPeer.pubKey.bytes })
      }
    }

    throw errcode(new Error(`Node not responding with its public key: ${peer.toB58String()}`), 'ERR_INVALID_RECORD')
  }

  /**
   * Search for a peer with the given ID.
   *
   * @param {PeerId} id
   * @param {object} [options]
   * @param {AbortSignal} [options.signal]
   * @param {number} [options.queryFuncTimeout]
   */
  async * findPeer (id, options = {}) {
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

    const self = this

    /**
     * @type {import('../query/types').QueryFunc}
     */
    const findPeerQuery = async function * ({ peer, signal }) {
      const request = new Message(Message.TYPES.FIND_NODE, id.toBytes(), 0)

      for await (const event of self._network.sendRequest(peer, request, { signal })) {
        yield event

        if (event.name === 'peerResponse' && event.closerPeers) {
          const match = event.closerPeers.find((p) => p.id.equals(id))

          // found the peer
          if (match) {
            yield finalPeerEvent({ peer: match })
          }
        }
      }
    }

    let foundPeer = false

    for await (const event of this._queryManager.run(id.id, peers, findPeerQuery, options)) {
      if (event.name === 'finalPeer') {
        foundPeer = true
      }

      yield event
    }

    if (!foundPeer) {
      throw errcode(new Error('No peer found'), 'ERR_NOT_FOUND')
    }
  }

  /**
   * Kademlia 'node lookup' operation
   *
   * @param {Uint8Array} key - the key to look up, could be a the bytes from a multihash or a peer ID
   * @param {object} [options]
   * @param {AbortSignal} [options.signal]
   * @param {number} [options.queryFuncTimeout]
   */
  async * getClosestPeers (key, options = {}) {
    log('getClosestPeers to %b', key)
    const id = await utils.convertBuffer(key)
    const tablePeers = this._routingTable.closestPeers(id)
    const self = this

    const peers = new PeerDistanceList(id, this._routingTable._kBucketSize)
    tablePeers.forEach(peer => peers.add(peer))

    /**
     * @type {import('../query/types').QueryFunc}
     */
    const getCloserPeersQuery = async function * ({ peer, signal }) {
      log('closerPeersSingle %s from %p', uint8ArrayToString(key, 'base32'), peer)
      const request = new Message(Message.TYPES.FIND_NODE, key, 0)

      yield * self._network.sendRequest(peer, request, { signal })
    }

    for await (const event of this._queryManager.run(key, tablePeers, getCloserPeersQuery, options)) {
      yield event

      if (event.name === 'peerResponse' && event.closerPeers) {
        event.closerPeers.forEach(peerData => {
          peers.add(peerData.id)
        })
      }
    }

    log('found %d peers close to %b', peers.length, key)

    yield * peers.peers.map(peer => finalPeerEvent({
      peer: {
        id: peer,
        multiaddrs: (this._peerStore.addressBook.get(peer) || []).map(addr => addr.multiaddr)
      }
    }))
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
  async * getValueOrPeers (peer, key, options = {}) {
    let foundResponse

    for await (const event of this._getValueSingle(peer, key, options)) {
      if (event.name === 'peerResponse') {
        if (event.response && event.response.record) {
          // We have a record
          try {
            await this._verifyRecordOnline(event.response.record)
            foundResponse = true
          } catch (/** @type {any} */ err) {
            const errMsg = 'invalid record received, discarded'
            log(errMsg)

            yield queryErrorEvent({ peer, error: errcode(new Error(errMsg), 'ERR_INVALID_RECORD') })
            continue
          }
        }
      }

      yield event
    }

    if (!foundResponse) {
      throw errcode(new Error('Not found'), 'ERR_NOT_FOUND')
    }
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
