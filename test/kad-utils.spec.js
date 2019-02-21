/* eslint-env mocha */
'use strict'

const chai = require('chai')
chai.use(require('dirty-chai'))
const expect = chai.expect
const base32 = require('base32.js')
const PeerId = require('peer-id')
const distance = require('xor-distance')

const utils = require('../src/utils')
const createPeerInfo = require('./utils/create-peer-info')

describe('kad utils', () => {
  describe('bufferToKey', () => {
    it('returns the base32 encoded key of the buffer', () => {
      const buf = Buffer.from('hello world')

      const key = utils.bufferToKey(buf)

      const enc = new base32.Encoder()
      expect(key.toString())
        .to.equal('/' + enc.write(buf).finalize())
    })
  })

  describe('convertBuffer', () => {
    it('returns the sha2-256 hash of the buffer', async () => {
      const buf = Buffer.from('hello world')

      const digest = await utils.convertBuffer(buf)

      expect(digest)
        .to.eql(Buffer.from('b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9', 'hex'))
    })
  })

  describe('sortClosestPeers', () => {
    it('sorts a list of PeerInfos', async () => {
      const rawIds = [
        '11140beec7b5ea3f0fdbc95d0dd47f3c5bc275da8a31',
        '11140beec7b5ea3f0fdbc95d0dd47f3c5bc275da8a32',
        '11140beec7b5ea3f0fdbc95d0dd47f3c5bc275da8a33',
        '11140beec7b5ea3f0fdbc95d0dd47f3c5bc275da8a34'
      ]

      const ids = rawIds.map((raw) => new PeerId(Buffer.from(raw)))

      const input = [
        ids[2],
        ids[1],
        ids[3],
        ids[0]
      ]

      const id = await utils.convertPeerId(ids[0])
      const out = await utils.sortClosestPeers(input, id)

      expect(
        out.map((m) => m.toB58String())
      ).to.eql([
        ids[0],
        ids[3],
        ids[2],
        ids[1]
      ].map((m) => m.toB58String()))
    })
  })

  describe('xorCompare', () => {
    it('sorts two distances', () => {
      const target = Buffer.from('11140beec7b5ea3f0fdbc95d0dd47f3c5bc275da8a90')
      const a = {
        distance: distance(Buffer.from('11140beec7b5ea3f0fdbc95d0dd47f3c5bc275da8a95'), target)
      }
      const b = {
        distance: distance(Buffer.from('11140beec7b5ea3f0fdbc95d0dd47f3c5bc275da8a96'), target)
      }

      expect(utils.xorCompare(a, b)).to.eql(-1)
      expect(utils.xorCompare(b, a)).to.eql(1)
      expect(utils.xorCompare(a, a)).to.eql(0)
    })
  })

  describe('keyForPublicKey', () => {
    it('works', async () => {
      const peers = await createPeerInfo(1)

      expect(utils.keyForPublicKey(peers[0].id))
        .to.eql(Buffer.concat([Buffer.from('/pk/'), peers[0].id.id]))
    })
  })

  describe('fromPublicKeyKey', () => {
    it('round trips', async function () {
      this.timeout(40 * 1000)

      const peers = await createPeerInfo(50)

      peers.forEach((p, i) => {
        const id = p.id
        expect(utils.isPublicKeyKey(utils.keyForPublicKey(id))).to.eql(true)
        expect(utils.fromPublicKeyKey(utils.keyForPublicKey(id)).id)
          .to.eql(id.id)
      })
    })
  })

  describe('promiseTimeout', () => {
    it('does not throw if promise resolves within timeout', async function () {
      await utils.promiseTimeout(new Promise((resolve) => {
        setTimeout(resolve(), 100)
      }), 200)
    })

    it('throws if promise does not resolve within timeout', async function () {
      try {
        await utils.promiseTimeout(new Promise((resolve) => {
          setTimeout(resolve(), 200)
        }), 100)
      } catch (err) {
        expect(err.message).to.eql('Promise timed out')
        expect(err.code).to.eql('ETIMEDOUT')
      }
    })

    it('throws with custom error message', async function () {
      try {
        await utils.promiseTimeout(new Promise((resolve) => {
          setTimeout(resolve(), 200)
        }), 100, 'hello')
      } catch (err) {
        expect(err.message).to.eql('hello')
        expect(err.code).to.eql('ETIMEDOUT')
      }
    })
  })

  describe('retry', () => {
    it('does not throw if function completes successfully before attempts', async function () {
      let waiting = true
      utils.retry({ times: 2, interval: 100 }, () => {
        if (waiting) throw new Error('fail')
      })
      setTimeout(() => {
        waiting = false
      }, 150)
    })

    it('throws if function does not complete successfully before attempts', async function () {
      const timeout = setTimeout(() => {
        expect.fail('did not throw')
      }, 400)

      try {
        await utils.retry({ times: 2, interval: 100 }, () => {
          throw new Error('fail')
        })
      } catch (err) {
        clearTimeout(timeout)
        expect(err.message).to.eql('fail')
      }
    })
  })
})
