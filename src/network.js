'use strict'

const errcode = require('err-code')
const { pipe } = require('it-pipe')
const lp = require('it-length-prefixed')
const drain = require('it-drain')
const first = require('it-first')
const MulticodecTopology = require('libp2p-interfaces/src/topology/multicodec-topology')
const { Message, MESSAGE_TYPE_LOOKUP } = require('./message')
const utils = require('./utils')

const log = utils.logger('libp2p:kad-dht:network')

/**
 * @typedef {import('peer-id')} PeerId
 * @typedef {import('libp2p-interfaces/src/stream-muxer/types').MuxedStream} MuxedStream
 */

/**
 * Handle network operations for the dht
 */
class Network {
  /**
   * Create a new network
   *
   * @param {import('./types').Dialer} dialer
   * @param {import('./types').Registrar} registrar
   * @param {import('./routing-table').RoutingTable} routingTable
   * @param {import('./types').AddressBook} addressBook
   * @param {string} protocol
   */
  constructor (dialer, registrar, routingTable, addressBook, protocol) {
    this._onPeerConnected = this._onPeerConnected.bind(this)
    this._running = false
    this._dialer = dialer
    this._registrar = registrar
    this._addressBook = addressBook
    this._routingTable = routingTable
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

    // register protocol with topology
    const topology = new MulticodecTopology({
      multicodecs: [this._protocol],
      handlers: {
        onConnect: this._onPeerConnected,
        onDisconnect: () => {}
      }
    })
    this._registrarId = this._registrar.register(topology)
  }

  /**
   * Stop all network activity
   */
  stop () {
    this._running = false

    // unregister protocol and handlers
    if (this._registrarId) {
      this._registrar.unregister(this._registrarId)
    }
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
   * Registrar notifies a connection successfully with dht protocol
   *
   * @param {PeerId} peerId - remote peer id
   */
  _onPeerConnected (peerId) {
    this._routingTable.find(peerId)
      .then(async res => {
        if (!res) {
          await this._routingTable.add(peerId)
          log('added %p to the routing table', peerId)
        }
      })
      .catch(err => {
        log('error adding %p to the routing table:', peerId, err)
      })
  }

  /**
   * Send a request and record RTT for latency measurements
   *
   * @param {PeerId} to - The peer that should receive a message
   * @param {Message} msg - The message to send
   * @param {object} [options]
   * @param {AbortSignal} [options.signal]
   */
  async sendRequest (to, msg, options = {}) {
    log('sending %s to %p', MESSAGE_TYPE_LOOKUP[msg.type], to)

    const { stream } = await this._dialer.dialProtocol(to, this._protocol, options)

    return this._writeReadMessage(stream, msg.serialize(), options)
  }

  /**
   * Sends a message without expecting an answer.
   *
   * @param {PeerId} to
   * @param {Message} msg
   * @param {object} [options]
   * @param {AbortSignal} [options.signal]
   */
  async sendMessage (to, msg, options = {}) {
    log('sending %s to %p', MESSAGE_TYPE_LOOKUP[msg.type], to)

    const { stream } = await this._dialer.dialProtocol(to, this._protocol, options)

    await this._writeMessage(stream, msg.serialize(), options)
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

    // add any observed peers to the address book
    message.closerPeers.forEach(peerData => {
      this._addressBook.add(peerData.id, peerData.multiaddrs)
      this._routingTable.add(peerData.id).catch(err => {
        log.error(`Could not add ${peerData.id} to routing table`, err)
      })
    })
    message.providerPeers.forEach(peerData => {
      this._addressBook.add(peerData.id, peerData.multiaddrs)
      this._routingTable.add(peerData.id).catch(err => {
        log.error(`Could not add ${peerData.id} to routing table`, err)
      })
    })

    return message
  }
}

module.exports.Network = Network
