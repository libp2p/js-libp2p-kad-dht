'use strict'

const debug = require('debug')
const { sha256 } = require('multiformats/hashes/sha2')
const { base58btc } = require('multiformats/bases/base58')
const { Key } = require('interface-datastore/key')
const { xor: uint8ArrayXor } = require('uint8arrays/xor')
const { compare: uint8ArrayCompare } = require('uint8arrays/compare')
const pMap = require('p-map')
const { Record } = require('libp2p-record')
const PeerId = require('peer-id')
const { fromString: uint8ArrayFromString } = require('uint8arrays/from-string')
const { toString: uint8ArrayToString } = require('uint8arrays/to-string')
const { concat: uint8ArrayConcat } = require('uint8arrays/concat')

/**
 * Creates a DHT ID by hashing a given Uint8Array.
 *
 * @param {Uint8Array} buf
 * @returns {Promise<Uint8Array>}
 */
exports.convertBuffer = async (buf) => {
  return (await sha256.digest(buf)).digest
}

/**
 * Creates a DHT ID by hashing a Peer ID
 *
 * @param {PeerId} peer
 * @returns {Promise<Uint8Array>}
 */
exports.convertPeerId = async (peer) => {
  return (await sha256.digest(peer.id)).digest
}

/**
 * Convert a Uint8Array to their SHA2-256 hash.
 *
 * @param {Uint8Array} buf
 * @returns {Key}
 */
exports.bufferToKey = (buf) => {
  return new Key('/' + exports.encodeBase32(buf), false)
}

/**
 * Generate the key for a public key.
 *
 * @param {PeerId} peer
 * @returns {Uint8Array}
 */
exports.keyForPublicKey = (peer) => {
  return uint8ArrayConcat([
    uint8ArrayFromString('/pk/'),
    peer.id
  ])
}

/**
 * @param {Uint8Array} key
 */
exports.isPublicKeyKey = (key) => {
  return uint8ArrayToString(key.slice(0, 4)) === '/pk/'
}

/**
 * @param {Uint8Array} key
 */
exports.fromPublicKeyKey = (key) => {
  return new PeerId(key.slice(4))
}

/**
 * Get the current time as timestamp.
 *
 * @returns {number}
 */
exports.now = () => {
  return Date.now()
}

/**
 * Encode a given Uint8Array into a base32 string.
 *
 * @param {Uint8Array} buf
 * @returns {string}
 */
exports.encodeBase32 = (buf) => {
  return uint8ArrayToString(buf, 'base32')
}

/**
 * Decode a given base32 string into a Uint8Array.
 *
 * @param {string} raw
 * @returns {Uint8Array}
 */
exports.decodeBase32 = (raw) => {
  return uint8ArrayFromString(raw, 'base32')
}

/**
 * Sort peers by distance to the given `target`.
 *
 * @param {Array<PeerId>} peers
 * @param {Uint8Array} target
 */
exports.sortClosestPeers = async (peers, target) => {
  const distances = await pMap(peers, async (peer) => {
    const id = await exports.convertPeerId(peer)

    return {
      peer: peer,
      distance: uint8ArrayXor(id, target)
    }
  })

  return distances.sort(exports.xorCompare).map((d) => d.peer)
}

/**
 * Compare function to sort an array of elements which have a distance property which is the xor distance to a given element.
 *
 * @param {{ distance: Uint8Array }} a
 * @param {{ distance: Uint8Array }} b
 */
exports.xorCompare = (a, b) => {
  return uint8ArrayCompare(a.distance, b.distance)
}

/**
 * Computes how many results to collect on each disjoint path, rounding up.
 * This ensures that we look for at least one result per path.
 *
 * @param {number} resultsWanted
 * @param {number} numPaths - total number of paths
 */
exports.pathSize = (resultsWanted, numPaths) => {
  return Math.ceil(resultsWanted / numPaths)
}

/**
 * Create a new put record, encodes and signs it if enabled.
 *
 * @param {Uint8Array} key
 * @param {Uint8Array} value
 * @returns {Uint8Array}
 */
exports.createPutRecord = (key, value) => {
  const timeReceived = new Date()
  const rec = new Record(key, value, timeReceived)

  return rec.serialize()
}

/**
 * Creates a logger for the given subsystem
 *
 * @param {string} name
 */
exports.logger = (name) => {
  // Add a formatter for converting to a base58 string
  debug.formatters.b = (v) => {
    return base58btc.baseEncode(v)
  }

  const logger = Object.assign(debug(name), {
    error: debug(`${name}:error`)
  })

  return logger
}
