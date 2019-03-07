'use strict'

/**
 * A set of unique peer infos.
 */
class PeerSet {
  constructor () {
    this.peers = new Map()
  }

  /**
   * Add a new info. Returns `true` if it was a new one
   *
   * @param {PeerInfo} info
   * @returns {bool}
   */
  add (info) {
    if (!info) {
      return false
    }
    if (!this.has(info)) {
      this.peers.set(info.id.toB58String(), info)
      return true
    }
    return false
  }

  /**
   * Check if this PeerInfo is already in here.
   *
   * @param {PeerInfo} info
   * @returns {bool}
   */
  has (info) {
    return this.peers.has(info && info.id.toB58String())
  }

  /**
   * Get the set as an array.
   *
   * @returns {Array<PeerInfo>}
   */
  toArray () {
    return [...this.peers.values()]
  }

  /**
   * The size of the set
   *
   * @type {number}
   */
  get size () {
    return this.peers.size
  }
}

module.exports = PeerSet
