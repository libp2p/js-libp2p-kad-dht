import { CustomEvent, EventEmitter } from '@libp2p/interfaces/events'
import { type Logger, logger } from '@libp2p/logger'
import { selectors as recordSelectors } from '@libp2p/record/selectors'
import { validators as recordValidators } from '@libp2p/record/validators'
import pDefer from 'p-defer'
import { PROTOCOL_DHT, PROTOCOL_PREFIX, LAN_PREFIX } from './constants.js'
import { ContentFetching } from './content-fetching/index.js'
import { ContentRouting } from './content-routing/index.js'
import { Network } from './network.js'
import { PeerRouting } from './peer-routing/index.js'
import { Providers } from './providers.js'
import { QueryManager } from './query/manager.js'
import { QuerySelf } from './query-self.js'
import { RoutingTable } from './routing-table/index.js'
import { RoutingTableRefresh } from './routing-table/refresh.js'
import { RPC } from './rpc/index.js'
import { TopologyListener } from './topology-listener.js'
import {
  removePrivateAddresses,
  removePublicAddresses
} from './utils.js'
import type { KadDHTComponents, KadDHTInit, QueryOptions, Validators, Selectors, KadDHT, QueryEvent } from './index.js'
import type { PeerDiscoveryEvents } from '@libp2p/interface-peer-discovery'
import type { PeerId } from '@libp2p/interface-peer-id'
import type { PeerInfo } from '@libp2p/interface-peer-info'
import type { CID } from 'multiformats/cid'

export const DEFAULT_MAX_INBOUND_STREAMS = 32
export const DEFAULT_MAX_OUTBOUND_STREAMS = 64

export interface SingleKadDHTInit extends KadDHTInit {
  /**
   * Whether to start up in lan or wan mode
   */
  lan?: boolean
}

/**
 * A DHT implementation modelled after Kademlia with S/Kademlia modifications.
 * Original implementation in go: https://github.com/libp2p/go-libp2p-kad-dht.
 */
export class DefaultKadDHT extends EventEmitter<PeerDiscoveryEvents> implements KadDHT {
  public protocol: string
  public routingTable: RoutingTable
  public providers: Providers
  public network: Network
  public peerRouting: PeerRouting

  public readonly components: KadDHTComponents
  private readonly log: Logger
  private running: boolean
  private readonly kBucketSize: number
  private clientMode: boolean
  private readonly lan: boolean
  private readonly validators: Validators
  private readonly selectors: Selectors
  private readonly queryManager: QueryManager
  private readonly contentFetching: ContentFetching
  private readonly contentRouting: ContentRouting
  private readonly routingTableRefresh: RoutingTableRefresh
  private readonly rpc: RPC
  private readonly topologyListener: TopologyListener
  private readonly querySelf: QuerySelf
  private readonly maxInboundStreams: number
  private readonly maxOutboundStreams: number

