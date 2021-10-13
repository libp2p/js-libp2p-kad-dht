import type { EventEmitter } from 'events'
import type PeerId from 'peer-id'
import type { Multiaddr } from 'multiaddr'
import type { PublicKey } from 'libp2p-crypto'
import type { CID } from 'multiformats/cid'
import type { Message } from './message'
import type { MuxedStream } from 'libp2p/src/upgrader'
import type Topology from 'libp2p-interfaces/src/topology'

export interface PeerData {
  id: PeerId
  multiaddrs: Multiaddr[]
}

export interface QueryContinuationResult<T> {
  done?: false
  closerPeers?: PeerId[]
  value?: T
  err?: Error
}

export interface QueryTerminationResult<T> {
  done: true
  value?: T
  err?: Error
}

export type QueryResult<T> = QueryContinuationResult<T> | QueryTerminationResult<T>

export interface DHTValue {
  value: Uint8Array
  from: PeerId
}

export interface AbortOptions {
  signal?: AbortSignal
}

export interface QueryOptions {
  queryFuncTimeout?: number
  onQueryEvent?: QueryEventHandler
}

export interface QueryEventHandler { (evt: QueryEvent): void }

export interface SendingQueryEvent {
  peer: PeerId
  type: 0
  event: 'sendingQuery'
}

export interface PeerResponseEvent {
  peer: PeerId
  type: 1
  event: 'peerResponse'
  closerPeers: PeerData[]
}

export interface FinalPeerEvent {
  peer: PeerId
  type: 2
  event: 'finalPeer'
}

export interface QueryErrorEvent {
  peer: PeerId
  type: 3
  event: 'queryError'
  error: Error
}

export interface ProviderEvent {
  peer: PeerId
  type: 4
  event: 'provider'
  providerPeers: PeerData[]
}

export interface ValueEvent {
  peer: PeerId
  type: 5
  event: 'value'
  value: Uint8Array
}

export interface AddingPeerEvent {
  peer: PeerId
  type: 6
  event: 'addingPeer'
}

export interface DialingPeerEvent {
  peer: PeerId
  type: 7
  event: 'dialingPeer'
}

export type QueryEvent = SendingQueryEvent | PeerResponseEvent | FinalPeerEvent | QueryErrorEvent | ProviderEvent | ValueEvent | AddingPeerEvent | DialingPeerEvent

export interface DHT extends EventEmitter {
  // query/client methods
  get: (key: Uint8Array, options?: AbortOptions & QueryOptions) => Promise<Uint8Array>
  getMany: (key: Uint8Array, nvals: number, options?: AbortOptions & QueryOptions) => AsyncGenerator<DHTValue, void, undefined>
  findProviders: (key: CID, options?: AbortOptions & QueryOptions & { maxNumProviders?: number }) => AsyncGenerator<PeerId, void, undefined>
  findPeer: (id: PeerId, options?: AbortOptions & QueryOptions) => Promise<{ id: PeerId, multiaddrs: Multiaddr[] }>
  getClosestPeers: (key: Uint8Array, options?: AbortOptions & QueryOptions & { shallow?: boolean }) => AsyncGenerator<PeerId, void, undefined>
  getPublicKey: (peer: PeerId) => Promise<PublicKey>

  // publish/server methods
  provide: (key: CID, options?: AbortOptions) => AsyncGenerator<PeerId, void, undefined>
  put: (key: Uint8Array, value: Uint8Array, options?: AbortOptions & { minPeers?: number }) => Promise<void>

  // enable/disable publishing
  enableServerMode: () => void
  enableClientMode: () => void

  // housekeeping
  removeLocal: (key: Uint8Array) => Promise<void>

  // events
  on: (event: 'peer', handler: (peerData: PeerData) => void) => this
}

export interface DHTMessageHandler {
  handle: (peerId: PeerId, msg: Message) => Promise<Message | undefined>
}

export interface QueryContext {
  // the key we are looking up
  key: Uint8Array
  // the current peer being queried
  peer: PeerId
  // if this signal emits an 'abort' event, any long-lived processes or requests started as part of this query should be terminated
  signal: AbortSignal
  // which disjoint path we are following
  pathIndex: number
  // the total number of disjoint paths being executed
  numPaths: number
}

/**
 * Query function
 */
export interface QueryFunc<T> { (context: QueryContext): Promise<QueryResult<T> | undefined> }

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
}
