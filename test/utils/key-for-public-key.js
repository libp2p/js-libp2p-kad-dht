'use strict'

const { concat: uint8ArrayConcat } = require('uint8arrays/concat')
const { fromString: uint8ArrayFromString } = require('uint8arrays/from-string')

// const IPNS_PREFIX = uint8ArrayFromString('/ipns/')
const PK_PREFIX = uint8ArrayFromString('/pk/')

/**
 * Generate the key for a public key.
 *
 * @param {PeerId} peer
 * @returns {Uint8Array}
 */
const keyForPublicKey = (peer) => {
  return uint8ArrayConcat([
    PK_PREFIX,
    peer.id
  ])
}

module.exports = keyForPublicKey