  /**
   * Create a new KadDHT
   */
  constructor (components: KadDHTComponents, init: SingleKadDHTInit) {
    super()

    const {
      kBucketSize,
      clientMode,
      validators,
      selectors,
      querySelfInterval,
      lan,
      protocolPrefix,
      pingTimeout,
      pingConcurrency,
      maxInboundStreams,
      maxOutboundStreams,
      providers: providersInit
    } = init

    this.running = false
    this.components = components
    this.lan = Boolean(lan)
    this.log = logger(`libp2p:kad-dht:${lan === true ? 'lan' : 'wan'}`)
    this.protocol = `${protocolPrefix ?? PROTOCOL_PREFIX}${lan === true ? LAN_PREFIX : ''}${PROTOCOL_DHT}`
    this.kBucketSize = kBucketSize ?? 20
    this.clientMode = clientMode ?? true
    this.maxInboundStreams = maxInboundStreams ?? DEFAULT_MAX_INBOUND_STREAMS
    this.maxOutboundStreams = maxOutboundStreams ?? DEFAULT_MAX_OUTBOUND_STREAMS
    this.routingTable = new RoutingTable(components, {
      kBucketSize,
      lan: this.lan,
      pingTimeout,
      pingConcurrency,
      protocol: this.protocol
    })

    this.providers = new Providers(components, providersInit ?? {})

    this.validators = {
      ...recordValidators,
      ...validators
    }
    this.selectors = {
      ...recordSelectors,
      ...selectors
    }
    this.network = new Network(components, {
      protocol: this.protocol,
      lan: this.lan
    })

    // all queries should wait for the initial query-self query to run so we have
    // some peers and don't force consumers to use arbitrary timeouts
    const initialQuerySelfHasRun = pDefer<any>()

    // if the user doesn't want to wait for query peers, resolve the initial
    // self-query promise immediately
    if (init.allowQueryWithZeroPeers === true) {
      initialQuerySelfHasRun.resolve()
    }

    this.queryManager = new QueryManager(components, {
      // Number of disjoint query paths to use - This is set to `kBucketSize/2` per the S/Kademlia paper
      disjointPaths: Math.ceil(this.kBucketSize / 2),
      lan,
      initialQuerySelfHasRun,
      routingTable: this.routingTable
    })

    // DHT components
    this.peerRouting = new PeerRouting(components, {
      routingTable: this.routingTable,
      network: this.network,
      validators: this.validators,
      queryManager: this.queryManager,
      lan: this.lan
    })
    this.contentFetching = new ContentFetching(components, {
      validators: this.validators,
      selectors: this.selectors,
      peerRouting: this.peerRouting,
      queryManager: this.queryManager,
      network: this.network,
      lan: this.lan
    })
    this.contentRouting = new ContentRouting(components, {
      network: this.network,
      peerRouting: this.peerRouting,
      queryManager: this.queryManager,
      routingTable: this.routingTable,
      providers: this.providers,
      lan: this.lan
    })
    this.routingTableRefresh = new RoutingTableRefresh({
      peerRouting: this.peerRouting,
      routingTable: this.routingTable,
      lan: this.lan
    })
    this.rpc = new RPC(components, {
      routingTable: this.routingTable,
      providers: this.providers,
      peerRouting: this.peerRouting,
      validators: this.validators,
      lan: this.lan
    })
    this.topologyListener = new TopologyListener(components, {
      protocol: this.protocol,
      lan: this.lan
    })
    this.querySelf = new QuerySelf(components, {
      peerRouting: this.peerRouting,
      interval: querySelfInterval,
      initialInterval: init.initialQuerySelfInterval,
      lan: this.lan,
      initialQuerySelfHasRun,
      routingTable: this.routingTable
    })

    // handle peers being discovered during processing of DHT messages
    this.network.addEventListener('peer', (evt) => {
      const peerData = evt.detail

      this.onPeerConnect(peerData).catch(err => {
        this.log.error('could not add %p to routing table', peerData.id, err)
      })

      this.dispatchEvent(new CustomEvent('peer', {
        detail: peerData
      }))
    })

    // handle peers being discovered via other peer discovery mechanisms
    this.topologyListener.addEventListener('peer', (evt) => {
      const peerId = evt.detail

      Promise.resolve().then(async () => {
        const peer = await this.components.peerStore.get(peerId)

        const peerData = {
          id: peerId,
          multiaddrs: peer.addresses.map(({ multiaddr }) => multiaddr),
          protocols: peer.protocols
        }

        await this.onPeerConnect(peerData)
      }).catch(err => {
        this.log.error('could not add %p to routing table', peerId, err)
      })
    })
  }

