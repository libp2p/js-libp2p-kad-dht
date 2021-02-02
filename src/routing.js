'use strict'

// @ts-ignore
const KBucket = require('k-bucket')

const utils = require('./utils')
const log = utils.logger(undefined, 'rt')

/**
 * @typedef {import('peer-id')} PeerId
 *
 * @typedef {object} KBucketPeer
 * @property {Uint8Array} id
 * @property {PeerId} peerId
 * @property {number} lastUsefulAt
 * @property {number} lastSuccessfulOutboundQueryAt
 * @property {number} addedAt
 * @property {boolean} replaceable
 */

/**
 * A wrapper around `k-bucket`, to provide easy store and
 * retrieval for peers.
 */
class RoutingTable {
  /**
   * @param {PeerId} self
   * @param {number} kBucketSize
   */
  constructor (self, kBucketSize) {
    this.self = self
    this._onPing = this._onPing.bind(this)

    // this.maxLatency = ?

    this._onInit(kBucketSize)
  }

  /**
   * @param {number} kBucketSize
   */
  async _onInit (kBucketSize) {
    const selfKey = await utils.convertPeerId(this.self)

    this.kb = new KBucket({
      localNodeId: selfKey,
      numberOfNodesPerKBucket: kBucketSize,
      numberOfNodesToPing: 1
    })

    this.kb.on('ping', this._onPing)
    this.kb.on('removed', /** @param {KBucketPeer} c */(c) => log('peer removed %j', c))
    this.kb.on('added', /** @param {KBucketPeer} c */(c) => log('peer added (%s total peers): %j', this.kb.count(), c))
    this.kb.on('updated', this._onUpdated)
  }

  /**
   * Called on the `ping` event from `k-bucket`.
   * Currently this just removes the oldest contact from
   * the list, without actually pinging the individual peers.
   * This is the same as go does, but should probably
   * be upgraded to actually ping the individual peers.
   *
   * @param {KBucketPeer[]} oldContacts
   * @param {KBucketPeer} newContact
   */
  _onPing (oldContacts, newContact) {
    // Check the old contacts for a replaceable peer
    // If we have none, we cant add the new contact
    for (const contact of oldContacts) {
      if (contact.replaceable) {
        log('replaceable peer found, evicting', contact)
        this.kb.remove(contact.id)
        this.kb.add(newContact)
        return
      }
    }
  }

  /**
   *
   * @param {KBucketPeer} oldContact
   * @param {KBucketPeer} newContact
   */
  _onUpdated (oldContact, newContact) {
    log('peer updated', newContact)
  }

  // -- Public Interface

  /**
   * Amount of currently stored peers.
   */
  get size () {
    return this.kb.count()
  }

  /**
   * Find a specific peer by id.
   *
   * @param {PeerId} peer
   * @returns {Promise<PeerId | undefined>}
   */
  async find (peer) {
    const key = await utils.convertPeerId(peer)
    const closest = this.closestPeer(key)

    if (closest && peer.equals(closest)) {
      return closest
    }
  }

  /**
   * Retrieve the closest peers to the given key.
   *
   * @param {Uint8Array} key
   */
  closestPeer (key) {
    const res = this.closestPeers(key, 1)
    if (res.length > 0) {
      return res[0]
    }
  }

  /**
   * Retrieve the `count`-closest peers to the given key.
   *
   * @param {Uint8Array} key
   * @param {number} count
   */
  closestPeers (key, count) {
    /** @type {KBucketPeer[]} */
    const closest = this.kb.closest(key, count)

    return closest.map(p => p.peerId)
  }

  /**
   * Add or update the routing table with the given peer.
   *
   * @param {PeerId} peer
   * @param {boolean} queryPeer We queried it, or it queried us
   * @param {boolean} isReplaceable Should be set to true if bootstrapping
   * @returns {Promise<void>}
   */
  async add (peer, queryPeer = false, isReplaceable = false) {
    const dhtId = await utils.convertPeerId(peer)
    const now = Date.now()
    let lastUsefulAt

    // A query happened, mark it useful
    if (queryPeer) {
      lastUsefulAt = now
    }

    const existingPeer = this.kb.get(dhtId)
    if (existingPeer) {
      // On first query of an existing peer, bump its usefulness
      if (queryPeer && !existingPeer.lastUsefulAt) {
        existingPeer.LastUsefulAt = lastUsefulAt
        existingPeer.replaceable = isReplaceable
        this.kb.add(existingPeer)
      }
      // We're done, return
      return
    }

    // TODO: Check peer latency, if greater than RT maxLatency DONT add it

    // TODO: Run the diversity filter check

    // We can attempt to add now, k-bucket will give us onPing if the bucket is full
    this.kb.add({
      id: dhtId,
      peerId: peer,
      lastUsefulAt,
      lastSuccessfulOutboundQueryAt: now, // For new peers, this can be inbound
      addedAt: now,
      replaceable: isReplaceable
    })
  }

  /**
   * Updates the updateLastSuccessfulOutboundQueryAt time for the
   * given peer. If the peer is not in the routing table we'll attempt
   * to add it.
   *
   * @param {PeerId} peer
   * @returns {Promise<void>}
   */
  async updateLastSuccessfulOutboundQueryAt (peer) {
    const id = await utils.convertPeerId(peer)
    const contact = this.kb.get(id)

    // New peer
    if (!contact) {
      return this.add(peer, true, false)
    }

    contact.isReplaceable = false // TODO: this
    contact.lastSuccessfulOutboundQueryAt = Date.now() // TODO: verify this updates
  }

  /**
   * Remove a given peer from the table.
   *
   * @param {PeerId} peer
   */
  async remove (peer) {
    const id = await utils.convertPeerId(peer)

    this.kb.remove(id)
  }
}

module.exports = RoutingTable
