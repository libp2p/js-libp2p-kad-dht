import errcode from 'err-code'
import { pipe } from 'it-pipe'
import * as lp from 'it-length-prefixed'
import drain from 'it-drain'
import first from 'it-first'
import { Message, MESSAGE_TYPE_LOOKUP } from './message/index.js'
import { EventEmitter, CustomEvent } from '@libp2p/interfaces'
import {
  dialingPeerEvent,
  sendingQueryEvent,
  peerResponseEvent,
  queryErrorEvent
} from './query/events.js'
import { logger } from '@libp2p/logger'
import type { PeerId } from '@libp2p/interfaces/peer-id'
import type { AbortOptions, Startable } from '@libp2p/interfaces'
import type { Logger } from '@libp2p/logger'
import type { Duplex } from 'it-stream-types'
import type { PeerInfo } from '@libp2p/interfaces/peer-info'
import { Components, Initializable } from '@libp2p/interfaces/components'

export interface NetworkInit {
  protocol: string
  lan: boolean
}

interface NetworkEvents {
  'peer': CustomEvent<PeerInfo>
}

/**
 * Handle network operations for the dht
 */
export class Network extends EventEmitter<NetworkEvents> implements Startable, Initializable {
  private readonly log: Logger
  private readonly protocol: string
  private running: boolean
  private components: Components = new Components()

  /**
   * Create a new network
   */
  constructor (init: NetworkInit) {
    super()

    const { protocol, lan } = init
    this.log = logger(`libp2p:kad-dht:${lan ? 'lan' : 'wan'}:network`)
    this.running = false
    this.protocol = protocol
  }

  init (components: Components): void {
    this.components = components
  }

  /**
   * Start the network
   */
  async start () {
    if (this.running) {
      return
    }

    this.running = true
  }

  /**
   * Stop all network activity
   */
  async stop () {
    this.running = false
  }

  /**
   * Is the network online?
   */
  isStarted () {
    return this.running
  }

  /**
   * Send a request and record RTT for latency measurements
   */
  async * sendRequest (to: PeerId, msg: Message, options: AbortOptions = {}) {
    if (!this.running) {
      return
    }

    this.log('sending %s to %p', MESSAGE_TYPE_LOOKUP[msg.type], to)

    try {
      yield dialingPeerEvent({ peer: to })

      const { stream } = await this.components.getDialer().dialProtocol(to, this.protocol, options)

      yield sendingQueryEvent({ to, type: msg.type })

      const response = await this._writeReadMessage(stream, msg.serialize())

      yield peerResponseEvent({
        from: to,
        messageType: response.type,
        closer: response.closerPeers,
        providers: response.providerPeers,
        record: response.record
      })
    } catch (err: any) {
      yield queryErrorEvent({ from: to, error: err })
    }
  }

  /**
   * Sends a message without expecting an answer
   */
  async * sendMessage (to: PeerId, msg: Message, options: AbortOptions = {}) {
    if (!this.running) {
      return
    }

    this.log('sending %s to %p', MESSAGE_TYPE_LOOKUP[msg.type], to)

    yield dialingPeerEvent({ peer: to })

    const { stream } = await this.components.getDialer().dialProtocol(to, this.protocol, options)

    yield sendingQueryEvent({ to, type: msg.type })

    try {
      await this._writeMessage(stream, msg.serialize())

      yield peerResponseEvent({ from: to, messageType: msg.type })
    } catch (err: any) {
      yield queryErrorEvent({ from: to, error: err })
    }
  }

  /**
   * Write a message to the given stream
   */
  async _writeMessage (stream: Duplex<Uint8Array>, msg: Uint8Array) {
    await pipe(
      [msg],
      lp.encode(),
      stream,
      drain
    )
  }

  /**
   * Write a message and read its response.
   * If no response is received after the specified timeout
   * this will error out.
   */
  async _writeReadMessage (stream: Duplex<Uint8Array>, msg: Uint8Array) {
    const res = await pipe(
      [msg],
      lp.encode(),
      stream,
      lp.decode(),
      async source => {
        const buf = await first(source)

        if (buf != null) {
          return buf
        }

        throw errcode(new Error('No message received'), 'ERR_NO_MESSAGE_RECEIVED')
      }
    )

    const message = Message.deserialize(res)

    // tell any listeners about new peers we've seen
    message.closerPeers.forEach(peerData => {
      this.dispatchEvent(new CustomEvent('peer', {
        detail: peerData
      }))
    })
    message.providerPeers.forEach(peerData => {
      this.dispatchEvent(new CustomEvent('peer', {
        detail: peerData
      }))
    })

    return message
  }
}