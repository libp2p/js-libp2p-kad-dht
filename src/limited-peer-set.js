'use strict'

const PeerSet = require('./peer-set')

/**
 * Like PeerSet but with a size restriction.
 */
class LimitedPeerSet extends PeerSet {
  /**
   * Create a new limited peer set.
   *
   * @param {number} limit
   */
  constructor (limit) {
    super()
    this.limit = limit
  }

  /**
   * Add a PeerInfo if it fits in the set
   *
   * @param {PeerInfo} info
   * @returns {bool}
   */
  add (info) {
    if (this.size < this.limit) {
      return super.add(info)
    }
    return false
  }
}

module.exports = LimitedPeerSet
