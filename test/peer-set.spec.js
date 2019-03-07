/* eslint-env mocha */
'use strict'

const chai = require('chai')
chai.use(require('dirty-chai'))
const expect = chai.expect

const PeerSet = require('../src/peer-set')

const createPeerInfo = require('./utils/create-peer-info')

describe('PeerSet', () => {
  let peers

  before(async () => {
    peers = await createPeerInfo(3)
  })

  it('basics', () => {
    const l = new PeerSet()

    expect(l.add(peers[0])).to.eql(true)
    expect(l.add(peers[0])).to.eql(false)
    expect(l.size).to.eql(1)
    expect(l.add(peers[1])).to.eql(true)
    expect(l.size).to.eql(2)
    expect(l.toArray()).to.eql([peers[0], peers[1]])
  })
})
