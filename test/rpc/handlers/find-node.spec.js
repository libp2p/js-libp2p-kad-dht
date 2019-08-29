/* eslint-env mocha */
'use strict'

const chai = require('chai')
chai.use(require('dirty-chai'))
const expect = chai.expect
const waterfall = require('async/waterfall')

const Message = require('../../../src/message')
const handler = require('../../../src/rpc/handlers/find-node')

const T = Message.TYPES.FIND_NODE

const createPeerInfo = require('../../utils/create-peer-info')
const TestDHT = require('../../utils/test-dht')

describe('rpc - handlers - FindNode', () => {
  let peers
  let tdht
  let dht

  before(async () => {
    peers = await createPeerInfo(3)
  })

  beforeEach(async () => {
    tdht = new TestDHT()

    const dhts = await tdht.spawn(1)
    dht = dhts[0]
  })

  afterEach(() => {
    return tdht.teardown()
  })

  it('returns self, if asked for self', (done) => {
    const msg = new Message(T, dht.peerInfo.id.id, 0)

    handler(dht)(peers[1], msg, (err, response) => {
      expect(err).to.not.exist()
      expect(response.closerPeers).to.have.length(1)
      const peer = response.closerPeers[0]

      expect(peer.id.id).to.be.eql(dht.peerInfo.id.id)
      done()
    })
  })

  it('returns closer peers', (done) => {
    const msg = new Message(T, Buffer.from('hello'), 0)
    const other = peers[1]

    waterfall([
      (cb) => dht._add(other, cb),
      (cb) => handler(dht)(peers[2], msg, cb)
    ], (err, response) => {
      expect(err).to.not.exist()
      expect(response.closerPeers).to.have.length(1)
      const peer = response.closerPeers[0]

      expect(peer.id.id).to.be.eql(peers[1].id.id)
      expect(
        peer.multiaddrs.toArray()
      ).to.be.eql(
        peers[1].multiaddrs.toArray()
      )

      done()
    })
  })

  it('handles no peers found', (done) => {
    const msg = new Message(T, Buffer.from('hello'), 0)

    handler(dht)(peers[2], msg, (err, response) => {
      expect(err).to.not.exist()
      expect(response.closerPeers).to.have.length(0)
      done()
    })
  })
})
