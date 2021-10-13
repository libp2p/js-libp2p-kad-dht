'use strict'

const errcode = require('err-code')
const { pipe } = require('it-pipe')
const lp = require('it-length-prefixed')
const drain = require('it-drain')
const first = require('it-first')
const { Message, MESSAGE_TYPE_LOOKUP } = require('./message')
const utils = require('./utils')
const { EventEmitter } = require('events')

const log = utils.logger('libp2p:kad-dht:network')
const noop = () => {}

/**
 * @typedef {import('peer-id')} PeerId
 * @typedef {import('libp2p-interfaces/src/stream-muxer/types').MuxedStream} MuxedStream
 * @typedef {import('./types').QueryEvent} QueryEvent
 * @typedef {import('./types').PeerData} PeerData
 */

/**
 * Handle network operations for the dht
 */
class Network extends EventEmitter {
  /**
   * Create a new network
   *
   * @param {import('./types').Dialer} dialer
   * @param {string} protocol
   */
  constructor (dialer, protocol) {
    super()

    this._running = false
    this._dialer = dialer
    this._protocol = protocol
  }

  /**
   * Start the network
   */
  start () {
    if (this._running) {
      return
    }

    this._running = true
  }

  /**
   * Stop all network activity
   */
  stop () {
    this._running = false
  }

  /**
   * Is the network online?
   *
   * @type {boolean}
   */
  get isStarted () {
    return this._running
  }

  /**
   * Send a request and record RTT for latency measurements
   *
   * @param {PeerId} to - The peer that should receive a message
   * @param {Message} msg - The message to send
   * @param {object} [options]
   * @param {AbortSignal} [options.signal]
   * @param {(evt: QueryEvent) => void} [options.onQueryEvent]
   */
  async sendRequest (to, msg, options = {}) {
    log('sending %s to %p', MESSAGE_TYPE_LOOKUP[msg.type], to)
    const onQueryEvent = options.onQueryEvent || noop

    onQueryEvent(sendingQueryEvent({
      peer: to
    }))

    const { stream } = await this._dialer.dialProtocol(to, this._protocol, options)

    try {
      const response = await this._writeReadMessage(stream, msg.serialize(), options)

      onQueryEvent(peerResponseEvent({
        peer: to,
        closerPeers: response.closerPeers
      }))

      return response
    } catch (/** @type {any} */ err) {
      onQueryEvent(queryErrorEvent({
        peer: to,
        error: err
      }))

      throw err
    }
  }

  /**
   * Sends a message without expecting an answer.
   *
   * @param {PeerId} to
   * @param {Message} msg
   * @param {object} [options]
   * @param {AbortSignal} [options.signal]
   * @param {(evt: QueryEvent) => void} [options.onQueryEvent]
   */
  async sendMessage (to, msg, options = {}) {
    log('sending %s to %p', MESSAGE_TYPE_LOOKUP[msg.type], to)
    const onQueryEvent = options.onQueryEvent || noop

    onQueryEvent(sendingQueryEvent({ peer: to }))

    const { stream } = await this._dialer.dialProtocol(to, this._protocol, options)

    try {
      await this._writeMessage(stream, msg.serialize(), options)

      onQueryEvent(peerResponseEvent({
        peer: to,
        closerPeers: []
      }))
    } catch (/** @type {any} */ err) {
      onQueryEvent(queryErrorEvent({
        peer: to,
        error: err
      }))

      throw err
    }
  }

  /**
   * Write a message to the given stream
   *
   * @param {MuxedStream} stream - the stream to use
   * @param {Uint8Array} msg - the message to send
   * @param {object} [options]
   * @param {AbortSignal} [options.signal]
   */
  async _writeMessage (stream, msg, options = {}) {
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
   *
   * @param {MuxedStream} stream - the stream to use
   * @param {Uint8Array} msg - the message to send
   * @param {object} [options]
   * @param {AbortSignal} [options.signal]
   */
  async _writeReadMessage (stream, msg, options = {}) {
    const res = await pipe(
      [msg],
      lp.encode(),
      stream,
      lp.decode(),
      /**
       * @param {AsyncIterable<Uint8Array>} source
       */
      async source => {
        const buf = await first(source)

        if (buf) {
          return buf.slice()
        }
      }
    )

    if (res.length === 0) {
      throw errcode(new Error('No message received'), 'ERR_NO_MESSAGE_RECEIVED')
    }

    const message = Message.deserialize(res)

    // tell any listeners about new peers we've seen
    message.closerPeers.forEach(peerData => {
      this.emit('peer', peerData)
    })
    message.providerPeers.forEach(peerData => {
      this.emit('peer', peerData)
    })

    return message
  }
}

module.exports.Network = Network

/**
 * @param {object} fields
 * @param {PeerId} fields.peer
 * @returns {import('./types').SendingQueryEvent}
 */
function sendingQueryEvent (fields) {
  return {
    ...fields,
    event: 'sendingQuery',
    type: 0
  }
}

/**
 * @param {object} fields
 * @param {PeerId} fields.peer
 * @param {PeerData[]} fields.closerPeers
 * @returns {import('./types').PeerResponseEvent}
 */
function peerResponseEvent (fields) {
  return {
    ...fields,
    event: 'peerResponse',
    type: 1
  }
}

/**
 * @param {object} fields
 * @param {PeerId} fields.peer
 * @param {Error} fields.error
 * @returns {import('./types').QueryErrorEvent}
 */
function queryErrorEvent (fields) {
  return {
    event: 'queryError',
    type: 3,
    ...fields
  }
}
