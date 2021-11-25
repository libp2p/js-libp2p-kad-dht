'use strict'

const MulticodecTopology = require('libp2p-interfaces/src/topology/multicodec-topology')
const { EventEmitter } = require('events')
const utils = require('./utils')

/**
 * Receives notifications of new peers joining the network that support the DHT protocol
 */
class TopologyListener extends EventEmitter {
  /**
   * Create a new network
   *
   * @param {object} params
   * @param {import('./types').Registrar} params.registrar
   * @param {string} params.protocol
   * @param {boolean} params.lan
   */
  constructor ({ registrar, protocol, lan }) {
    super()

    this._log = utils.logger(`libp2p:kad-dht:topology-listener:${lan ? 'lan' : 'wan'}:network`)
    this._running = false
    this._registrar = registrar
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
        onConnect: (peerId) => {
          this._log('observed peer that with protocol %s %p', this._protocol, peerId)
          this.emit('peer', peerId)
        },
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
}

module.exports.TopologyListener = TopologyListener
