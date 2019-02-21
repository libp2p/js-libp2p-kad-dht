'use strict'

const utils = require('../../utils')
const errcode = require('err-code')

module.exports = (dht) => {
  const log = utils.logger(dht.peerInfo.id, 'rpc:put-value')

  /**
   * Process `PutValue` DHT messages.
   *
   * @param {PeerInfo} peer
   * @param {Message} msg
   * @returns {Promise<Message>}
   */
  return async function putValue (peer, msg) {
    const key = msg.key
    log('key: %b', key)

    const record = msg.record

    if (!record) {
      const errMsg = `Empty record from: ${peer.id.toB58String()}`

      log.error(errMsg)
      throw errcode(errMsg, 'ERR_EMPTY_RECORD')
    }

    try {
      await dht._verifyRecordLocally(record)
    } catch (err) {
      log.error(err.message)
      throw err
    }

    record.timeReceived = new Date()

    const k = utils.bufferToKey(record.key)

    await dht.datastore.put(k, record.serialize())

    return msg
  }
}
