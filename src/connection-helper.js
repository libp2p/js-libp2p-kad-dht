'use strict'

const pull = require('pull-stream')
const lp = require('pull-length-prefixed')

const errcode = require('err-code')

const c = require('./constants')
const Message = require('./message')
const utils = require('./utils')

/**
 * Provide a Promise API to send messages over a Connection
 */
class ConnectionHelper {
  /**
   * Create a ConnectionHelper.
   *
   * @param {PeerId} selfId
  */
  constructor (selfId) {
    this._log = utils.logger(selfId, 'net')
  }

  /**
   * Write a message to the given connection.
   *
   * @param {Connection} conn - the connection to use
   * @param {Buffer} msg - the message to send
   * @returns {Promise}
   */
  writeMessage (conn, msg) {
    const serialized = msg.serialize()
    return new Promise((resolve, reject) => {
      pull(
        pull.values([serialized]),
        lp.encode(),
        conn,
        pull.onEnd((err) => err ? reject(err) : resolve())
      )
    })
  }

  /**
   * Write a message and read its response.
   *
   * @param {Connection} conn - the connection to use
   * @param {Buffer} msg - the message to send
   * @returns {Promise<Message>}
   */
  writeReadMessage (conn, msg) {
    const serialized = msg.serialize()
    return new Promise((resolve, reject) => {
      pull(
        pull.values([serialized]),
        lp.encode(),
        conn,
        lp.decode(),
        pull.filter((msg) => msg.length < c.maxMessageSize),
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

  /**
   * A function that processes a message and may optionally return a Message
   * which is passed through to the Connection. The function may be async.
   *
   * @typedef {ThroughFunc} function
   * @param {Message} msg
   * @returns Message
   */

  /**
   * Process incoming messages with a ThroughFunc.
   * If a value is returned from the function, it is passed through to the
   * Connection.
   *
   * @param {Connection} conn - the connection to use
   * @param {ThroughFunc} throughFn - the message to send
   */
  through (conn, throughFn) {
    pull(
      conn,
      lp.decode(),
      pull.filter((msg) => msg.length < c.maxMessageSize),
      pull.map((rawMsg) => {
        let msg
        try {
          msg = Message.deserialize(rawMsg)
        } catch (err) {
          this._log.error('failed to read incoming message', err)
          return
        }

        return msg
      }),
      pull.filter(Boolean),
      pull.asyncMap(async (msg, cb) => {
        try {
          cb(null, await throughFn(msg))
        } catch (err) {
          cb(err)
        }
      }),
      // Not all handlers will return a response
      pull.filter(Boolean),
      pull.map((response) => {
        let msg
        try {
          msg = response.serialize()
        } catch (err) {
          this._log.error('failed to send message', err)
          return
        }
        return msg
      }),
      pull.filter(Boolean),
      lp.encode(),
      conn
    )
  }
}

module.exports = ConnectionHelper
