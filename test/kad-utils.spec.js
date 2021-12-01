/* eslint-env mocha */
'use strict'

const { expect } = require('aegir/utils/chai')
const { fromString: uint8ArrayFromString } = require('uint8arrays/from-string')
const { toString: uint8ArrayToString } = require('uint8arrays/to-string')
const keyForPublicKey = require('./utils/key-for-public-key')

const utils = require('../src/utils')
const createPeerId = require('./utils/create-peer-id')

describe('kad utils', () => {
  describe('bufferToKey', () => {
    it('returns the base32 encoded key of the buffer', () => {
      const buf = uint8ArrayFromString('hello world')

      const key = utils.bufferToKey(buf)

      expect(key.toString())
        .to.equal('/' + uint8ArrayToString(buf, 'base32'))
    })
  })

  describe('convertBuffer', () => {
    it('returns the sha2-256 hash of the buffer', async () => {
      const buf = uint8ArrayFromString('hello world')
      const digest = await utils.convertBuffer(buf)

      expect(digest)
        .to.equalBytes(uint8ArrayFromString('b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9', 'base16'))
    })
  })

  describe('fromPublicKeyKey', () => {
    it('round trips', async function () {
      this.timeout(40 * 1000)

      const peers = await createPeerId(50)
      peers.forEach((id, i) => {
        expect(utils.isPublicKeyKey(keyForPublicKey(id))).to.eql(true)
        expect(utils.fromPublicKeyKey(keyForPublicKey(id)).id)
          .to.eql(id.id)
      })
    })
  })
})