  async onPeerConnect (peerData: PeerInfo): Promise<void> {
    this.log('peer %p connected with protocols', peerData.id, peerData.protocols)

    if (this.lan) {
      peerData = removePublicAddresses(peerData)
    } else {
      peerData = removePrivateAddresses(peerData)
    }

    if (peerData.multiaddrs.length === 0) {
      this.log('ignoring %p as they do not have any %s addresses in %s', peerData.id, this.lan ? 'private' : 'public', peerData.multiaddrs.map(addr => addr.toString()))
      return
    }

    try {
      await this.routingTable.add(peerData.id)
    } catch (err: any) {
      this.log.error('could not add %p to routing table', peerData.id, err)
    }
  }

  /**
   * Is this DHT running.
   */
  isStarted (): boolean {
    return this.running
  }

  /**
   * If 'server' this node will respond to DHT queries, if 'client' this node will not
   */
  async getMode (): Promise<'client' | 'server'> {
    return this.clientMode ? 'client' : 'server'
  }

  /**
   * If 'server' this node will respond to DHT queries, if 'client' this node will not
   */
  async setMode (mode: 'client' | 'server'): Promise<void> {
    await this.components.registrar.unhandle(this.protocol)

    if (mode === 'client') {
      this.log('enabling client mode')
      this.clientMode = true
    } else {
      this.log('enabling server mode')
      this.clientMode = false
      await this.components.registrar.handle(this.protocol, this.rpc.onIncomingStream.bind(this.rpc), {
        maxInboundStreams: this.maxInboundStreams,
        maxOutboundStreams: this.maxOutboundStreams
      })
    }
  }

  /**
   * Start listening to incoming connections.
   */
  async start (): Promise<void> {
    this.running = true

    // Only respond to queries when not in client mode
    await this.setMode(this.clientMode ? 'client' : 'server')

    await Promise.all([
      this.providers.start(),
      this.queryManager.start(),
      this.network.start(),
      this.routingTable.start(),
      this.topologyListener.start()
    ])

    this.querySelf.start()

    await this.routingTableRefresh.start()
  }

  /**
   * Stop accepting incoming connections and sending outgoing
   * messages.
   */
  async stop (): Promise<void> {
    this.running = false

    this.querySelf.stop()

    await Promise.all([
      this.providers.stop(),
      this.queryManager.stop(),
      this.network.stop(),
      this.routingTable.stop(),
      this.routingTableRefresh.stop(),
      this.topologyListener.stop()
    ])
  }

  /**
   * Store the given key/value pair in the DHT
   */
  async * put (key: Uint8Array, value: Uint8Array, options: QueryOptions = {}): AsyncGenerator<any, void, undefined> {
    yield * this.contentFetching.put(key, value, options)
  }

  /**
   * Get the value that corresponds to the passed key
   */
  async * get (key: Uint8Array, options: QueryOptions = {}): AsyncGenerator<QueryEvent, void, undefined> {
    yield * this.contentFetching.get(key, options)
  }

  // ----------- Content Routing

  /**
   * Announce to the network that we can provide given key's value
   */
  async * provide (key: CID, options: QueryOptions = {}): AsyncGenerator<QueryEvent, void, undefined> {
    yield * this.contentRouting.provide(key, this.components.addressManager.getAddresses(), options)
  }

  /**
   * Search the dht for providers of the given CID
   */
  async * findProviders (key: CID, options: QueryOptions = {}): AsyncGenerator<QueryEvent, any, unknown> {
    yield * this.contentRouting.findProviders(key, options)
  }

  // ----------- Peer Routing -----------

  /**
   * Search for a peer with the given ID
   */
  async * findPeer (id: PeerId, options: QueryOptions = {}): AsyncGenerator<QueryEvent, any, unknown> {
    yield * this.peerRouting.findPeer(id, options)
  }

  /**
   * Kademlia 'node lookup' operation
   */
  async * getClosestPeers (key: Uint8Array, options: QueryOptions = {}): AsyncGenerator<QueryEvent, any, unknown> {
    yield * this.peerRouting.getClosestPeers(key, options)
  }

  async refreshRoutingTable (): Promise<void> {
    this.routingTableRefresh.refreshTable(true)
  }
}
