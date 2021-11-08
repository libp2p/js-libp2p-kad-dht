import type PeerId from 'peer-id'
import type { Multiaddr } from 'multiaddr'
import type { CID } from 'multiformats/cid'
import type { MuxedStream } from 'libp2p/src/upgrader'
import type Topology from 'libp2p-interfaces/src/topology'
import type Record from 'libp2p-record/dist/src/record/index'
import type { PublicKey } from 'libp2p-crypto'
import type { Message } from './message/dht'

export enum EventTypes {
  SendingQuery = 0,
  PeerResponse,
  FinalPeer,
  QueryError,
  Provider,
  Value,
  AddingPeer,
  DialingPeer
}

export interface PeerData {
  id: PeerId
  multiaddrs: Multiaddr[]
}

export interface DHTValue {
  value: Uint8Array
  from: PeerId
}

export interface AbortOptions {
  signal?: AbortSignal
}

export interface QueryOptions extends AbortOptions {
  queryFuncTimeout?: number
}

/**
 * Emitted when sending queries to remote peers
 */
export interface SendingQueryEvent {
  to: PeerId
  type: EventTypes.SendingQuery
  name: 'sendingQuery'
  message: string
  messageType: number
}

/**
 * Emitted when query responses are received form remote peers.  Depending on the query
 * these events may be followed by a `FinalPeerEvent`, a `ValueEvent` or a `ProviderEvent`.
 */
export interface PeerResponseEvent {
  from: PeerId
  type: EventTypes.PeerResponse
  name: 'peerResponse'
  messageType: Message.MessageType
  closer: PeerData[]
  providers: PeerData[]
  record?: Record
}

/**
 * Emitted at the end of a `findPeer` query
 */
export interface FinalPeerEvent {
  from: PeerId
  peer: PeerData
  type: EventTypes.FinalPeer
  name: 'finalPeer'
}

/**
 * Something went wrong with the query
 */
export interface QueryErrorEvent {
  from: PeerId
  type: EventTypes.QueryError
  name: 'queryError'
  error: Error
}

/**
 * Emitted when providers are found
 */
export interface ProviderEvent {
  from: PeerId
  type: EventTypes.Provider
  name: 'provider'
  providers: PeerData[]
}

/**
 * Emitted when values are found
 */
export interface ValueEvent {
  from: PeerId
  type: EventTypes.Value
  name: 'value'
  value: Uint8Array
}

/**
 * Emitted when peers are added to a query
 */
export interface AddingPeerEvent {
  type: EventTypes.AddingPeer
  name: 'addingPeer'
  peer: PeerId
}

/**
 * Emitted when peers are dialled as part of a query
 */
export interface DialingPeerEvent {
  peer: PeerId
  type: EventTypes.DialingPeer
  name: 'dialingPeer'
}

export type QueryEvent = SendingQueryEvent | PeerResponseEvent | FinalPeerEvent | QueryErrorEvent | ProviderEvent | ValueEvent | AddingPeerEvent | DialingPeerEvent

export interface DHT {
  // query/client methods

  /**
   * Get a value from the DHT, the final ValueEvent will be the best value
   */
  get: (key: Uint8Array, options?: QueryOptions) => AsyncIterable<QueryEvent>
  findProviders: (key: CID, options?: QueryOptions) => AsyncIterable<QueryEvent>
  findPeer: (id: PeerId, options?: QueryOptions) => AsyncIterable<QueryEvent>
  getClosestPeers: (key: Uint8Array, options?: QueryOptions) => AsyncIterable<QueryEvent>
  getPublicKey: (peer: PeerId, options?: QueryOptions) => Promise<PublicKey>

  // publish/server methods
  provide: (key: CID, options?: QueryOptions) => AsyncIterable<QueryEvent>
  put: (key: Uint8Array, value: Uint8Array, options?: QueryOptions) => AsyncIterable<QueryEvent>

  // enable/disable publishing
  enableServerMode: () => void
  enableClientMode: () => void

  // housekeeping
  removeLocal: (key: Uint8Array) => Promise<void>

  // events
  on: (event: 'peer', handler: (peerData: PeerData) => void) => this
}

// Implemented by libp2p, should be moved to libp2p-interfaces eventually
export interface Dialer {
  dialProtocol: (peer: PeerId, protocol: string, options?: { signal?: AbortSignal }) => Promise<{ stream: MuxedStream }>
}

// Implemented by libp2p, should be moved to libp2p-interfaces eventually
export interface Addressable {
  multiaddrs: Multiaddr[]
}

// Implemented by libp2p.registrar, should be moved to libp2p-interfaces eventually
export interface Registrar {
  register: (topology: Topology) => string
  unregister: (id: string) => boolean
}

// Implemented by libp2p.peerStore, should be moved to libp2p-interfaces eventually
export interface PeerStore {
  addressBook: AddressBook
  get: (peerId: PeerId) => { id: PeerId, addresses: Array<{ multiaddr: Multiaddr }> } | undefined
}

// Implemented by libp2p.peerStore.addressStore, should be moved to libp2p-interfaces eventually
export interface AddressBook {
  add: (peerId: PeerId, addresses: Multiaddr[]) => void
  get: (peerId: PeerId) => Array<{ multiaddr: Multiaddr }> | undefined
}
