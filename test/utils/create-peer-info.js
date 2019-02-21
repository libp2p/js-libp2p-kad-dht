'use strict'

const PeerId = require('peer-id')
const PeerInfo = require('peer-info')

// Creates multiple PeerInfos
function createPeerInfo (n) {
  return Promise.all([...new Array(n)].map(async () => {
    const id = await PeerId.create({ bits: 512 })
    return new PeerInfo(id)
  }))
}

module.exports = createPeerInfo
