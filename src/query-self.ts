import { setMaxListeners } from 'events'
import { logger, type Logger } from '@libp2p/logger'
import { anySignal } from 'any-signal'
import length from 'it-length'
import { pipe } from 'it-pipe'
import take from 'it-take'
import pDefer from 'p-defer'
import { pEvent } from 'p-event'
import { QUERY_SELF_INTERVAL, QUERY_SELF_TIMEOUT, K, QUERY_SELF_INITIAL_INTERVAL } from './constants.js'
import type { PeerRouting } from './peer-routing/index.js'
import type { RoutingTable } from './routing-table/index.js'
import type { PeerId } from '@libp2p/interface-peer-id'
import type { Startable } from '@libp2p/interfaces/startable'
import type { DeferredPromise } from 'p-defer'

export interface QuerySelfInit {
  lan: boolean
  peerRouting: PeerRouting
  routingTable: RoutingTable
  count?: number
  interval?: number
  initialInterval?: number
  queryTimeout?: number
  initialQuerySelfHasRun: DeferredPromise<void>
}

export interface QuerySelfComponents {
  peerId: PeerId
}

/**
 * Receives notifications of new peers joining the network that support the DHT protocol
 */
export class QuerySelf implements Startable {
  private readonly log: Logger
  private readonly components: QuerySelfComponents
  private readonly peerRouting: PeerRouting
  private readonly routingTable: RoutingTable
  private readonly count: number
  private readonly interval: number
  private readonly initialInterval: number
  private readonly queryTimeout: number
  private started: boolean
  private timeoutId?: NodeJS.Timer
  private controller?: AbortController
  private initialQuerySelfHasRun?: DeferredPromise<void>
  private querySelfPromise?: DeferredPromise<void>

  constructor (components: QuerySelfComponents, init: QuerySelfInit) {
    const { peerRouting, lan, count, interval, queryTimeout, routingTable } = init

    this.components = components
    this.log = logger(`libp2p:kad-dht:${lan ? 'lan' : 'wan'}:query-self`)
    this.started = false
    this.peerRouting = peerRouting
    this.routingTable = routingTable
    this.count = count ?? K
    this.interval = interval ?? QUERY_SELF_INTERVAL
    this.initialInterval = init.initialInterval ?? QUERY_SELF_INITIAL_INTERVAL
    this.queryTimeout = queryTimeout ?? QUERY_SELF_TIMEOUT
    this.initialQuerySelfHasRun = init.initialQuerySelfHasRun
  }

  isStarted (): boolean {
    return this.started
  }

  start (): void {
    if (this.started) {
      return
    }

    this.started = true
    clearTimeout(this.timeoutId)
    this.timeoutId = setTimeout(() => {
      this.querySelf()
        .catch(err => {
          this.log.error('error running self-query', err)
        })
    }, this.initialInterval)
  }

  stop (): void {
    this.started = false

    if (this.timeoutId != null) {
      clearTimeout(this.timeoutId)
    }

    if (this.controller != null) {
      this.controller.abort()
    }
  }

  async querySelf (): Promise<void> {
    if (!this.started) {
      this.log('skip self-query because we are not started')
      return
    }

    if (this.querySelfPromise != null) {
      this.log('joining existing self query')
      return this.querySelfPromise.promise
    }

    this.querySelfPromise = pDefer()

    if (this.routingTable.size === 0) {
      // wait to discover at least one DHT peer
      await pEvent(this.routingTable, 'peer:add')
    }

    if (this.started) {
      this.controller = new AbortController()
      const signal = anySignal([this.controller.signal, AbortSignal.timeout(this.queryTimeout)])

      // this controller will get used for lots of dial attempts so make sure we don't cause warnings to be logged
      try {
        if (setMaxListeners != null) {
          setMaxListeners(Infinity, signal)
        }
      } catch {} // fails on node < 15.4

      try {
        this.log('run self-query, look for %d peers timing out after %dms', this.count, this.queryTimeout)

        const found = await pipe(
          this.peerRouting.getClosestPeers(this.components.peerId.toBytes(), {
            signal,
            isSelfQuery: true
          }),
          (source) => take(source, this.count),
          async (source) => length(source)
        )

        this.log('self-query ran successfully - found %d peers', found)

        if (this.initialQuerySelfHasRun != null) {
          this.initialQuerySelfHasRun.resolve()
          this.initialQuerySelfHasRun = undefined
        }
      } catch (err: any) {
        this.log.error('self-query error', err)
      } finally {
        signal.clear()
      }
    }

    this.querySelfPromise.resolve()
    this.querySelfPromise = undefined

    if (!this.started) {
      return
    }

    this.timeoutId = setTimeout(() => {
      this.querySelf()
        .catch(err => {
          this.log.error('error running self-query', err)
        })
    }, this.interval)
  }
}
