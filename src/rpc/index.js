'use strict'

const pipe = require('it-pipe')
const lp = require('it-length-prefixed')
const paramap = require('paramap-it')
const PeerInfo = require('peer-info')

const Message = require('../message')
const handlers = require('./handlers')
const utils = require('../utils')
const c = require('../constants')

module.exports = (dht) => {
  const log = utils.logger(dht.peerInfo.id, 'rpc')
  const getMessageHandler = handlers(dht)

  /**
   * Process incoming DHT messages.
   * @param {PeerInfo} peer
   * @param {Message} msg
   * @returns {Promise<Message>}
   *
   * @private
   */
  async function handleMessage (peer, msg) { // eslint-disable-line
    // get handler & exectue it
    const handler = getMessageHandler(msg.type)

    try {
      await dht._add(peer)
    } catch (err) {
      log.error('Failed to update the kbucket store')
      log.error(err)
    }

    if (!handler) {
      log.error(`no handler found for message type: ${msg.type}`)
      return
    }

    return handler(peer, msg)
  }

  /**
   * Handle incoming streams on the dht protocol.
   * @param {Object} props
   * @param {string} props.protocol
   * @param {DuplexStream} props.stream
   * @param {Connection} props.connection connection
   * @returns {Promise<void>}
   */
  return async function onIncomingStream ({ protocol, stream, connection }) {
    const peerInfo = await PeerInfo.create(connection.remotePeer)
    peerInfo.protocols.add(protocol)

    try {
      await dht._add(peerInfo)
    } catch (err) {
      log.error(err)
    }

    const idB58Str = peerInfo.id.toB58String()
    log('from: %s', idB58Str)

    await pipe(
      stream.source,
      lp.decode(),
      utils.itFilter(
        (msg) => msg.length < c.maxMessageSize
      ),
      source => paramap(source, rawMsg => {
        const msg = Message.deserialize(rawMsg.slice())
        return handleMessage(peerInfo, msg)
      }),
      // Not all handlers will return a response
      utils.itFilter(Boolean),
      source => paramap(source, response => {
        return response.serialize()
      }),
      lp.encode(),
      stream.sink
    )
  }
}
