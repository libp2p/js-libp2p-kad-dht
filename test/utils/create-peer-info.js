'use strict'

const pTimes = require('p-times')

const PeerId = require('peer-id')
const PeerInfo = require('peer-info')

/**
 * Creates multiple PeerInfos
 * @param {number} n The number of `PeerInfo` to create
 * @return {Array<PeerInfo>}
 */
async function createPeerInfo (n) {
  const ids = await pTimes(n, () => PeerId.create({ bits: 512 }))

  return ids.map((i) => new PeerInfo(i))
}

module.exports = createPeerInfo
