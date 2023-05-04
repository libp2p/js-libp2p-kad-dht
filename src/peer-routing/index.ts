import { keys } from '@libp2p/crypto'
import { CodeError } from '@libp2p/interfaces/errors'
import { logger } from '@libp2p/logger'
import { peerIdFromKeys } from '@libp2p/peer-id'
import { Libp2pRecord } from '@libp2p/record'
import { verifyRecord } from '@libp2p/record/validators'
import { toString as uint8ArrayToString } from 'uint8arrays/to-string'
import { Message, MESSAGE_TYPE } from '../message/index.js'
import { PeerDistanceList } from '../peer-list/peer-distance-list.js'
import {
  queryErrorEvent,
  finalPeerEvent,
  valueEvent
} from '../query/events.js'
import * as utils from '../utils.js'
import type { KadDHTComponents, DHTRecord, DialingPeerEvent, FinalPeerEvent, QueryEvent, Validators } from '../index.js'
import type { Network } from '../network.js'
import type { QueryManager, QueryOptions } from '../query/manager.js'
import type { QueryFunc } from '../query/types.js'
import type { RoutingTable } from '../routing-table/index.js'
import type { PeerId } from '@libp2p/interface-peer-id'
import type { PeerInfo } from '@libp2p/interface-peer-info'
import type { AbortOptions } from '@libp2p/interfaces'
import type { Logger } from '@libp2p/logger'

export interface PeerRoutingInit {
  routingTable: RoutingTable
  network: Network
  validators: Validators
  queryManager: QueryManager
  lan: boolean
}

export class PeerRouting {
  private readonly components: KadDHTComponents
  private readonly log: Logger
  private readonly routingTable: RoutingTable
  private readonly network: Network
  private readonly validators: Validators
  private readonly queryManager: QueryManager

  constructor (components: KadDHTComponents, init: PeerRoutingInit) {
    const { routingTable, network, validators, queryManager, lan } = init

    this.components = components
    this.routingTable = routingTable
    this.network = network
    this.validators = validators
    this.queryManager = queryManager
    this.log = logger(`libp2p:kad-dht:${lan ? 'lan' : 'wan'}:peer-routing`)
  }

  /**
   * Look if we are connected to a peer with the given id.
   * Returns its id and addresses, if found, otherwise `undefined`.
   */
  async findPeerLocal (peer: PeerId): Promise<PeerInfo | undefined> {
    let peerData
    const p = await this.routingTable.find(peer)

    if (p != null) {
      this.log('findPeerLocal found %p in routing table', peer)

      try {
        peerData = await this.components.peerStore.get(p)
      } catch (err: any) {
        if (err.code !== 'ERR_NOT_FOUND') {
          throw err
        }
      }
    }

    if (peerData == null) {
      try {
        peerData = await this.components.peerStore.get(peer)
      } catch (err: any) {
        if (err.code !== 'ERR_NOT_FOUND') {
          throw err
        }
      }
    }

    if (peerData != null) {
      this.log('findPeerLocal found %p in peer store', peer)

      return {
        id: peerData.id,
        multiaddrs: peerData.addresses.map((address) => address.multiaddr),
        protocols: []
      }
    }

    return undefined
  }

  /**
   * Get a value via rpc call for the given parameters
   */
  async * _getValueSingle (peer: PeerId, key: Uint8Array, options: AbortOptions = {}): AsyncGenerator<QueryEvent> {
    const msg = new Message(MESSAGE_TYPE.GET_VALUE, key, 0)
    yield * this.network.sendRequest(peer, msg, options)
  }

  /**
   * Get the public key directly from a node
   */
  async * getPublicKeyFromNode (peer: PeerId, options: AbortOptions = {}): AsyncGenerator<QueryEvent> {
    const pkKey = utils.keyForPublicKey(peer)

    for await (const event of this._getValueSingle(peer, pkKey, options)) {
      yield event

      if (event.name === 'PEER_RESPONSE' && event.record != null) {
        const recPeer = await peerIdFromKeys(keys.marshalPublicKey({ bytes: event.record.value }))

        // compare hashes of the pub key
        if (!recPeer.equals(peer)) {
          throw new CodeError('public key does not match id', 'ERR_PUBLIC_KEY_DOES_NOT_MATCH_ID')
        }

        if (recPeer.publicKey == null) {
          throw new CodeError('public key missing', 'ERR_PUBLIC_KEY_MISSING')
        }

        yield valueEvent({ from: peer, value: recPeer.publicKey })
      }
    }

    throw new CodeError(`Node not responding with its public key: ${peer.toString()}`, 'ERR_INVALID_RECORD')
  }

