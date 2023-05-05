import { setMaxListeners } from 'events'
import { AbortError } from '@libp2p/interfaces/errors'
import { EventEmitter, CustomEvent } from '@libp2p/interfaces/events'
import { logger } from '@libp2p/logger'
import { PeerSet } from '@libp2p/peer-collections'
import { anySignal } from 'any-signal'
import merge from 'it-merge'
import { toString as uint8ArrayToString } from 'uint8arrays/to-string'
import {
  ALPHA, K, DEFAULT_QUERY_TIMEOUT
} from '../constants.js'
import { convertBuffer } from '../utils.js'
import { queryPath } from './query-path.js'
import type { QueryFunc } from './types.js'
import type { QueryEvent, QueryOptions as RootQueryOptions } from '../index.js'
import type { RoutingTable } from '../routing-table/index.js'
import type { Metric, Metrics } from '@libp2p/interface-metrics'
import type { PeerId } from '@libp2p/interface-peer-id'
import type { Startable } from '@libp2p/interfaces/startable'
import type { DeferredPromise } from 'p-defer'

export interface CleanUpEvents {
  'cleanup': CustomEvent
}

export interface QueryManagerInit {
  lan?: boolean
  disjointPaths?: number
  alpha?: number
  initialQuerySelfHasRun: DeferredPromise<void>
  routingTable: RoutingTable
}

export interface QueryManagerComponents {
  peerId: PeerId
  metrics?: Metrics
}

export interface QueryOptions extends RootQueryOptions {
  queryFuncTimeout?: number
  isSelfQuery?: boolean
}

/**
 * Keeps track of all running queries
 */
export class QueryManager implements Startable {
  private readonly components: QueryManagerComponents
  private readonly lan: boolean
  public disjointPaths: number
  private readonly alpha: number
  private readonly shutDownController: AbortController
  private running: boolean
  private queries: number
  private metrics?: {
    runningQueries: Metric
    queryTime: Metric
  }

  private readonly routingTable: RoutingTable
  private initialQuerySelfHasRun?: DeferredPromise<void>

  constructor (components: QueryManagerComponents, init: QueryManagerInit) {
    const { lan = false, disjointPaths = K, alpha = ALPHA } = init

    this.components = components
    this.disjointPaths = disjointPaths ?? K
    this.running = false
    this.alpha = alpha ?? ALPHA
    this.lan = lan
    this.queries = 0
    this.initialQuerySelfHasRun = init.initialQuerySelfHasRun
    this.routingTable = init.routingTable

    // allow us to stop queries on shut down
    this.shutDownController = new AbortController()
    // make sure we don't make a lot of noise in the logs
    try {
      if (setMaxListeners != null) {
        setMaxListeners(Infinity, this.shutDownController.signal)
      }
    } catch {} // fails on node < 15.4
  }

  isStarted (): boolean {
    return this.running
  }

  /**
   * Starts the query manager
   */
  async start (): Promise<void> {
    this.running = true

    if (this.components.metrics != null && this.metrics == null) {
      this.metrics = {
        runningQueries: this.components.metrics.registerMetric(`libp2p_kad_dht_${this.lan ? 'lan' : 'wan'}_running_queries`),
        queryTime: this.components.metrics.registerMetric(`libp2p_kad_dht_${this.lan ? 'lan' : 'wan'}_query_time_seconds`)
      }
    }
  }

  /**
   * Stops all queries
   */
  async stop (): Promise<void> {
    this.running = false

    this.shutDownController.abort()
  }

  async * run (key: Uint8Array, queryFunc: QueryFunc, options: QueryOptions = {}): AsyncGenerator<QueryEvent> {
    if (!this.running) {
      throw new Error('QueryManager not started')
    }

    const stopQueryTimer = this.metrics?.queryTime.timer()

    if (options.signal == null) {
      // don't let queries run forever
      options.signal = AbortSignal.timeout(DEFAULT_QUERY_TIMEOUT)

      // this signal will get listened to for network requests, etc
      // so make sure we don't make a lot of noise in the logs
      try {
        if (setMaxListeners != null) {
          setMaxListeners(Infinity, options.signal)
        }
      } catch {} // fails on node < 15.4
    }

    const signal = anySignal([this.shutDownController.signal, options.signal])

    // this signal will get listened to for every invocation of queryFunc
    // so make sure we don't make a lot of noise in the logs
    try {
      if (setMaxListeners != null) {
        setMaxListeners(Infinity, signal)
      }
    } catch {} // fails on node < 15.4

    const log = logger(`libp2p:kad-dht:${this.lan ? 'lan' : 'wan'}:query:` + uint8ArrayToString(key, 'base58btc'))

    // query a subset of peers up to `kBucketSize / 2` in length
    const startTime = Date.now()
    const cleanUp = new EventEmitter<CleanUpEvents>()

    try {
      if (options.isSelfQuery !== true && this.initialQuerySelfHasRun != null) {
        log('waiting for initial query-self query before continuing')

        await Promise.race([
          new Promise((resolve, reject) => {
            signal.addEventListener('abort', () => {
              reject(new AbortError('Query was aborted before self-query ran'))
            })
          }),
          this.initialQuerySelfHasRun.promise
        ])

        this.initialQuerySelfHasRun = undefined
      }

      log('query:start')
      this.queries++
      this.metrics?.runningQueries.update(this.queries)

      const id = await convertBuffer(key)
      const peers = this.routingTable.closestPeers(id)
      const peersToQuery = peers.slice(0, Math.min(this.disjointPaths, peers.length))

      if (peers.length === 0) {
        log.error('Running query with no peers')
        return
      }

      // make sure we don't get trapped in a loop
      const peersSeen = new PeerSet()

      // Create query paths from the starting peers
      const paths = peersToQuery.map((peer, index) => {
        return queryPath({
          key,
          startingPeer: peer,
          ourPeerId: this.components.peerId,
          signal,
          query: queryFunc,
          pathIndex: index,
          numPaths: peersToQuery.length,
          alpha: this.alpha,
          cleanUp,
          queryFuncTimeout: options.queryFuncTimeout,
          log,
          peersSeen,
          onProgress: options.onProgress
        })
      })

      // Execute the query along each disjoint path and yield their results as they become available
      for await (const event of merge(...paths)) {
        yield event

        if (event.name === 'QUERY_ERROR') {
          log('error', event.error)
        }
      }
    } catch (err: any) {
      if (!this.running && err.code === 'ERR_QUERY_ABORTED') {
        // ignore query aborted errors that were thrown during query manager shutdown
      } else {
        throw err
      }
    } finally {
      signal.clear()

      this.queries--
      this.metrics?.runningQueries.update(this.queries)

      if (stopQueryTimer != null) {
        stopQueryTimer()
      }

      cleanUp.dispatchEvent(new CustomEvent('cleanup'))
      log('query:done in %dms', Date.now() - startTime)
    }
  }
}
