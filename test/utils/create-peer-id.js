'use strict'

const PeerId = require('peer-id')

/**
 * Creates multiple PeerIds
 *
 * @param {number} length - The number of `PeerId` to create
 * @returns {Promise<Array<PeerId>>}
 */
function createPeerId (length) {
  return Promise.all(
    Array.from({ length }).map(async () => {
      const id = await PeerId.create({ keyType: 'ed25519' })
      return id
    })
  )
}

module.exports = createPeerId