  /**
   * Search for a peer with the given ID
   */
  async * findPeer (id: PeerId, options: QueryOptions = {}): AsyncGenerator<FinalPeerEvent | QueryEvent> {
    this.log('findPeer %p', id)

    // Try to find locally
    const pi = await this.findPeerLocal(id)

    // already got it
    if (pi != null) {
      this.log('found local')
      yield finalPeerEvent({
        from: this.components.peerId,
        peer: pi
      })
      return
    }

    const key = await utils.convertPeerId(id)
    const peers = this.routingTable.closestPeers(key)

    // sanity check
    const match = peers.find((p) => p.equals(id))

    if (match != null) {
      try {
        const peer = await this.components.peerStore.get(id)

        this.log('found in peerStore')
        yield finalPeerEvent({
          from: this.components.peerId,
          peer: {
            id: peer.id,
            multiaddrs: peer.addresses.map((address) => address.multiaddr),
            protocols: []
          }
        })

        return
      } catch (err: any) {
        if (err.code !== 'ERR_NOT_FOUND') {
          throw err
        }
      }
    }

    const self = this // eslint-disable-line @typescript-eslint/no-this-alias

    const findPeerQuery: QueryFunc = async function * ({ peer, signal }) {
      const request = new Message(MESSAGE_TYPE.FIND_NODE, id.toBytes(), 0)

      for await (const event of self.network.sendRequest(peer, request, { signal })) {
        yield event

        if (event.name === 'PEER_RESPONSE') {
          const match = event.closer.find((p) => p.id.equals(id))

          // found the peer
          if (match != null) {
            yield finalPeerEvent({ from: event.from, peer: match })
          }
        }
      }
    }

    let foundPeer = false

    for await (const event of this.queryManager.run(id.toBytes(), peers, findPeerQuery, options)) {
      if (event.name === 'FINAL_PEER') {
        foundPeer = true
      }

      yield event
    }

    if (!foundPeer) {
      yield queryErrorEvent({ from: this.components.peerId, error: new CodeError('Not found', 'ERR_NOT_FOUND') })
    }
  }

  /**
   * Kademlia 'node lookup' operation on a key, which could be a the
   * bytes from a multihash or a peer ID
   */
  async * getClosestPeers (key: Uint8Array, options: QueryOptions = {}): AsyncGenerator<DialingPeerEvent | QueryEvent> {
    this.log('getClosestPeers to %b', key)
    const id = await utils.convertBuffer(key)
    const tablePeers = this.routingTable.closestPeers(id)
    const self = this // eslint-disable-line @typescript-eslint/no-this-alias

    const peers = new PeerDistanceList(id, this.routingTable.kBucketSize)
    await Promise.all(tablePeers.map(async peer => { await peers.add(peer) }))

    const getCloserPeersQuery: QueryFunc = async function * ({ peer, signal }) {
      self.log('closerPeersSingle %s from %p', uint8ArrayToString(key, 'base32'), peer)
      const request = new Message(MESSAGE_TYPE.FIND_NODE, key, 0)

      yield * self.network.sendRequest(peer, request, { signal })
    }

    for await (const event of this.queryManager.run(key, tablePeers, getCloserPeersQuery, options)) {
      yield event

      if (event.name === 'PEER_RESPONSE') {
        await Promise.all(event.closer.map(async peerData => { await peers.add(peerData.id) }))
      }
    }

    this.log('found %d peers close to %b', peers.length, key)

    for (const peerId of peers.peers) {
      try {
        const peer = await this.components.peerStore.get(peerId)

        yield finalPeerEvent({
          from: this.components.peerId,
          peer: {
            id: peerId,
            multiaddrs: peer.addresses.map(({ multiaddr }) => multiaddr),
            protocols: peer.protocols
          }
        })
      } catch (err: any) {
        if (err.code !== 'ERR_NOT_FOUND') {
          throw err
        }
      }
    }
  }

  /**
   * Query a particular peer for the value for the given key.
   * It will either return the value or a list of closer peers.
   *
   * Note: The peerStore is updated with new addresses found for the given peer.
   */
  async * getValueOrPeers (peer: PeerId, key: Uint8Array, options: AbortOptions = {}): AsyncGenerator<DialingPeerEvent | QueryEvent> {
    for await (const event of this._getValueSingle(peer, key, options)) {
      if (event.name === 'PEER_RESPONSE') {
        if (event.record != null) {
          // We have a record
          try {
            await this._verifyRecordOnline(event.record)
          } catch (err: any) {
            const errMsg = 'invalid record received, discarded'
            this.log(errMsg)

            yield queryErrorEvent({ from: event.from, error: new CodeError(errMsg, 'ERR_INVALID_RECORD') })
            continue
          }
        }
      }

      yield event
    }
  }

  /**
   * Verify a record, fetching missing public keys from the network.
   * Throws an error if the record is invalid.
   */
  async _verifyRecordOnline (record: DHTRecord): Promise<void> {
    if (record.timeReceived == null) {
      throw new CodeError('invalid record received', 'ERR_INVALID_RECORD')
    }

    await verifyRecord(this.validators, new Libp2pRecord(record.key, record.value, record.timeReceived))
  }

  /**
   * Get the nearest peers to the given query, but if closer
   * than self
   */
  async getCloserPeersOffline (key: Uint8Array, closerThan: PeerId): Promise<PeerInfo[]> {
    const id = await utils.convertBuffer(key)
    const ids = this.routingTable.closestPeers(id)
    const output: PeerInfo[] = []

    for (const peerId of ids) {
      if (peerId.equals(closerThan)) {
        continue
      }

      try {
        const peer = await this.components.peerStore.get(peerId)

        output.push({
          id: peerId,
          multiaddrs: peer.addresses.map(({ multiaddr }) => multiaddr),
          protocols: peer.protocols
        })
      } catch (err: any) {
        if (err.code !== 'ERR_NOT_FOUND') {
          throw err
        }
      }
    }

    if (output.length > 0) {
      this.log('getCloserPeersOffline found %d peer(s) closer to %b than %p', output.length, key, closerThan)
    } else {
      this.log('getCloserPeersOffline could not find peer closer to %b than %p', key, closerThan)
    }

    return output
  }
}
