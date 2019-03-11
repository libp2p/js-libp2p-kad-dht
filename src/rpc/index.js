'use strict'

const handlers = require('./handlers')
const utils = require('../utils')

module.exports = (dht) => {
  const log = utils.logger(dht.peerInfo.id, 'rpc')

  const getMessageHandler = handlers(dht)

  /**
   * Process incoming DHT messages.
   *
   * @param {PeerInfo} peer
   * @param {Message} msg
   * @returns {Promise<Message>}
   *
   * @private
   */
  async function handleMessage (peer, msg) {
    // update the peer
    try {
      await dht._add(peer)
    } catch (err) {
      log.error('Failed to update the kbucket store')
      log.error(err)
    }

    // get handler & execute it
    const handler = getMessageHandler(msg.type)

    if (!handler) {
      log.error(`no handler found for message type: ${msg.type}`)
      return
    }

    return handler(peer, msg)
  }

  /**
   * Handle incoming streams from the Switch, on the dht protocol.
   *
   * @param {string} protocol
   * @param {Connection} conn
   * @returns {undefined}
   */
  return function protocolHandler (protocol, conn) {
    conn.getPeerInfo((err, peer) => {
      if (err) {
        log.error('Failed to get peer info')
        log.error(err)
        return
      }

      log('from: %s', peer.id.toB58String())
      dht._connectionHelper.through(conn, (msg) => handleMessage(peer, msg))
    })
  }
}
