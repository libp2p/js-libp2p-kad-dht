'use strict'

const { CID } = require('multiformats/cid')
const { sha256 } = require('multiformats/hashes/sha2')
const randomBytes = require('iso-random-stream/src/random')

function createValues (length) {
  return Promise.all(
    Array.from({ length }).map(async () => {
      const bytes = randomBytes(32)
      const h = await sha256.digest(bytes)
      return {
        cid: CID.createV0(h),
        value: bytes
      }
    })
  )
}

module.exports = createValues
