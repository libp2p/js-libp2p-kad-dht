import type { EventEmitter } from 'events'
import type PeerId from 'peer-id'
import type { Multiaddr } from 'multiaddr'
import type { PublicKey } from 'libp2p-crypto'
import type { CID } from 'multiformats/cid'
import type { Message } from './message'
import type { MuxedStream } from 'libp2p/src/upgrader'
import type Topology from 'libp2p-interfaces/src/topology'

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

export interface DHT extends EventEmitter {
  put: (key: Uint8Array, value: Uint8Array, options?: { signal?: AbortSignal, minPeers?: number }) => Promise<void>
  get: (key: Uint8Array, options?: { signal?: AbortSignal }) => Promise<Uint8Array>
  getMany: (key: Uint8Array, nvals: number, options?: { signal?: AbortSignal }) => AsyncGenerator<DHTValue, void, undefined>
  removeLocal: (key: Uint8Array) => Promise<void>
  provide: (key: CID, options?: { signal?: AbortSignal }) => AsyncGenerator<PeerId, void, undefined>
  findProviders: (key: CID, options?: { signal?: AbortSignal, maxNumProviders?: number }) => AsyncGenerator<PeerId, void, undefined>
  findPeer: (id: PeerId, options?: { signal?: AbortSignal }) => Promise<{ id: PeerId, multiaddrs: Multiaddr[] } | undefined>
  getClosestPeers: (key: Uint8Array, options?: { shallow?: boolean, signal?: AbortSignal }) => AsyncGenerator<PeerId, void, undefined>
  getPublicKey: (peer: PeerId) => Promise<PublicKey>
  enableServerMode: () => void
  enableClientMode: () => void
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
  dialProtocol: (peer: PeerId, protocol: string, options: { signal: AbortSignal }) => Promise<{ stream: MuxedStream }>
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
