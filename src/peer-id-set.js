'use strict'

/**
 * A set of unique peer ids.
 */
class PeerIdSet {
  constructor () {
    this.peers = new Map()
  }

  /**
   * Add a new id. Returns `true` if it was a new one
   *
   * @param {PeerId} id
   * @returns {bool}
   */
  add (id) {
    if (!id) {
      return false
    }
    if (!this.has(id)) {
      this.peers.set(id.toB58String(), id)
      return true
    }
    return false
  }

  /**
   * Check if this PeerId is already in here.
   *
   * @param {PeerId} id
   * @returns {bool}
   */
  has (id) {
    return this.peers.has(id && id.toB58String())
  }

  /**
   * Get the set as an array.
   *
   * @returns {Array<PeerId>}
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

module.exports = PeerIdSet
