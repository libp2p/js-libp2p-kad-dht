'use strict'

const pTimes = require('p-times')
const multihashing = require('multihashing-async')
const CID = require('cids')
const crypto = require('libp2p-crypto')

function createValues (n) {
  return pTimes(n, async () => {
    const bytes = crypto.randomBytes(32)
    const h = await multihashing(bytes, 'sha2-256')

    return {
      cid: new CID(h),
      value: bytes
    }
  })
}

module.exports = createValues
