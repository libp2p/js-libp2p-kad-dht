'use strict'

const pull = require('pull-stream')
const lp = require('pull-length-prefixed')

const errcode = require('err-code')

const rpc = require('./rpc')
const c = require('./constants')
const Message = require('./message')
const utils = require('./utils')

/**
 * Handle network operations for the dht
 */
class Network {
  /**
   * Create a new network.
   *
   * @param {KadDHT} self
   */
  constructor (self) {
    this.dht = self
    this.readMessageTimeout = c.READ_MESSAGE_TIMEOUT
    this._log = utils.logger(this.dht.peerInfo.id, 'net')
    this._rpc = rpc(this.dht)
    this._onPeerConnected = this._onPeerConnected.bind(this)
    this._running = false
  }

  /**
   * Start the network.
   *
   * @returns {void}
   */
  start () {
    if (this._running) {
      throw errcode('Network is already running', 'ERR_NETWORK_ALREADY_RUNNING')
    }

    // TODO add a way to check if switch has started or not
    if (!this.dht.isStarted) {
      throw errcode('Cannot start network', 'ERR_CANNOT_START_NETWORK')
    }

    this._running = true

    // handle incoming connections
    this.dht.switch.handle(c.PROTOCOL_DHT, this._rpc)

    // handle new connections
    this.dht.switch.on('peer-mux-established', this._onPeerConnected)
  }

  /**
   * Stop all network activity.
   *
   * @returns {void}
   */
  stop () {
    if (!this.dht.isStarted && !this.isStarted) {
      throw errcode('Network is already stopped', 'ERR_NETWORK_ALREADY_STOPPED')
    }
    this._running = false
    this.dht.switch.removeListener('peer-mux-established', this._onPeerConnected)

    this.dht.switch.unhandle(c.PROTOCOL_DHT)
  }

  /**
   * Is the network online?
   *
   * @type {bool}
   */
  get isStarted () {
    return this._running
  }

  /**
   * Are all network components there?
   *
   * @type {bool}
   */
  get isConnected () {
    // TODO add a way to check if switch has started or not
    return this.dht.isStarted && this.isStarted
  }

  /**
   * Handle new connections in the switch.
   *
   * @param {PeerInfo} peer
   * @returns {void}
   * @private
   */
  _onPeerConnected (peer) {
    const peerId = peer.id.toB58String()
    if (!this.isConnected) {
      return this._log.error('Received connection from %s but network is offline', peerId)
    }

    this.dht.switch.dial(peer, c.PROTOCOL_DHT, async (err, conn) => {
      if (err) {
        return this._log('%s does not support protocol: %s', peerId, c.PROTOCOL_DHT)
      }

      // TODO: conn.close()
      pull(pull.empty(), conn)

      try {
        await this.dht._add(peer)
      } catch (err) {
        return this._log.error(`Failed to add ${peerId} to the routing table`, err)
      }

      this.dht._peerDiscovered(peer)

      this._log('added to the routing table: %s', peerId)
    })
  }

  /**
   * Send a request and record RTT for latency measurements.
   *
   * @param {PeerId} to - The peer that should receive a message
   * @param {Message} msg - The message to send.
   * @returns {Promise<Message>}
   */
  sendRequest (to, msg) {
    // TODO: record latency
    if (!this.isConnected) {
      throw errcode('Network is offline', 'ERR_NETWORK_OFFLINE')
    }

    this._log('sending request to: %s', to.toB58String())
    return new Promise((resolve, reject) => {
      this.dht.switch.dial(to, c.PROTOCOL_DHT, (err, conn) => {
        if (err) {
          return reject(err)
        }

        resolve(this._writeReadMessage(conn, msg.serialize()))
      })
    })
  }

  /**
   * Sends a message without expecting an answer.
   *
   * @param {PeerId} to
   * @param {Message} msg
   * @returns {Promise}
   */
  sendMessage (to, msg) {
    if (!this.isConnected) {
      throw errcode('Network is offline', 'ERR_NETWORK_OFFLINE')
    }

    this._log('sending message to: %s', to.toB58String())

    return new Promise((resolve, reject) => {
      this.dht.switch.dial(to, c.PROTOCOL_DHT, (err, conn) => {
        if (err) {
          return reject(err)
        }

        resolve(this._writeMessage(conn, msg.serialize()))
      })
    })
  }

  /**
   * Write a message and read its response.
   * If no response is received after the specified timeout
   * this will error out.
   *
   * @param {Connection} conn - the connection to use
   * @param {Buffer} msg - the message to send
   * @returns {Promise<Message>}
   * @private
   */
  _writeReadMessage (conn, msg) {
    return utils.promiseTimeout(
      writeReadMessage(conn, msg),
      this.readMessageTimeout,
      `Send/Receive message timed out in ${this.readMessageTimeout}ms`
    )
  }

  /**
   * Write a message to the given connection.
   *
   * @param {Connection} conn - the connection to use
   * @param {Buffer} msg - the message to send
   * @returns {Promise}
   * @private
   */
  _writeMessage (conn, msg) {
    return new Promise((resolve, reject) => {
      pull(
        pull.values([msg]),
        lp.encode(),
        conn,
        pull.onEnd((err) => err ? reject(err) : resolve())
      )
    })
  }
}

function writeReadMessage (conn, msg) {
  return new Promise((resolve, reject) => {
    pull(
      pull.values([msg]),
      lp.encode(),
      conn,
      pull.filter((msg) => msg.length < c.maxMessageSize),
      lp.decode(),
      pull.collect((err, res) => {
        if (err) {
          return reject(err)
        }
        if (res.length === 0) {
          return reject(errcode('No message received', 'ERR_NO_MESSAGE_RECEIVED'))
        }

        let response
        try {
          response = Message.deserialize(res[0])
        } catch (err) {
          return reject(errcode(err, 'ERR_FAILED_DESERIALIZE_RESPONSE'))
        }

        resolve(response)
      })
    )
  })
}

module.exports = Network
