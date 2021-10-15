import type PeerId from 'peer-id'
import type { Multiaddr } from 'multiaddr'
import type { CID } from 'multiformats/cid'
import type { MuxedStream } from 'libp2p/src/upgrader'
import type Topology from 'libp2p-interfaces/src/topology'
import type { Message } from './message'
import type { PublicKey } from 'libp2p-crypto'

export enum MessageTypes {

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

export interface SendingQueryEvent {
  peer: PeerId
  type: 0
  name: 'sendingQuery'
  message: string
  messageType: number
}

export interface PeerResponseEvent {
  peer: PeerId
  type: 1
  name: 'peerResponse'
  closerPeers?: PeerData[]
  response?: Message
}

export interface FinalPeerEvent {
  peer: PeerData
  type: 2
  name: 'finalPeer'
}

export interface QueryErrorEvent {
  peer: PeerId
  type: 3
  name: 'queryError'
  error: Error
}

export interface ProviderEvent {
  peer: PeerId
  type: 4
  name: 'provider'
  providerPeers: PeerData[]
}

export interface ValueEvent {
  peer: PeerId
  type: 5
  name: 'value'
  value: Uint8Array
}

export interface AddingPeerEvent {
  peer: PeerId
  type: 6
  name: 'addingPeer'
}

export interface DialingPeerEvent {
  peer: PeerId
  type: 7
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
