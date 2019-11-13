'use strict'

const { sortClosestPeers } = require('../../src/utils')

/**
 * Like `sortClosestPeers`, expect it takes and returns `PeerInfo`s
 *
 * @param {Array<PeerInfo>} peers
 * @param {Buffer} target
 * @returns {Array<PeerInfo>}
 */
exports.sortClosestPeerInfos = async (peers, target) => {
  const sortedPeerIds = await sortClosestPeers(peers.map(peerInfo => peerInfo.id), target)

  return sortedPeerIds.map((peerId) => {
    return peers.find((peerInfo) => {
      return peerInfo.id.isEqual(peerId)
    })
  })
}
